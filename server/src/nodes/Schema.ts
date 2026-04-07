import fs from "fs/promises";
import path from "path";
import { Node, Context, NodeValue } from "@jexs/core";
import { TableSchema, ColumnDef } from "./Query.js";
import { sha256 } from "./Crypto.js";

/**
 * SchemaNode - Manages table schema registration and data validation.
 *
 * Register from directory:
 * { "schema": "register", "path": "db/tables" }
 *
 * Register inline:
 * { "schema": "register", "table": { "table": "migrations", "columns": { ... } } }
 *
 * Schemas are stored in a static registry and used by QueryNode
 * to validate and enrich data on insert/update.
 */
export class SchemaNode extends Node {
  private static schemas: Map<string, TableSchema> = new Map();
  static globalValidator: unknown[] | null = null;

  private static computeFns: Record<string, (value: string) => string> = {
    sha256,
  };

  /** Columns automatically added to every table schema */
  private static readonly COMMON_COLUMNS: Record<string, ColumnDef> = {
    system: { type: "boolean", default: 0 },
    created_at: { type: "timestamp", default: "CURRENT_TIMESTAMP" },
  };

  /** Inject common columns into a schema (skips if column already exists) */
  static injectCommonColumns(schema: TableSchema): void {
    if (!schema.columns) return;
    for (const [name, col] of Object.entries(this.COMMON_COLUMNS)) {
      if (!(name in schema.columns)) {
        schema.columns[name] = { ...col };
      }
    }
  }

  schema(def: Record<string, unknown>, _context: Context): NodeValue {
    if (def.schema === "get") {
      const tableName = this.toString(def.table);
      return SchemaNode.get(tableName) ?? null;
    }
    if (def.schema === "list") {
      return Array.from(SchemaNode.schemas.values());
    }
    if (def.schema === "validator") {
      if (Array.isArray(def.run)) {
        SchemaNode.globalValidator = def.run;
      }
      return null;
    }
    return doRegister(def);
  }

  // ============================================
  // Static API (used by QueryNode)
  // ============================================

  /** Register a schema directly (e.g., from create query) */
  static register(schema: TableSchema): void {
    this.schemas.set(schema.table, schema);
  }

  /** Get all registered schemas */
  static getAll(): TableSchema[] {
    return Array.from(this.schemas.values());
  }

  /** Get a registered schema */
  static get(tableName: string): TableSchema | undefined {
    return this.schemas.get(tableName);
  }

  /**
   * Validate and enrich data for insert.
   */
  static validateInsert(tableName: string, data: unknown): unknown {
    const schema = this.schemas.get(tableName);
    if (!schema?.columns) return data;

    if (Array.isArray(data)) {
      return data.map((row) =>
        this.validateRow(schema, row as Record<string, unknown>),
      );
    }
    return this.validateRow(schema, data as Record<string, unknown>);
  }

  private static validateRow(
    schema: TableSchema,
    row: Record<string, unknown>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(row)) {
      if (key in schema.columns) {
        result[key] = row[key];
      }
    }

    for (const [colName, col] of Object.entries(schema.columns)) {
      if (col.computed && result[colName] === undefined) {
        this.fillComputed(result, colName, col);
      }

      if (col.autoIncrement) {
        delete result[colName];
        continue;
      }

      if (col.default !== undefined || col.computed) continue;

      if (col.notNull && result[colName] === undefined) {
        throw new Error(
          `[Schema] Missing required column "${colName}" for table "${schema.table}"`,
        );
      }

      if (result[colName] !== undefined) {
        result[colName] = this.coerceType(
          result[colName],
          col,
          colName,
          schema.table,
        );
      }
    }

    return result;
  }

  /**
   * Validate and filter data for update.
   */
  static validateUpdate(
    tableName: string,
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    const schema = this.schemas.get(tableName);
    if (!schema?.columns) return data;

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (!(key in schema.columns)) continue;
      const col = schema.columns[key];
      if (col.autoIncrement || col.computed) continue;
      if (col.type?.toLowerCase() === "timestamp") continue;
      result[key] = this.coerceType(value, col, key, tableName);
    }
    return result;
  }

  private static fillComputed(
    row: Record<string, unknown>,
    colName: string,
    col: ColumnDef,
  ): void {
    const computed = col.computed!;
    for (const [fn, sourceCol] of Object.entries(computed)) {
      const computeFn = this.computeFns[fn];
      if (computeFn && row[sourceCol] !== undefined) {
        row[colName] = computeFn(String(row[sourceCol]));
      }
    }
  }

  private static coerceType(
    value: unknown,
    col: ColumnDef,
    colName: string,
    tableName: string,
  ): unknown {
    const colType = col.type.toLowerCase();

    switch (colType) {
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
      case "string": {
        const str = String(value);
        if (col.length && str.length > col.length) {
          throw new Error(
            `[Schema] Column "${colName}" in "${tableName}" exceeds max length ${col.length}`,
          );
        }
        return str;
      }

      case "text":
        return String(value);

      case "boolean": {
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
  // Inline schema
  if (def.table && typeof def.table === "object") {
    const schema = def.table as TableSchema;
    SchemaNode.register(schema);
    return { registered: [schema.table] };
  }

  // Directory path
  if (def.path && typeof def.path === "string") {
    const dirPath = path.join("app", def.path);
    const registered: string[] = [];

    try {
      const files = await fs.readdir(dirPath);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const content = await fs.readFile(path.join(dirPath, file), "utf-8");
        const schema = JSON.parse(content) as TableSchema;
        if (schema.table) {
          SchemaNode.injectCommonColumns(schema);
          SchemaNode.register(schema);
          registered.push(schema.table);
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
