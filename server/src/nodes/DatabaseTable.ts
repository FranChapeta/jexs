import { Knex as KnexType } from "knex";
import { Node, Context, NodeValue, boundaryContext, isObject, loggerFor, resolveAll, resolveFields, runSteps, type Logger } from "@jexs/core";
import { DatabaseNode } from "./Database.js";
import { sha256 } from "./Crypto.js";
import { SchemaNode, isTableDocument, requireSchemaNode, schemaArg, tableId } from "./Schema.js";
import type { JexsNodeSchema, JexsPropertySchema } from "@jexs/core";

/** The functions a column's `computed` may name, each deriving the column from another on insert. */
export const COMPUTE_FNS: Record<string, (value: string) => string> = { sha256 };

const JSON_TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"];
const SQL_TYPES = [
  "integer", "biginteger", "bigint", "smallint", "tinyint", "float", "double", "decimal",
  "varchar", "text", "mediumtext", "longtext", "boolean",
  "date", "datetime", "timestamp", "time", "json", "jsonb", "binary", "uuid",
];
const REFERENTIAL = ["CASCADE", "SET NULL", "RESTRICT", "NO ACTION"];
const strings = { type: "array", items: { type: "string" } };

/**
 * A column: a JSON Schema property (`type`, `maxLength`, `enum`, `pattern`,
 * `format`, `default`, ...) that validates the column's values, beside the SQL
 * settings that build it. Ajv ignores the SQL keys. `default` is JSON Schema's;
 * the column's SQL default is `sqlDefault`.
 */
