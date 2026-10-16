import { Knex as KnexType } from "knex";
import { Node, Context, NodeValue, childContext, isObject, loggerFor, resolve, resolveAll, resolveFields, resolverFor, runSteps, type Logger } from "@jexs/core";
import { DatabaseNode, listTables } from "./Database.js";
import { sha256 } from "./Crypto.js";
import { SchemaNode, isTableDocument, requireSchemaNode, schemaArg, tableId } from "./Schema.js";
import type { JexsNodeSchema } from "@jexs/core";

/** The functions a column's `computed` may name, each deriving the column from another on insert. */
export const COMPUTE_FNS: Record<string, (value: string) => string> = { sha256 };

const JSON_TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"];
const SQL_TYPES = [
  "integer", "int", "biginteger", "bigint", "smallint", "tinyint", "float", "double", "decimal",
  "varchar", "string", "text", "mediumtext", "longtext", "boolean", "bool",
  "date", "datetime", "timestamp", "time", "json", "jsonb", "binary", "blob", "uuid",
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
  length?: number;
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
  type?: "index" | "unique" | "fulltext";
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
  /** Steps run before each query on this table, after the global validator
   *  (see DatabaseQuery's `runValidators`). */
  validator?: unknown;
  [key: string]: unknown;
}

const tableName = { type: "string", required: true, description: "The table's name." } as const;
const connection = { type: "string", description: "Named database connection (default if omitted)." } as const;
const system = { type: "boolean", description: "Skip the `$table` validator: for the app's own changes, such as building its tables at startup." } as const;
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
        validator: { $ref: "#/$defs/steps", description: "Steps run before each query on this table, after the global validator, with `operation`, `schema` and `query`." },
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
          type:    { enum: ["index", "unique", "fulltext"], default: "index" },
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
        length:        { type: "integer", description: "Length of a `varchar` (default 255); `maxLength` wins when both are set." },
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
    /** `create`'s and `sync`'s `schema`: a table document, or a table's name (`"*"`
     *  for every registered one), or a step producing either. */
    _tableSchemaSlot: {
      if: { type: "object", anyOf: [{ required: ["properties"] }, { required: ["table"] }] },
      then: { $ref: "#/$defs/tableSchema" },
      else: { $ref: "#/$defs/strOrExpr" },
    },
  };

  static schema: JexsNodeSchema = {
    table: {
      type: "string",
      enum: ["create", "sync", "alter", "rename", "drop", "exists", "list", "validator"],
      markdownDescription: "A database's tables. A table document declares a table's columns as JSON Schema, registered with `$schema` as `table/<name>` (`create` and `sync` register the one they are given); once registered, every `$query` write to the table is checked against it. `alter`, `rename` and `drop` change the database only: the registered document stays as it is, for `$schema: \"register\"` to replace.",
      examples: [
        "{ \"$table\": \"sync\", \"schema\": { \"$file\": \"db/users.json\", \"data\": true } }",
        "{ \"$table\": \"alter\", \"table\": \"users\", \"add\": { \"email\": { \"type\": \"string\" } } }",
        "{ \"$table\": \"drop\", \"table\": \"old_logs\" }",
      ],
      variants: {
        create: {
          output: "string",
          outputDescription: "The table's name.",
          markdownDescription: "Creates a table from its document, registering it first when it is given one. A table that already exists is an error; `sync` brings an existing one up to date instead.",
          siblings: {
            schema: { $ref: "#/$defs/_tableSchemaSlot", literal: true, required: true, description: "A table document, kept as written so its `validator` stays steps (load a file with `$file` and `data: true`), or the name of a registered table." },
            connection,
            system,
          },
        },
        sync: {
          output: tableNames,
          outputDescription: "The names of the tables it created.",
          markdownDescription: "Makes the database match table documents, adding only: it creates the tables that are missing, and adds the columns and named indexes an existing table lacks. A required column added to a table with rows is nullable until an `alter` makes it NOT NULL. It never changes, renames or drops what is there, since that could lose data; it warns about columns the document lacks, for an `alter` to deal with. Given a `schema` document, it registers it first; given a table's name, it syncs that registered table; without one, or with `\"*\"`, every registered table.",
          siblings: {
            schema: { $ref: "#/$defs/_tableSchemaSlot", literal: true, description: "A table document (kept as written, as for `create`), a registered table's name, or `\"*\"` for every registered table, the default." },
            connection,
            system,
          },
        },
        alter: {
          output: "null",
          markdownDescription: "Changes a table's structure, applying in this order: `dropIndexes`, `add`, `rename`, `change`, `drop`, `addIndexes`. Each is done as given, so adding a column that exists or dropping one that does not is an error. To make a column NOT NULL once its rows have a value, `change` it with its name in `required`. A failure partway leaves the earlier changes made; on PostgreSQL and SQLite, wrap the step in `$database: \"transaction\"` to apply all or none.",
          examples: [
            "{ \"$table\": \"alter\", \"table\": \"users\", \"change\": { \"email\": { \"type\": \"string\" } }, \"required\": [\"email\"] }",
            "{ \"$table\": \"alter\", \"table\": \"users\", \"rename\": { \"mail\": \"email\" }, \"drop\": [\"legacy_id\"] }",
          ],
          siblings: {
            table: tableName,
            add: { $ref: "#/$defs/_tableColumns", description: "Columns to add, by name, each described as in a table document (`type`, `sqlType`, `sqlDefault`, ...)." },
            rename: { map: true, description: "Columns to rename: `{ \"old\": \"new\" }`." },
            change: { $ref: "#/$defs/_tableColumns", description: "Columns to change, by name (after `rename`), each described in full as in a table document: what the description leaves out, such as a default, the column loses." },
            drop: names("Columns to drop."),
            required: names("Which columns of `add` and `change` are NOT NULL."),
            addIndexes: { $ref: "#/$defs/_tableIndexes", description: "Indexes to add, by name, as in a table document's `indexes`." },
            dropIndexes: names("Indexes to drop, by name."),
            connection,
            system,
          },
        },
        rename: {
          output: "string",
          outputDescription: "The table's new name.",
          markdownDescription: "Renames a table.",
          siblings: {
            table: tableName,
            to: { type: "string", required: true, description: "The table's new name." },
            connection,
            system,
          },
        },
        drop: {
          output: "null",
          markdownDescription: "Drops the table if it exists. Its registered document, if any, stays registered; `unregister` forgets it.",
          siblings: { table: tableName, connection, system },
        },
        exists: {
          output: "boolean",
          markdownDescription: "Whether the table exists in the database.",
          siblings: { table: tableName, connection },
        },
        list: {
          output: tableNames,
          outputDescription: "The names of the database's tables, sorted.",
          markdownDescription: "Lists the tables in the database, whether or not a document is registered for them.",
          siblings: { connection },
        },
        validator: {
          output: "null",
          markdownDescription: "Sets the validator for structure: steps run before every `create`, `sync` (once per table), `alter`, `rename` and `drop` to authorize it. They see `operation`, `table`, the table's document as `schema` (the one being applied for `create` and `sync`, else the registered one, if any) and, for `alter` and `rename`, what they change as `changes`. Refuse with `{ \"$error\": 403 }`. Steps with `system: true` skip it. Row queries have their own, `$query: \"validator\"`.",
          siblings: {
            do: { steps: true, description: "Steps run before each change to a table's structure." },
          },
        },
      },
    },
  };

  /** The steps `{ "$table": "validator" }` set, run before every change to a
   *  table's structure. An instance field, so one resolver's policy never
   *  judges another's changes. */
  validator: unknown = null;

  table(def: Record<string, unknown>, context: Context): NodeValue {
    if (def.$table === "validator") {
      this.validator = def.do ?? null;
      return null;
    }
    return resolve(def.$table, context, op => {
      switch (op) {
        case "create":
          return doCreate(def, context);
        case "sync":
          return doSync(def, context);
        case "alter":
          return doAlter(def, context);
        case "rename":
          return resolveAll([def.table, def.to, def.connection ?? null, def.system ?? null], context, async ([table, to, name, system]) => {
            await authorize(context, system, "rename", String(table), { changes: { to } });
            await DatabaseNode.getKnex(context, name).schema.renameTable(String(table), String(to));
            loggerFor(context).info(`[DatabaseTable] Renamed table ${String(table)} to ${String(to)}`);
            return String(to);
          });
        case "drop":
          return resolveAll([def.table, def.connection ?? null, def.system ?? null], context, async ([table, name, system]) => {
            await authorize(context, system, "drop", String(table));
            await DatabaseNode.getKnex(context, name).schema.dropTableIfExists(String(table));
            loggerFor(context).info(`[DatabaseTable] Dropped table: ${String(table)}`);
            return null;
          });
        case "exists":
          return resolveAll([def.table, def.connection ?? null], context, ([table, name]) =>
            DatabaseNode.getKnex(context, name).schema.hasTable(String(table)));
        case "list":
          return resolve(def.connection ?? null, context, name => listTables(DatabaseNode.getKnex(context, name)));
        default:
          throw new Error(`$table: unknown operation ${JSON.stringify(op)}`);
      }
    });
  }

  /** The document registered for table `tableName`, as written. A static
   *  rather than a method, since every method on a Node registers as an op. */
  static get(context: Context, tableName: string): TableJsonSchema | undefined {
    const doc = requireSchemaNode(context).documents.get(tableId(tableName));
    return isTableDocument(doc) ? doc as TableJsonSchema : undefined;
  }
}

