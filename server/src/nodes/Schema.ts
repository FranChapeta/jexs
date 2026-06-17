import fs from "fs/promises";
import path from "path";
import { Node, Context, NodeValue, resolve } from "@jexs/core";
import { TableJsonSchema, ColumnSchema, ColumnDbMeta, tableNameOf } from "./Query.js";
import { sha256 } from "./Crypto.js";
import { validate, getValidator } from "../validate.js";
import type { JexsNodeSchema } from "@jexs/core";

/**
 * SchemaNode - Manages table schema registration and data validation.
 *
 * Table schemas are authored as JSON Schema (draft 2020-12) documents: the
 * `properties` map defines columns, with DDL metadata under `x-db`. Insert/
 * update data is validated against the document by the shared Ajv validator
 * (see ../validate.ts), after coercion + computed-column enrichment.
 *
 * Register from directory:
 * { "schema": "register", "path": "db/tables" }
 *
 * Register inline:
 * { "schema": "register", "table": { "x-db": { "table": "migrations" }, "properties": { ... } } }
 */
export class SchemaNode extends Node {
  static schema: JexsNodeSchema = {
    schema: {
      type: "string",
      enum: [
        "register",
        "get",
        "list",
        "validator",
      ],
      markdownDescription: "Registers table schemas for use by QueryNode. The operation is the primary value.",
      examples: [
        "{ \"schema\": \"register\", \"path\": \"db/tables\" }",
      ],
      variants: {
        register: {
          output: "object",
          outputDescription: "`{ registered: [tableName, ...] }`.",
          markdownDescription: "Registers schemas from a directory `path` or an inline `table` document.",
          siblings: {
            path: { type: "string", description: "Directory of JSON schema files to load." },
            table: { description: "A table JSON Schema document to register inline." },
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
          markdownDescription: "Sets a global schema validator step sequence.",
          siblings: {
            run: { steps: true, description: "Step sequence to run as a schema validator." },
          },
        },
      },
    },
  };

  private static schemas: Map<string, TableJsonSchema> = new Map();
  static globalValidator: unknown[] | null = null;

  /** Cache of `required`-stripped clones used to validate partial updates. */
  private static updateSchemas: WeakMap<TableJsonSchema, object> = new WeakMap();

  private static computeFns: Record<string, (value: string) => string> = {
    sha256,
  };

  /** Columns automatically added to every table schema. */
  private static readonly COMMON_COLUMNS: Record<string, ColumnSchema> = {
    system:     { type: "integer", default: 0, "x-db": { sqlType: "boolean", default: 0 } },
    created_at: { type: "string", "x-db": { sqlType: "timestamp", default: "CURRENT_TIMESTAMP" } },
  };

  static injectCommonColumns(schema: TableJsonSchema): void {
    if (!schema.properties) return;
    for (const [name, col] of Object.entries(this.COMMON_COLUMNS)) {
      if (!(name in schema.properties)) {
        schema.properties[name] = { ...col, "x-db": { ...col["x-db"] } };
      }
    }
  }

  schema(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.schema, context, op => {
      if (op === "get") {
        return SchemaNode.get(this.toString(def.table)) ?? null;
      }
      if (op === "list") {
        return Array.from(SchemaNode.schemas.values());
      }
      if (op === "validator") {
        if (Array.isArray(def.run)) {
          SchemaNode.globalValidator = def.run;
        }
        return null;
      }
      return doRegister(def);
    });
  }

  // ============================================
  // Static API (used by QueryNode)
  // ============================================

  static register(schema: TableJsonSchema): void {
    // Compile eagerly so a malformed schema throws at registration, not on the
    // first insert.
    getValidator(schema);
    this.schemas.set(tableNameOf(schema), schema);
  }

  static getAll(): TableJsonSchema[] {
    return Array.from(this.schemas.values());
  }

  static get(tableName: string): TableJsonSchema | undefined {
    return this.schemas.get(tableName);
  }

  static validateInsert(tableName: string, data: unknown): unknown {
    const schema = this.schemas.get(tableName);
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
      const db = col["x-db"] ?? {};

      if (db.computed && result[colName] === undefined) {
        // Read source values from the original row: a computed column's source
        // (e.g. a plaintext password) is often not itself a stored column.
        this.fillComputed(result, row, colName, db.computed);
      }

      if (db.autoIncrement) {
        delete result[colName];
        continue;
      }

      if (result[colName] !== undefined) {
        result[colName] = this.coerceType(result[colName], col, colName, tableNameOf(schema));
      }
    }

    this.assertValid(schema, result, tableNameOf(schema));
    return result;
  }

  static validateUpdate(
    tableName: string,
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    const schema = this.schemas.get(tableName);
    if (!schema?.properties) return data;
    const props = schema.properties;

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (!(key in props)) continue;
      const col = props[key];
      const db = col["x-db"] ?? {};
      if (db.autoIncrement || db.computed) continue;
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
      const computeFn = this.computeFns[fn];
      if (computeFn && source[sourceCol] !== undefined) {
        target[colName] = computeFn(String(source[sourceCol]));
      }
    }
  }

  /** The type name driving coercion: `x-db.sqlType` if present, else the JSON
   *  Schema `type` (first non-null when an array). */
  private static coercionType(col: ColumnSchema): string {
    const db: ColumnDbMeta = col["x-db"] ?? {};
    const jsonType = Array.isArray(col.type)
      ? col.type.find((t) => t !== "null")
      : col.type;
    return (db.sqlType ?? jsonType ?? "").toLowerCase();
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

async function doRegister(def: Record<string, unknown>): Promise<unknown> {
  // Inline schema document
  if (def.table && typeof def.table === "object") {
    const schema = def.table as TableJsonSchema;
    SchemaNode.injectCommonColumns(schema);
    SchemaNode.register(schema);
    return { registered: [tableNameOf(schema)] };
  }

  // Directory path
  if (def.path && typeof def.path === "string") {
    const dirPath = path.join("app", def.path);
    const registered: string[] = [];

    try {
      const files = (await fs.readdir(dirPath)).filter(f => f.endsWith(".json"));
      // Read all files concurrently, then parse/register sequentially in
      // readdir order so registration order stays deterministic.
      const contents = await Promise.all(
        files.map(file => fs.readFile(path.join(dirPath, file), "utf-8")),
      );
      for (const content of contents) {
        const schema = JSON.parse(content) as TableJsonSchema;
        if (schema["x-db"]?.table) {
          SchemaNode.injectCommonColumns(schema);
          SchemaNode.register(schema);
          registered.push(tableNameOf(schema));
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
