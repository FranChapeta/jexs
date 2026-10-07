import fs from "fs/promises";
import path from "path";
import { Node, Context, NodeValue, isObject, isStep, resolve, resolveAll, resolverFor } from "@jexs/core";
import { TableJsonSchema, ColumnSchema } from "./Query.js";
import { sha256 } from "./Crypto.js";
import { validate, validateDetailed, getValidator } from "../validate.js";
import type { JexsNodeSchema } from "@jexs/core";

/** The functions a column's `computed` may name, each deriving the column from another on insert. */
const COMPUTE_FNS: Record<string, (value: string) => string> = { sha256 };

const JSON_TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"];
const SQL_TYPES = [
  "integer", "int", "biginteger", "bigint", "smallint", "tinyint", "float", "double", "decimal",
  "varchar", "string", "text", "template", "mediumtext", "longtext", "boolean", "bool",
  "date", "datetime", "timestamp", "time", "json", "jsonb", "binary", "blob", "uuid",
];
const REFERENTIAL = ["CASCADE", "SET NULL", "RESTRICT", "NO ACTION"];
const strings = { type: "array", items: { type: "string" } };

/**
 * SchemaNode - Manages table schema registration and data validation.
 *
 * Table schemas are authored as JSON Schema (draft 2020-12) documents: the
 * `properties` map defines columns, beside the settings that build the table. Insert/
 * update data is validated against the document by the shared Ajv validator
 * (see ../validate.ts), after coercion + computed-column enrichment.
 *
 * Register from directory:
 * { "$schema": "register", "path": "db/tables" }
 *
 * Register inline:
 * { "$schema": "register", "table": { "table": "migrations", "properties": { ... } } }
 */
/** The resolver's own SchemaNode, whose registry its queries consult. */
export function schemaFor(context: Context): SchemaNode {
  const node = resolverFor(context).nodeFor("schema");
  if (!(node instanceof SchemaNode)) {
    throw new Error("No SchemaNode in this resolver; build it with serverNodes().");
  }
  return node;
}