export interface ColumnSchema {
  type?: string | string[];
  maxLength?: number;
  enum?: unknown[];
  pattern?: string;
  format?: string;
  default?: unknown;
  /** SQL column type (e.g. `varchar`, `biginteger`, `timestamp`). Mapped from
   *  the JSON Schema `type` when omitted. */
  sqlType?: string;
  precision?: number;
  scale?: number;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  unique?: boolean;
  unsigned?: boolean;
  /** The column's SQL default. `CURRENT_TIMESTAMP` is passed through as SQL. */
  sqlDefault?: string | number | boolean | null;
  comment?: string;
  /** Derive this column from another on insert, e.g. `{ "sha256": "password" }`. */
  computed?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Index definition in schema
 */
export interface IndexDef {
  type?: "index" | "unique";
  columns: string | string[];
}

/**
 * Foreign key definition in schema
 */
export interface ForeignKeyDef {
  column: string;
  references: {
    table: string;
    column: string;
  };
  onDelete?: "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION";
  onUpdate?: "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION";
}

/**
 * A table document: JSON Schema (draft 2020-12) for its rows, whose
 * `properties` are the columns, beside the settings that build and guard the
 * table. Ajv ignores those keys, so the document validates rows as it is. An
 * app's own settings can ride along under `x-` keys.
 */
export interface TableJsonSchema {
  type?: "object";
  required?: string[];
  properties: Record<string, ColumnSchema>;
  /** The table's name. */
  table: string;
  indexes?: Record<string, IndexDef>;
  /** A composite primary key; a single-column one is set on its column. */
  primaryKey?: string[];
  foreignKeys?: Record<string, ForeignKeyDef>;
  /** MySQL table options. */
  options?: {
    engine?: string;
    charset?: string;
    collate?: string;
  };
  /** Steps run before each query on this table, after the connection's `rows`
   *  (see DatabaseQuery's `runValidators`). */
  validator?: unknown;
  [key: string]: unknown;
}

const tableNames = { type: "array", items: { type: "string" } } as const;
const names = (description: string) => ({ type: "array", items: { type: "string" }, description }) as const;

/** What `alter` can change, in the order it applies them. */
const ALTERATIONS = ["dropIndexes", "add", "rename", "change", "drop", "addIndexes"] as const;

export class DatabaseTableNode extends Node {
  /** `tableSchema` is a table document: JSON Schema for its rows, beside the
   *  settings that build and guard the table. It is a root document kind, so a
   *  file whose root has `properties` and `table` is checked as one. */
  static schemaDefs: Record<string, Record<string, unknown>> = {
    tableSchema: {
      type: "object",
      required: ["properties", "table"],
      properties: {
        type:       { const: "object" },
        required:   { ...strings, description: "Columns every row must have." },
        properties: { $ref: "#/$defs/_tableColumns", description: "The columns, by name." },
        table:      { type: "string", description: "The table's name." },
        primaryKey: { ...strings, description: "A composite primary key. A single-column key is set on its column instead." },
        indexes:    { $ref: "#/$defs/_tableIndexes", description: "Indexes, by name." },
        foreignKeys: {
          type: "object",
          description: "Foreign keys, by name.",
          additionalProperties: {
            type: "object",
            required: ["column", "references"],
            additionalProperties: false,
            properties: {
              column: { type: "string" },
              references: {
                type: "object",
                required: ["table", "column"],
                additionalProperties: false,
                properties: { table: { type: "string" }, column: { type: "string" } },
              },
              onDelete: { enum: REFERENTIAL },
              onUpdate: { enum: REFERENTIAL },
            },
          },
        },
        options: {
          type: "object",
          additionalProperties: false,
          description: "MySQL table options; other databases ignore them.",
          properties: { engine: { type: "string" }, charset: { type: "string" }, collate: { type: "string" } },
        },
        validator: { $ref: "#/$defs/steps", description: "Steps run before each query on this table, after the connection's `rows` validator, with `operation`, `schema` and `query`." },
      },
    },
    _tableColumns: { type: "object", additionalProperties: { $ref: "#/$defs/_tableColumn" } },
    _tableIndexes: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["columns"],
        additionalProperties: false,
        properties: {
          type:    { enum: ["index", "unique"], default: "index" },
          columns: { anyOf: [{ type: "string" }, strings] },
        },
      },
    },
    _tableColumn: {
      type: "object",
      description: "A column: JSON Schema for its values, beside the SQL settings that build it.",
      properties: {
        type:          { anyOf: [{ enum: JSON_TYPES }, { type: "array", items: { enum: JSON_TYPES } }] },
        default:       { description: "JSON Schema's default, the value a row is given. The column's SQL default is `sqlDefault`." },
        sqlType:       { enum: SQL_TYPES, description: "The SQL type; without it, mapped from the JSON Schema `type`." },
        sqlDefault:    { type: ["string", "number", "boolean", "null"], description: "The column's SQL default. `CURRENT_TIMESTAMP` is passed through as SQL." },
        maxLength:     { type: "integer", description: "JSON Schema's longest string, checked on every write, and the length of a `varchar` column (default 255)." },
        precision:     { type: "integer" },
        scale:         { type: "integer" },
        primaryKey:    { type: "boolean" },
        autoIncrement: { type: "boolean" },
        unique:        { type: "boolean" },
        unsigned:      { type: "boolean" },
        comment:       { type: "string" },
        computed: {
          type: "object",
          propertyNames: { enum: Object.keys(COMPUTE_FNS) },
          additionalProperties: { type: "string" },
          description: "Fill this column on insert from another, by function: `{ \"sha256\": \"password\" }`.",
        },
      },
    },
    /** `$tableCreate`'s and `$tableSync`'s value: a table document, or a table's
     *  name (`"*"` for every registered one), or a step producing either. */
    _tableSchemaSlot: {
      if: { type: "object", anyOf: [{ required: ["properties"] }, { required: ["table"] }] },
      then: { $ref: "#/$defs/tableSchema" },
      else: { $ref: "#/$defs/strOrExpr" },
    },
  };

  static commonSiblings: Record<string, JexsPropertySchema> = {
    connection: { type: "string", description: "Named database connection (default if omitted)." },
    system: { type: "boolean", description: "Skip the connection's `structure` validator: for the app's own changes, such as building its tables at startup." },
  };

  static schema: JexsNodeSchema = {
    tableCreate: {
      $ref: "#/$defs/_tableSchemaSlot",
      literal: true,
      output: "string",
      outputDescription: "The table's name.",
      markdownDescription: "Creates a table from a table document: JSON Schema for its rows, whose `properties` are the columns, beside the settings that build the table. The document is registered with `$schema` as `table/<name>` first, and once registered, every `$queryInsert`, `$queryUpsert` and `$queryUpdate` on the table is checked against it. The value is the document, kept as written so its `validator` stays steps (load a file with `$file` and `data: true`), or the name of a registered one. A table that already exists is an error; `$tableSync` brings an existing one up to date instead.",
      examples: [
        "{ \"$tableCreate\": { \"$file\": \"db/users.json\", \"data\": true } }",
      ],
    },
    tableSync: {
      $ref: "#/$defs/_tableSchemaSlot",
      literal: true,
      output: tableNames,
      outputDescription: "The names of the tables it created.",
      markdownDescription: "Makes the database match table documents, adding only: it creates the tables that are missing, and adds the columns and named indexes an existing table lacks. A required column added to a table with rows is nullable until `$tableAlter` makes it NOT NULL. It never changes, renames or drops what is there, since that could lose data; it warns about columns the document lacks, for `$tableAlter` to deal with. The value is a table document, registered first as `$tableCreate` does; a registered table's name; or `\"*\"` for every registered table.",
      examples: [
        "{ \"$tableSync\": \"*\" }",
        "{ \"$tableSync\": { \"$file\": \"db/users.json\", \"data\": true } }",
      ],
    },
    tableAlter: {
      type: "string",
      output: "null",
      markdownDescription: "Changes the structure of the table the value names, applying in this order: `dropIndexes`, `add`, `rename`, `change`, `drop`, `addIndexes`. Each is done as given, so adding a column that exists or dropping one that does not is an error. To make a column NOT NULL once its rows have a value, `change` it with its name in `required`. A failure partway leaves the earlier changes made; on PostgreSQL and SQLite, wrap the step in `$database: \"transaction\"` to apply all or none. The table's registered document stays as it is, for `$schema: \"register\"` to replace.",
      examples: [
        "{ \"$tableAlter\": \"users\", \"add\": { \"email\": { \"type\": \"string\" } } }",
        "{ \"$tableAlter\": \"users\", \"change\": { \"email\": { \"type\": \"string\" } }, \"required\": [\"email\"] }",
        "{ \"$tableAlter\": \"users\", \"rename\": { \"mail\": \"email\" }, \"drop\": [\"legacy_id\"] }",
      ],
      siblings: {
        add: { $ref: "#/$defs/_tableColumns", description: "Columns to add, by name, each described as in a table document (`type`, `sqlType`, `sqlDefault`, ...)." },
        rename: { map: true, description: "Columns to rename: `{ \"old\": \"new\" }`." },
        change: { $ref: "#/$defs/_tableColumns", description: "Columns to change, by name (after `rename`), each described in full as in a table document: what the description leaves out, such as a default, the column loses." },
        drop: names("Columns to drop."),
        required: names("Which columns of `add` and `change` are NOT NULL."),
        addIndexes: { $ref: "#/$defs/_tableIndexes", description: "Indexes to add, by name, as in a table document's `indexes`." },
        dropIndexes: names("Indexes to drop, by name."),
      },
    },
    tableRename: {
      type: "string",
      output: "string",
      outputDescription: "The table's new name.",
      markdownDescription: "Renames the table the value names. Its registered document stays as it is, under the old name.",
      examples: ["{ \"$tableRename\": \"users\", \"to\": \"accounts\" }"],
      siblings: {
        to: { type: "string", required: true, description: "The table's new name." },
      },
    },
    tableDrop: {
      type: "string",
      output: "null",
      markdownDescription: "Drops the table the value names, if it exists. Its registered document, if any, stays registered; `$schema: \"unregister\"` forgets it.",
      examples: ["{ \"$tableDrop\": \"old_logs\" }"],
    },
  };

  async tableCreate(def: Record<string, unknown>, context: Context): Promise<string> {
    const [connection, system] = await resolveAll([def.connection ?? null, def.system ?? null], context, values => values);
    const [schema] = await documentsOf(def.$tableCreate, { connection, system }, context, "create");
    const knex = DatabaseNode.getKnex(context, connection);
    if (await knex.schema.hasTable(schema.table)) {
      throw new Error(`$tableCreate: table "${schema.table}" already exists; \`$tableSync\` adds what it lacks`);
    }
    await createTable(knex, schema);
    loggerFor(context).info(`[DatabaseTable] Created table: ${schema.table}`);
    return schema.table;
  }

  // A failure throws, so a startup that cannot build its tables stops there.
  async tableSync(def: Record<string, unknown>, context: Context): Promise<string[]> {
    const [connection, system] = await resolveAll([def.connection ?? null, def.system ?? null], context, values => values);
    const schemas = await documentsOf(def.$tableSync, { connection, system }, context, "sync");
    const knex = DatabaseNode.getKnex(context, connection);
    const created: string[] = [];
    for (const schema of schemas) {
      if (await knex.schema.hasTable(schema.table)) {
        await syncTable(knex, schema, loggerFor(context));
        continue;
      }
      await createTable(knex, schema);
      loggerFor(context).info(`[DatabaseTable] Created table: ${schema.table}`);
      created.push(schema.table);
    }
    return created;
  }

  // Each change applies in `ALTERATIONS` order, one statement group at a time,
  // so a later change sees the columns an earlier one added or renamed.
  tableAlter(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveFields(def, context, async r => {
      const tableName = String(r.$tableAlter);
      const changes = Object.fromEntries(ALTERATIONS.filter(k => r[k] != null).map(k => [k, r[k]]));
      if (Object.keys(changes).length === 0) {
        throw new Error(`$tableAlter needs a change: ${ALTERATIONS.map(k => `\`${k}\``).join(", ")}`);
      }
      for (const key of ["add", "rename", "change", "addIndexes"] as const) {
        if (r[key] != null && !isObject(r[key])) throw new Error(`$tableAlter: \`${key}\` must be an object, by name`);
      }
      for (const key of ["drop", "dropIndexes", "required"] as const) {
        if (r[key] != null && !Array.isArray(r[key])) throw new Error(`$tableAlter: \`${key}\` must be an array of names`);
      }
      await authorize(context, r, "alter", tableName, { changes });

      const required = new Set((r.required as string[] | undefined) ?? []);
      const { add, rename, change, drop, addIndexes, dropIndexes } = changes as {
        add?: Record<string, ColumnSchema>; rename?: Record<string, unknown>; change?: Record<string, ColumnSchema>;
        drop?: string[]; addIndexes?: Record<string, IndexDef>; dropIndexes?: string[];
      };
      const knex = DatabaseNode.getKnex(context, r.connection);
      checkColumns(tableName, Object.keys(await knex(tableName).columnInfo()), add, rename, change, drop);
      const alter = (build: (table: KnexType.CreateTableBuilder) => void) => knex.schema.alterTable(tableName, build);
      if (dropIndexes) await alter(table => { for (const index of dropIndexes) table.dropIndex([], index); });
      if (add) await alter(table => { buildColumns(table, add, required, knex); });
      if (rename) await alter(table => { for (const [from, to] of Object.entries(rename)) table.renameColumn(from, String(to)); });
      if (change) await alter(table => { for (const column of buildColumns(table, change, required, knex)) column.alter(); });
      if (drop) await alter(table => { table.dropColumns(...drop); });
      if (addIndexes) await alter(table => { buildIndexes(table, addIndexes); });

      loggerFor(context).info(`[DatabaseTable] Altered table ${tableName}: ${Object.keys(changes).join(", ")}`);
      return null;
    });
  }

  tableRename(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$tableRename, def.to, def.connection ?? null, def.system ?? null], context, async ([table, to, connection, system]) => {
      await authorize(context, { connection, system }, "rename", String(table), { changes: { to } });
      await DatabaseNode.getKnex(context, connection).schema.renameTable(String(table), String(to));
      loggerFor(context).info(`[DatabaseTable] Renamed table ${String(table)} to ${String(to)}`);
      return String(to);
    });
  }

  tableDrop(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$tableDrop, def.connection ?? null, def.system ?? null], context, async ([table, connection, system]) => {
      await authorize(context, { connection, system }, "drop", String(table));
      await DatabaseNode.getKnex(context, connection).schema.dropTableIfExists(String(table));
      loggerFor(context).info(`[DatabaseTable] Dropped table: ${String(table)}`);
      return null;
    });
  }

  /** The document registered for table `tableName`, as written. A static
   *  rather than a method, since every method on a Node registers as an op. */
  static get(context: Context, tableName: string): TableJsonSchema | undefined {
    const doc = requireSchemaNode(context).documents.get(tableId(tableName));
    return isTableDocument(doc) ? doc as TableJsonSchema : undefined;
  }
}

