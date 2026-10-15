import { Knex as KnexType } from "knex";
import { Node, Context, NodeValue, isObject, loggerFor, resolve, resolveAll } from "@jexs/core";
import { DatabaseNode } from "./Database.js";
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
const tableNames = { type: "array", items: { type: "string" } } as const;

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
        properties: { type: "object", additionalProperties: { $ref: "#/$defs/_tableColumn" }, description: "The columns, by name." },
        table:      { type: "string", description: "The table's name." },
        primaryKey: { ...strings, description: "A composite primary key. A single-column key is set on its column instead." },
        indexes: {
          type: "object",
          description: "Indexes, by name.",
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
      enum: ["create", "sync", "alter", "drop", "exists"],
      markdownDescription: "A database's tables. A table document declares a table's columns as JSON Schema, registered with `$schema` as `table/<name>` (`create` and `sync` register the one they are given); once registered, every `$query` write to the table is checked against it.",
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
          },
        },
        sync: {
          output: tableNames,
          outputDescription: "The names of the tables it created.",
          markdownDescription: "Makes the database match table documents: it creates the tables that are missing and adds the columns an existing table lacks. It never changes or drops what is there. Given a `schema` document, it registers it first; given a table's name, it syncs that registered table; without one, or with `\"*\"`, every registered table.",
          siblings: {
            schema: { $ref: "#/$defs/_tableSchemaSlot", literal: true, description: "A table document (kept as written, as for `create`), a registered table's name, or `\"*\"` for every registered table, the default." },
            connection,
          },
        },
        alter: {
          output: tableNames,
          outputDescription: "The names of the columns it added.",
          markdownDescription: "Changes a table's structure: `add` adds the columns it lacks, described as a document's columns are. The registered document, if any, is not changed.",
          siblings: {
            table: tableName,
            add: { type: "object", required: true, description: "Columns to add, by name, each described as in a table document (`type`, `sqlType`, `sqlDefault`, ...)." },
            connection,
          },
        },
        drop: {
          output: "null",
          markdownDescription: "Drops the table if it exists. Its registered document, if any, stays registered; `unregister` forgets it.",
          siblings: { table: tableName, connection },
        },
        exists: {
          output: "boolean",
          markdownDescription: "Whether the table exists in the database.",
          siblings: { table: tableName, connection },
        },
      },
    },
  };

  table(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$table, context, op => {
      switch (op) {
        case "create":
          return doCreate(def, context);
        case "sync":
          return doSync(def, context);
        case "alter":
          return doAlter(def, context);
        case "drop":
          return resolveAll([def.table, def.connection ?? null], context, async ([table, name]) => {
            await knexOf(context, name).schema.dropTableIfExists(String(table));
            loggerFor(context).info(`[DatabaseTable] Dropped table: ${String(table)}`);
            return null;
          });
        case "exists":
          return resolveAll([def.table, def.connection ?? null], context, ([table, name]) =>
            knexOf(context, name).schema.hasTable(String(table)));
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

/** The connection a `$table` op works on: the one it names, else the default. */
function knexOf(context: Context, name: unknown): KnexType {
  return DatabaseNode.getKnex(context, name == null ? undefined : String(name));
}

/**
 * The table documents a `create` or `sync` names in `schema`: a document, which
 * is registered first; a registered table's name; or, for `sync` only, `"*"` or
 * nothing for every registered table.
 */
async function documentsOf(def: Record<string, unknown>, context: Context, all: boolean): Promise<TableJsonSchema[]> {
  const schema = await schemaArg(def.schema, context);
  const schemas = requireSchemaNode(context);
  if (isObject(schema)) {
    if (!isTableDocument(schema)) throw new Error("A table document needs a `table` name and `properties`.");
    SchemaNode.register(schemas, schema);
    return [DatabaseTableNode.get(context, schema.table)!];
  }
  if (typeof schema === "string" && schema !== "*") {
    const found = DatabaseTableNode.get(context, schema);
    if (!found) throw new Error(`$table: no document registered for table "${schema}"`);
    return [found];
  }
  if (!all) throw new Error("$table create needs `schema`: a table document, or a registered table's name");
  return SchemaNode.all(schemas, tableId("")).filter(isTableDocument) as TableJsonSchema[];
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
  const [schema] = await documentsOf(def, context, false);
  const knex = knexOf(context, await resolve(def.connection ?? null, context));
  if (await knex.schema.hasTable(schema.table)) {
    throw new Error(`$table create: table "${schema.table}" already exists; \`sync\` adds what it lacks`);
  }
  await createTable(knex, schema);
  loggerFor(context).info(`[DatabaseTable] Created table: ${schema.table}`);
  return schema.table;
}

/**
 * `sync`: create each table that is missing and add the columns an existing
 * one lacks. Returns the names of the tables it created; a failure throws, so a
 * startup that cannot build its tables stops there.
 */
async function doSync(def: Record<string, unknown>, context: Context): Promise<string[]> {
  const schemas = await documentsOf(def, context, true);
  const knex = knexOf(context, await resolve(def.connection ?? null, context));
  const created: string[] = [];
  for (const schema of schemas) {
    const tableName = schema.table;
    if (await knex.schema.hasTable(tableName)) {
      const added = await syncMissingColumns(knex, schema);
      if (added.length > 0) {
        loggerFor(context).info(`[DatabaseTable] Table ${tableName}: added columns [${added.join(", ")}]`);
      }
      continue;
    }
    await createTable(knex, schema);
    loggerFor(context).info(`[DatabaseTable] Created table: ${tableName}`);
    created.push(tableName);
  }
  return created;
}

/**
 * Auto-detect and add missing columns to an existing table
 */
async function syncMissingColumns(
  knex: KnexType,
  schema: TableJsonSchema,
): Promise<string[]> {
  const tableName = schema.table;
  const existingCols = await knex(tableName).columnInfo();
  const existingNames = new Set(Object.keys(existingCols));
  const missing: [string, ColumnSchema][] = [];

  for (const [name, col] of Object.entries(schema.properties)) {
    if (!existingNames.has(name)) {
      // Strip non-constant defaults (e.g. CURRENT_TIMESTAMP) — SQLite rejects
      // these on ALTER TABLE. notNull is not applied (empty required set below),
      // since existing rows already have NULL.
      const safeDef: ColumnSchema = { ...col };
      if (typeof safeDef.sqlDefault === "string" && /current_timestamp/i.test(safeDef.sqlDefault)) {
        delete safeDef.sqlDefault;
      }
      if (typeof safeDef.default === "string" && /current_timestamp/i.test(safeDef.default)) {
        delete safeDef.default;
      }
      missing.push([name, safeDef]);
    }
  }

  if (missing.length === 0) return [];

  await knex.schema.alterTable(tableName, (table) => {
    buildColumns(table, Object.fromEntries(missing), new Set(), knex);
  });

  return missing.map(([name]) => name);
}

/**
 * `alter`: add the given columns the table lacks. Returns the names of those it
 * added; columns already there are skipped.
 */
function doAlter(def: Record<string, unknown>, context: Context): unknown {
  return resolveAll([def.table, def.add ?? null, def.connection ?? null], context, async ([tableRaw, add, name]) => {
    const tableName = String(tableRaw);
    if (!isObject(add) || Object.keys(add).length === 0) {
      throw new Error("$table alter needs `add`: the columns to add, by name");
    }
    const knex = knexOf(context, name);
    const existingNames = new Set(Object.keys(await knex(tableName).columnInfo()));
    const toAdd = Object.fromEntries(Object.entries(add).filter(([col]) => !existingNames.has(col))) as Record<string, ColumnSchema>;

    if (Object.keys(toAdd).length === 0) {
      loggerFor(context).info(`[DatabaseTable] ALTER ${tableName}: all columns already exist`);
      return [];
    }

    await knex.schema.alterTable(tableName, (table) => {
      buildColumns(table, toAdd, new Set(), knex);
    });

    const added = Object.keys(toAdd);
    loggerFor(context).info(`[DatabaseTable] ALTER ${tableName}: added columns [${added.join(", ")}]`);
    return added;
  });
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
 * Build columns from a JSON Schema `properties` map. Reads JSON Schema keywords
 * (`type`, `maxLength`) and the SQL keys beside them. NOT NULL is derived from
 * membership in `required`.
 */
function buildColumns(
  table: KnexType.CreateTableBuilder,
  properties: Record<string, ColumnSchema>,
  required: Set<string>,
  knex: KnexType,
): void {
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
        console.warn(
          `[DatabaseTable] Unknown column type: ${sqlType}, using string`,
        );
        column = table.string(name, length);
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
  }
}

/**
 * Build indexes from schema
 */
function buildIndexes(
  table: KnexType.CreateTableBuilder,
  indexes: Record<string, IndexDef>,
): void {
  for (const [name, idx] of Object.entries(indexes)) {
    const cols = Array.isArray(idx.columns) ? idx.columns : [idx.columns];

    switch (idx.type) {
      case "unique":
        table.unique(cols, { indexName: name });
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