export class SchemaNode extends Node {
  /** `tableSchema` is a table document: JSON Schema for its rows, beside the
   *  settings that build and guard the table (display settings go under
   *  `x-entity`). It is a root document kind, so a file whose root has
   *  `properties` and `table` is checked as one. */
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
        validator: { $ref: "#/$defs/steps", description: "Steps run before each query on this table, after the global validator, with `operation`, `schema` and `query`. Not run for the table's own `create`." },
        "x-entity": { $ref: "#/$defs/_tableEntity" },
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
    _tableEntity: {
      type: "object",
      description: "Display settings for admin and listing templates; the server does not read them.",
      properties: {
        label:       { type: "string" },
        singular:    { type: "string" },
        icon:        { type: "object" },
        listColumns: strings,
        orderBy: {
          type: "object",
          properties: { column: { type: "string" }, direction: { enum: ["asc", "desc"] } },
        },
        color: { type: "string" },
      },
    },
    /** `create`'s `schema`: a table document, or a name, `"*"` or a step producing one. */
    _tableSchemaSlot: {
      if: { type: "object", anyOf: [{ required: ["properties"] }, { required: ["table"] }] },
      then: { $ref: "#/$defs/tableSchema" },
      else: { $ref: "#/$defs/strOrExpr" },
    },
  };

  static schema: JexsNodeSchema = {
    schema: {
      type: "string",
      enum: [
        "register",
        "get",
        "list",
        "validator",
        "validate",
      ],
      markdownDescription: "Registers table schemas for use by QueryNode. The operation is the primary value.",
      examples: [
        "{ \"$schema\": \"register\", \"path\": \"db/tables\" }",
      ],
      variants: {
        register: {
          output: "object",
          outputDescription: "`{ registered: [tableName, ...] }`.",
          markdownDescription: "Registers schemas from a directory `path` or an inline `table` document.",
          siblings: {
            path: { type: "string", description: "Directory of JSON schema files to load." },
            table: { $ref: "#/$defs/tableSchema", description: "A table document to register inline." },
          },
        },
        get: {
          output: "object",
          outputDescription: "The table's JSON Schema document, or `null` if not registered.",
          markdownDescription: "Returns a registered table schema by name.",
          siblings: {
            table: { type: "string", description: "Table name to retrieve." },
          },
        },
        list: {
          output: "array",
          markdownDescription: "Returns all registered table schemas.",
        },
        validator: {
          output: "null",
          markdownDescription: "Sets the global validator: steps run before every query on every table, create and drop included, to authorize it. They see `operation`, the table document as `schema`, and `query` (`table`, `where`, `data`, ...), which they may narrow. Refuse with `{ \"$error\": 403 }`. A table's own `validator` runs after this one, never instead of it. Queries with `system: true` skip both, so pass it for the app's own queries, such as creating tables at startup.",
          siblings: {
            run: { steps: true, description: "Steps run before each query." },
          },
        },
        validate: {
          output: "object",
          outputDescription: "`{ valid, errors }`, where each error is `{ path, message, keyword }` and `path` is dotted (`\"\"` for the root).",
          markdownDescription: "Validates `data` against a JSON Schema (draft 2020-12): either a `document` handed in, or the schema registered for `table`. Returns the result rather than throwing, so the caller decides what a failure means.",
          siblings: {
            data: { description: "The value to check. Pass it through a `var` (loaded with `data: true`) when it is itself a Jexs template, otherwise it resolves as an expression before it can be checked." },
            document: { description: "The JSON Schema document to check against. It compiles once per distinct document, whether written inline or passed by `var`." },
            table: { type: "string", description: "Name of a registered table schema to check against, instead of `document`." },
          },
        },
      },
    },
  };

  /** Registered table documents and the global validator. Instance fields, so a
   *  table registered in one resolver never judges another resolver's queries;
   *  the statics below take a context to find their own node. */
  private readonly schemas = new Map<string, TableJsonSchema>();
  private globalValidator: unknown = null;

  /** Cache of `required`-stripped clones used to validate partial updates. */
  private static updateSchemas: WeakMap<TableJsonSchema, object> = new WeakMap();


  /** Columns automatically added to every table schema. */
  private static readonly COMMON_COLUMNS: Record<string, ColumnSchema> = {
    system:     { type: "integer", default: 0, sqlType: "boolean", sqlDefault: 0 },
    created_at: { type: "string", sqlType: "timestamp", sqlDefault: "CURRENT_TIMESTAMP" },
  };

  private static injectCommonColumns(schema: TableJsonSchema): void {
    if (!schema.properties) return;
    for (const [name, col] of Object.entries(this.COMMON_COLUMNS)) {
      if (!(name in schema.properties)) {
        schema.properties[name] = { ...col };
      }
    }
  }

  private root: string;

  constructor(root: string = "src") {
    super();
    this.root = root;
  }

  schema(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$schema, context, op => {
      // Copies: a step that changes what it reads must not change the registry.
      if (op === "get") {
        const found = this.schemas.get(this.toString(def.table));
        return found ? structuredClone(found) : null;
      }
      if (op === "list") {
        return Array.from(this.schemas.values(), schema => structuredClone(schema));
      }
      if (op === "validator") {
        if (def.run !== undefined) {
          this.globalValidator = def.run;
        }
        return null;
      }
      if (op === "validate") {
        return doValidate(def, context);
      }
      return doRegister(def, context, this.root);
    });
  }

  // ============================================
  // Static API (used by QueryNode). Statics rather than methods, since every
  // method on a Node registers as an op; each takes the context to find the
  // resolver's own registry.
  // ============================================

  /**
   * Register a table document. The registry keeps its own copy, since the
   * document is usually a template's literal or a value from context that later
   * steps may change, and returns it. `withCommonColumns` adds the columns every
   * table gets (`system`, `created_at`) to that copy.
   */
  static register(context: Context, schema: unknown, withCommonColumns = false): TableJsonSchema {
    if (!isTableDocument(schema)) {
      throw new Error("A table document needs a `table` name and `properties`.");
    }
    const own = structuredClone(schema);
    if (withCommonColumns) this.injectCommonColumns(own);
    // Compile eagerly so a malformed schema throws at registration, not on the
    // first insert.
    getValidator(own);
    schemaFor(context).schemas.set(own.table, own);
    return own;
  }

  static getAll(context: Context): TableJsonSchema[] {
    return Array.from(schemaFor(context).schemas.values());
  }

  static get(context: Context, tableName: string): TableJsonSchema | undefined {
    return schemaFor(context).schemas.get(tableName);
  }

  /** The steps `$schema: "validator"` set, run before every query. */
  static globalValidator(context: Context): unknown {
    return schemaFor(context).globalValidator;
  }

  static validateInsert(context: Context, tableName: string, data: unknown): unknown {
    const schema = this.get(context, tableName);
    if (!schema?.properties) return data;

    if (Array.isArray(data)) {
      return data.map((row) =>
        this.validateRow(schema, row as Record<string, unknown>),
      );
    }
    return this.validateRow(schema, data as Record<string, unknown>);
  }

  /**
   * Enrich (strip unknown columns, fill computed, drop auto-increment, coerce
   * types) then validate the resulting row against the table's JSON Schema.
   */
  private static validateRow(
    schema: TableJsonSchema,
    row: Record<string, unknown>,
  ): Record<string, unknown> {
    const props = schema.properties;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(row)) {
      if (key in props) result[key] = row[key];
    }

    for (const [colName, col] of Object.entries(props)) {
      if (col.computed && result[colName] === undefined) {
        // Read source values from the original row: a computed column's source
        // (e.g. a plaintext password) is often not itself a stored column.
        this.fillComputed(result, row, colName, col.computed);
      }

      if (col.autoIncrement) {
        delete result[colName];
        continue;
      }

      if (result[colName] !== undefined) {
        result[colName] = this.coerceType(result[colName], col, colName, schema.table);
      }
    }

    this.assertValid(schema, result, schema.table);
    return result;
  }

  static validateUpdate(
    context: Context,
    tableName: string,
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    const schema = this.get(context, tableName);
    if (!schema?.properties) return data;
    const props = schema.properties;

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (!(key in props)) continue;
      const col = props[key];
      if (col.autoIncrement || col.computed) continue;
      if (this.coercionType(col) === "timestamp") continue;
      result[key] = this.coerceType(value, col, key, tableName);
    }

    // Partial update: validate provided fields, but never enforce `required`.
    this.assertValid(this.updateSchemaFor(schema), result, tableName);
    return result;
  }

  /** A `required`-stripped clone of `schema`, cached for reuse, used to validate
   *  partial updates without rejecting absent columns. */
  private static updateSchemaFor(schema: TableJsonSchema): object {
    let clone = this.updateSchemas.get(schema);
    if (!clone) {
      const { required: _required, ...rest } = schema;
      clone = rest;
      this.updateSchemas.set(schema, clone);
    }
    return clone;
  }

  private static assertValid(
    schema: object,
    row: Record<string, unknown>,
    tableName: string,
  ): void {
    const { valid, errors } = validate(schema, row);
    if (!valid) {
      throw new Error(`[Schema] Validation failed for "${tableName}": ${errors.join("; ")}`);
    }
  }

  private static fillComputed(
    target: Record<string, unknown>,
    source: Record<string, unknown>,
    colName: string,
    computed: Record<string, string>,
  ): void {
    for (const [fn, sourceCol] of Object.entries(computed)) {
      const computeFn = COMPUTE_FNS[fn];
      if (computeFn && source[sourceCol] !== undefined) {
        target[colName] = computeFn(String(source[sourceCol]));
      }
    }
  }

  /** The type name driving coercion: `sqlType` if present, else the JSON
   *  Schema `type` (first non-null when an array). */
  private static coercionType(col: ColumnSchema): string {
    const jsonType = Array.isArray(col.type)
      ? col.type.find((t) => t !== "null")
      : col.type;
    return (col.sqlType ?? jsonType ?? "").toLowerCase();
  }

  /**
   * Coerce a raw value to its stored representation. Pure type conversion only —
   * declarative constraints (max length, enum, pattern, format) are enforced by
   * the JSON Schema via Ajv after coercion.
   */
  private static coerceType(
    value: unknown,
    col: ColumnSchema,
    colName: string,
    tableName: string,
  ): unknown {
    switch (this.coercionType(col)) {
      case "integer":
      case "int":
      case "biginteger":
      case "bigint":
      case "smallint":
      case "tinyint": {
        const num = Number(value);
        if (isNaN(num)) {
          throw new Error(
            `[Schema] Column "${colName}" in "${tableName}" expects integer, got "${value}"`,
          );
        }
        return Math.floor(num);
      }

      case "number":
      case "float":
      case "double":
      case "decimal": {
        const num = Number(value);
        if (isNaN(num)) {
          throw new Error(
            `[Schema] Column "${colName}" in "${tableName}" expects number, got "${value}"`,
          );
        }
        return num;
      }

      case "varchar":
      case "string":
      case "text":
        return String(value);

      case "boolean":
      case "bool": {
        if (typeof value === "string") {
          return value !== "" && value !== "0" && value.toLowerCase() !== "false" ? 1 : 0;
        }
        return value ? 1 : 0;
      }

      default:
        return value;
    }
  }
}