/** A table step's resolved `connection` and `system`. */
interface Settings {
  connection?: unknown;
  system?: unknown;
}

/**
 * Run the connection's `structure` validator, if it is set and the step is not
 * `system`, before a change to `table`. It sees the table's document as `schema`
 * (a copy, so the registered one stays as registered) unless `extra` gives the
 * one being applied, and refuses by throwing.
 */
async function authorize(
  context: Context, step: Settings, operation: string, table: string,
  extra: { schema?: TableJsonSchema; changes?: Record<string, unknown> } = {},
): Promise<void> {
  if (step.system === true) return;
  const steps = DatabaseNode.validators(context, step.connection).structure;
  if (steps == null) return;
  const schema = extra.schema ?? DatabaseTableNode.get(context, table);
  // A boundary, not a child scope: a validator reads the caller's variables,
  // refuses, and never writes the caller's variables.
  await runSteps(steps, boundaryContext(context, {
    operation, table, schema: schema && structuredClone(schema), changes: extra.changes,
  }));
}

/**
 * The table documents a `$tableCreate` or `$tableSync` names in its value, each
 * authorized by the connection's `structure` validator: a document, which is
 * registered once authorized; a registered table's name; or, for `sync` only,
 * `"*"` for every registered table.
 */
async function documentsOf(value: unknown, step: Settings, context: Context, operation: "create" | "sync"): Promise<TableJsonSchema[]> {
  const op = operation === "create" ? "$tableCreate" : "$tableSync";
  const schema = await schemaArg(value, context);
  const schemas = requireSchemaNode(context);
  if (isObject(schema)) {
    if (!isTableDocument(schema)) throw new Error("A table document needs a `table` name and `properties`.");
    await authorize(context, step, operation, schema.table, { schema: schema as TableJsonSchema });
    SchemaNode.register(schemas, schema);
    return [DatabaseTableNode.get(context, schema.table)!];
  }
  let documents: TableJsonSchema[];
  if (schema === "*" && operation === "sync") {
    documents = SchemaNode.all(schemas, tableId("")).filter(isTableDocument) as TableJsonSchema[];
  } else if (typeof schema === "string") {
    const found = DatabaseTableNode.get(context, schema);
    if (!found) throw new Error(`${op}: no document registered for table "${schema}"`);
    documents = [found];
  } else {
    throw new Error(`${op} takes a table document or a registered table's name${operation === "sync" ? ", or \"*\" for every registered one" : ""}`);
  }
  for (const doc of documents) await authorize(context, step, operation, doc.table);
  return documents;
}