/**
 * Run the `$table` validator, if one is set and the step is not `system`, before
 * a change to `table`. It sees the table's document as `schema` (a copy, so the
 * registered one stays as registered) unless `extra` gives the one being
 * applied, and refuses by throwing.
 */
async function authorize(
  context: Context, system: unknown, operation: string, table: string,
  extra: { schema?: TableJsonSchema; changes?: Record<string, unknown> } = {},
): Promise<void> {
  const node = resolverFor(context).nodeFor("table");
  const steps = node instanceof DatabaseTableNode ? node.validator : null;
  if (steps == null || system === true) return;
  const schema = extra.schema ?? DatabaseTableNode.get(context, table);
  await runSteps(steps, childContext(context, {
    operation, table, schema: schema && structuredClone(schema), changes: extra.changes,
  }));
}

/**
 * The table documents a `create` or `sync` names in `schema`, each authorized by
 * the `$table` validator: a document, which is registered once authorized; a
 * registered table's name; or, for `sync` only, `"*"` or nothing for every
 * registered table.
 */
async function documentsOf(def: Record<string, unknown>, context: Context, operation: "create" | "sync"): Promise<TableJsonSchema[]> {
  const [schema, system] = await Promise.all([schemaArg(def.schema, context), resolve(def.system ?? null, context)]);
  const schemas = requireSchemaNode(context);
  if (isObject(schema)) {
    if (!isTableDocument(schema)) throw new Error("A table document needs a `table` name and `properties`.");
    await authorize(context, system, operation, schema.table, { schema: schema as TableJsonSchema });
    SchemaNode.register(schemas, schema);
    return [DatabaseTableNode.get(context, schema.table)!];
  }
  let documents: TableJsonSchema[];
  if (typeof schema === "string" && schema !== "*") {
    const found = DatabaseTableNode.get(context, schema);
    if (!found) throw new Error(`$table: no document registered for table "${schema}"`);
    documents = [found];
  } else if (operation === "sync") {
    documents = SchemaNode.all(schemas, tableId("")).filter(isTableDocument) as TableJsonSchema[];
  } else {
    throw new Error("$table create needs `schema`: a table document, or a registered table's name");
  }
  for (const doc of documents) await authorize(context, system, operation, doc.table);
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

/** `create`: create a table from its document. One that exists is an error. */
async function doCreate(def: Record<string, unknown>, context: Context): Promise<string> {
  const [schema] = await documentsOf(def, context, "create");
  const knex = DatabaseNode.getKnex(context, await resolve(def.connection ?? null, context));
  if (await knex.schema.hasTable(schema.table)) {
    throw new Error(`$table create: table "${schema.table}" already exists; \`sync\` adds what it lacks`);
  }
  await createTable(knex, schema);
  loggerFor(context).info(`[DatabaseTable] Created table: ${schema.table}`);
  return schema.table;
}

/**
 * `sync`: create each table that is missing, and bring each existing one up to
 * its document additively. Returns the names of the tables it created; a
 * failure throws, so a startup that cannot build its tables stops there.
 */
async function doSync(def: Record<string, unknown>, context: Context): Promise<string[]> {
  const schemas = await documentsOf(def, context, "sync");
  const knex = DatabaseNode.getKnex(context, await resolve(def.connection ?? null, context));
  const created: string[] = [];
  for (const schema of schemas) {
    const tableName = schema.table;
    if (await knex.schema.hasTable(tableName)) {
      await syncTable(knex, schema, loggerFor(context));
      continue;
    }
    await createTable(knex, schema);
    loggerFor(context).info(`[DatabaseTable] Created table: ${tableName}`);
    created.push(tableName);
  }
  return created;
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
      if (typeof col.default === "string" && /current_timestamp/i.test(col.default)) delete col.default;
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
 * `alter`: apply each change the step gives, in `ALTERATIONS` order, one
 * statement group at a time, so a later change sees the columns an earlier one
 * added or renamed.
 */
function doAlter(def: Record<string, unknown>, context: Context): unknown {
  return resolveFields(def, context, async r => {
    const tableName = String(r.table);
    const changes = Object.fromEntries(ALTERATIONS.filter(k => r[k] != null).map(k => [k, r[k]]));
    if (Object.keys(changes).length === 0) {
      throw new Error(`$table alter needs a change: ${ALTERATIONS.map(k => `\`${k}\``).join(", ")}`);
    }
    for (const key of ["add", "rename", "change", "addIndexes"] as const) {
      if (r[key] != null && !isObject(r[key])) throw new Error(`$table alter: \`${key}\` must be an object, by name`);
    }
    for (const key of ["drop", "dropIndexes", "required"] as const) {
      if (r[key] != null && !Array.isArray(r[key])) throw new Error(`$table alter: \`${key}\` must be an array of names`);
    }
    await authorize(context, r.system, "alter", tableName, { changes });

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
      throw new Error(`$table alter: ${present ? "no" : "a"} column "${name}" ${present ? "to" : "already exists, so cannot"} ${what} in "${tableName}"`);
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
    const length = col.maxLength ?? col.length ?? 255;
    let column: KnexType.ColumnBuilder;

    switch (sqlType) {
      case "integer":
      case "int":
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
      case "string":
        column = table.string(name, length);
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
      case "bool":
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
      case "blob":
        column = table.binary(name);
        break;
      case "uuid":
        column = table.uuid(name);
        break;
      default:
        throw new Error(`$table: column "${name}" has an unknown sqlType "${sqlType}"; it takes ${SQL_TYPES.join(", ")}`);
    }

    // Apply modifiers
    if (!col.autoIncrement) {
      if (col.primaryKey) column.primary();
      if (col.unsigned) column.unsigned();
    }
    if (required.has(name)) column.notNullable();
    if (col.unique && !col.primaryKey) column.unique();
    const defaultValue = col.sqlDefault ?? (col.default as string | number | boolean | null | undefined);
    if (defaultValue !== undefined) {
      if (defaultValue === "CURRENT_TIMESTAMP") {
        column.defaultTo(knex.raw("CURRENT_TIMESTAMP"));
      } else {
        column.defaultTo(defaultValue);
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
      default:
        table.index(cols, name);
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