/**
 * `{ "$schema": "validate", "data": ..., "document"|"table": ... }`.
 *
 * `data` is resolved (it is normally a `var` holding an already-parsed value),
 * and `document` too, so it can be handed over by `var`. Its compiled validator
 * is cached by content as well as by object, so a document written inline
 * compiles once however many times the step runs.
 */
function doValidate(def: Record<string, unknown>, context: Context): NodeValue {
  return resolveAll([def.document ?? null, def.table ?? null, def.data ?? null], context, ([documentRaw, tableRaw, data]) => {
    let schema: object | undefined;
    if (documentRaw !== null && typeof documentRaw === "object") {
      schema = documentRaw as object;
    } else if (typeof tableRaw === "string") {
      schema = SchemaNode.get(context, tableRaw);
      if (!schema) {
        return { valid: false, errors: [{ path: "", message: `no schema registered for table "${tableRaw}"`, keyword: "table" }] };
      }
    }
    if (!schema) {
      return { valid: false, errors: [{ path: "", message: "no schema to validate against: pass `document` or `table`", keyword: "document" }] };
    }
    // A schema that won't compile is the caller's mistake, not the data's, so it
    // is reported in the same shape rather than thrown past them.
    try {
      return validateDetailed(schema, data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { valid: false, errors: [{ path: "", message: `invalid schema: ${message}`, keyword: "schema" }] };
    }
  });
}

/** A table document: a `table` name and its column `properties`. */
function isTableDocument(value: unknown): value is TableJsonSchema {
  return isObject(value) && typeof value.table === "string" && isObject(value.properties);
}

async function doRegister(def: Record<string, unknown>, context: Context, root: string): Promise<unknown> {
  // A literal document registers as written, so its `validator` steps stay
  // steps; a step producing one (`$var`, or a `$file` with `data: true`)
  // resolves to it first.
  const table = isStep(def.table) ? await resolve(def.table, context) : def.table;
  if (isObject(table)) {
    const schema = SchemaNode.register(context, table, true);
    return { registered: [schema.table] };
  }

  // Directory path
  if (def.path && typeof def.path === "string") {
    const dirPath = path.join(root, def.path);
    const registered: string[] = [];

    try {
      const files = (await fs.readdir(dirPath)).filter(f => f.endsWith(".json"));
      // Read all files concurrently, then parse/register sequentially in
      // readdir order so registration order stays deterministic.
      const contents = await Promise.all(
        files.map(file => fs.readFile(path.join(dirPath, file), "utf-8")),
      );
      for (const content of contents) {
        const schema: unknown = JSON.parse(content);
        // The same keys that make the editor treat a file as a table document.
        if (isTableDocument(schema)) {
          registered.push(SchemaNode.register(context, schema, true).table);
        }
      }
    } catch (error) {
      console.error(
        `[SchemaNode] Error loading schemas from ${dirPath}:`,
        (error as Error).message,
      );
    }

    return { registered };
  }

  return null;
}