/** Create the table a document declares. */
async function createTable(knex: KnexType, schema: TableJsonSchema): Promise<void> {
  const required = new Set(schema.required ?? []);
  await knex.schema.createTable(schema.table, (table) => {
    buildColumns(table, schema.properties, required, knex);
    if (schema.primaryKey) table.primary(schema.primaryKey);
    // MySQL table options; Knex refuses them on any other database.
    if (schema.options && knex.client.dialect === "mysql") {
      if (schema.options.engine) table.engine(schema.options.engine);
      if (schema.options.charset) table.charset(schema.options.charset);
      if (schema.options.collate) table.collate(schema.options.collate);
    }
    if (schema.indexes) buildIndexes(table, schema.indexes);
    if (schema.foreignKeys) buildForeignKeys(table, schema.foreignKeys);
  });
}

/**
 * Add the columns and named indexes an existing table lacks, and warn about
 * what differs that only `alter` may change: a required column added as
 * nullable, since the rows already there have no value for it, and columns the
 * document does not have. Changing or dropping a column could lose data, and a
 * renamed column looks the same as one dropped and one added, so `sync` leaves
 * those to an `alter` the app writes.
 */
async function syncTable(knex: KnexType, schema: TableJsonSchema, log: Logger): Promise<void> {
  const tableName = schema.table;
  const existing = Object.keys(await knex(tableName).columnInfo());
  const missing = Object.keys(schema.properties).filter(name => !existing.includes(name));
  if (missing.length > 0) {
    // SQLite refuses a non-constant default such as CURRENT_TIMESTAMP when
    // adding a column, so it is left out.
    const columns = Object.fromEntries(missing.map(name => {
      const col: ColumnSchema = { ...schema.properties[name] };
      if (typeof col.sqlDefault === "string" && /current_timestamp/i.test(col.sqlDefault)) delete col.sqlDefault;
      return [name, col];
    }));
    await knex.schema.alterTable(tableName, table => { buildColumns(table, columns, new Set(), knex); });
    log.info(`[DatabaseTable] Table ${tableName}: added columns [${missing.join(", ")}]`);
    const nullable = missing.filter(name => schema.required?.includes(name));
    if (nullable.length > 0) {
      log.warn(`[DatabaseTable] Table ${tableName}: added required columns [${nullable.join(", ")}] as nullable; once every row has a value, \`alter\` can \`change\` them with \`required\``);
    }
  }
  const extra = existing.filter(name => !(name in schema.properties));
  if (extra.length > 0) {
    log.warn(`[DatabaseTable] Table ${tableName}: columns [${extra.join(", ")}] are not in its document; \`alter\` can \`rename\` or \`drop\` them`);
  }

  const indexes = new Set(await indexNames(knex, tableName));
  const newIndexes = Object.entries(schema.indexes ?? {}).filter(([name]) => !indexes.has(name));
  if (newIndexes.length > 0) {
    await knex.schema.alterTable(tableName, table => { buildIndexes(table, Object.fromEntries(newIndexes)); });
    log.info(`[DatabaseTable] Table ${tableName}: added indexes [${newIndexes.map(([name]) => name).join(", ")}]`);
  }
}

/** The names of a table's indexes. */
async function indexNames(knex: KnexType, tableName: string): Promise<string[]> {
  const dialect = knex.client.dialect;
  if (dialect === "sqlite3") {
    const rows: Array<{ name: string }> = await knex.raw("PRAGMA index_list(??)", [tableName]);
    return rows.map(row => row.name);
  }
  const rows: Array<{ name: string }> = dialect === "mysql"
    ? await knex("information_schema.statistics").distinct({ name: "index_name" })
      .where("table_schema", knex.raw("database()")).andWhere("table_name", tableName)
    : await knex("pg_indexes").select({ name: "indexname" })
      .where("schemaname", knex.raw("current_schema()")).andWhere("tablename", tableName);
  return rows.map(row => row.name);
}

/**
 * Refuse an `alter` that names a column wrongly, before it changes anything:
 * one to add must be new, and one to rename, change or drop must exist by then.
 * Checked here because SQLite's rebuild skips a missing column without a word.
 */
function checkColumns(
  tableName: string, existing: string[],
  add?: object, rename?: Record<string, unknown>, change?: object, drop?: string[],
): void {
  const columns = new Set(existing);
  const need = (name: string, present: boolean, what: string) => {
    if (columns.has(name) !== present) {
      throw new Error(`$tableAlter: ${present ? "no" : "a"} column "${name}" ${present ? "to" : "already exists, so cannot"} ${what} in "${tableName}"`);
    }
  };
  for (const name of Object.keys(add ?? {})) { need(name, false, "add"); columns.add(name); }
  for (const [from, to] of Object.entries(rename ?? {})) {
    need(from, true, "rename");
    need(String(to), false, "rename to");
    columns.delete(from);
    columns.add(String(to));
  }
  for (const name of Object.keys(change ?? {})) need(name, true, "change");
  for (const name of drop ?? []) { need(name, true, "drop"); columns.delete(name); }
}

/**
 * Map a JSON Schema `type` to a SQL column type, used as a fallback when a
 * column omits `sqlType`. JSON Schema's type vocabulary is coarser than
 * SQL's, so authors needing precise types (varchar vs text, bigint, timestamp)
 * should set `sqlType`.
 */
function jsonTypeToSql(type: string | string[] | undefined): string {
  const t = Array.isArray(type) ? type.find((x) => x !== "null") : type;
  switch (t) {
    case "integer": return "integer";
    case "number":  return "float";
    case "boolean": return "boolean";
    case "object":
    case "array":   return "json";
    case "string":  return "varchar";
    default:        return "text";
  }
}

/**
 * Build columns from a JSON Schema `properties` map, returning their builders.
 * Reads JSON Schema keywords (`type`, `maxLength`) and the SQL keys beside them.
 * NOT NULL is derived from membership in `required`.
 */
function buildColumns(
  table: KnexType.CreateTableBuilder,
  properties: Record<string, ColumnSchema>,
  required: Set<string>,
  knex: KnexType,
): KnexType.ColumnBuilder[] {
  const columns: KnexType.ColumnBuilder[] = [];
  for (const [name, col] of Object.entries(properties)) {
    const sqlType = (col.sqlType ?? jsonTypeToSql(col.type)).toLowerCase();
    let column: KnexType.ColumnBuilder;

    switch (sqlType) {
      case "integer":
        column = col.autoIncrement
          ? table.increments(name)
          : table.integer(name);
        break;
      case "biginteger":
      case "bigint":
        column = col.autoIncrement
          ? table.bigIncrements(name)
          : table.bigInteger(name);
        break;
      case "smallint":
        column = table.smallint(name);
        break;
      case "tinyint":
        column = table.tinyint(name);
        break;
      case "float":
        column = table.float(name, col.precision, col.scale);
        break;
      case "double":
        column = table.double(name, col.precision, col.scale);
        break;
      case "decimal":
        column = table.decimal(name, col.precision ?? 8, col.scale ?? 2);
        break;
      case "varchar":
        column = table.string(name, col.maxLength ?? 255);
        break;
      case "text":
        column = table.text(name);
        break;
      case "mediumtext":
        column = table.text(name, "mediumtext");
        break;
      case "longtext":
        column = table.text(name, "longtext");
        break;
      case "boolean":
        column = table.boolean(name);
        break;
      case "date":
        column = table.date(name);
        break;
      case "datetime":
        column = table.datetime(name);
        break;
      case "timestamp":
        column = table.timestamp(name);
        break;
      case "time":
        column = table.time(name);
        break;
      case "json":
        column = table.json(name);
        break;
      case "jsonb":
        column = table.jsonb(name);
        break;
      case "binary":
        column = table.binary(name);
        break;
      case "uuid":
        column = table.uuid(name);
        break;
      default:
        throw new Error(`Table column "${name}" has an unknown sqlType "${sqlType}"; it takes ${SQL_TYPES.join(", ")}`);
    }

    // Apply modifiers
    if (!col.autoIncrement) {
      if (col.primaryKey) column.primary();
      if (col.unsigned) column.unsigned();
    }
    if (required.has(name)) column.notNullable();
    if (col.unique && !col.primaryKey) column.unique();
    if (col.sqlDefault !== undefined) {
      if (col.sqlDefault === "CURRENT_TIMESTAMP") {
        column.defaultTo(knex.raw("CURRENT_TIMESTAMP"));
      } else {
        column.defaultTo(col.sqlDefault);
      }
    }
    if (col.comment) column.comment(col.comment);
    columns.push(column);
  }
  return columns;
}

/**
 * Build indexes from schema. A unique one is an index rather than a constraint
 * on PostgreSQL too, so `dropIndexes` drops either kind by name.
 */
function buildIndexes(
  table: KnexType.CreateTableBuilder,
  indexes: Record<string, IndexDef>,
): void {
  for (const [name, idx] of Object.entries(indexes)) {
    const cols = Array.isArray(idx.columns) ? idx.columns : [idx.columns];

    switch (idx.type) {
      case "unique":
        table.unique(cols, { indexName: name, useConstraint: false });
        break;
      case undefined:
      case "index":
        table.index(cols, name);
        break;
      default:
        throw new Error(`Index "${name}" has an unknown type ${JSON.stringify(idx.type)}; it takes "index" or "unique"`);
    }
  }
}

/**
 * Build foreign keys from schema
 */
function buildForeignKeys(
  table: KnexType.CreateTableBuilder,
  foreignKeys: Record<string, ForeignKeyDef>,
): void {
  for (const [name, fk] of Object.entries(foreignKeys)) {
    let builder = table
      .foreign(fk.column, name)
      .references(fk.references.column)
      .inTable(fk.references.table);

    if (fk.onDelete) builder = builder.onDelete(fk.onDelete);
    if (fk.onUpdate) builder = builder.onUpdate(fk.onUpdate);
  }
}
