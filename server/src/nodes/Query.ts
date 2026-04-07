import { Knex as KnexType } from "knex";
import { Node, Context, NodeValue, resolve } from "@jexs/core";
import { DatabaseNode } from "./Database.js";
import { SchemaNode } from "./Schema.js";

/**
 * Valid SQL value types that Knex accepts
 */
type SqlValue = string | number | boolean | null | Date;

/**
 * Runtime validation for SQL values
 */
const SqlValidator = {
  isValid(value: unknown): value is SqlValue {
    if (value === null || value instanceof Date) return true;
    const t = typeof value;
    return t === "string" || t === "number" || t === "boolean";
  },

  value(value: unknown, ctx: string): SqlValue {
    if (this.isValid(value)) return value;
    throw new Error(`${ctx}: expected primitive, got ${typeof value}`);
  },

  string(value: unknown, ctx: string): string {
    if (typeof value === "string") return value;
    throw new Error(`${ctx}: expected string, got ${typeof value}`);
  },

  array(value: unknown, ctx: string): SqlValue[] {
    if (!Array.isArray(value)) throw new Error(`${ctx}: expected array`);
    return value.map((v, i) => this.value(v, `${ctx}[${i}]`));
  },

  tuple(value: unknown, ctx: string): [SqlValue, SqlValue] {
    if (!Array.isArray(value) || value.length !== 2) {
      throw new Error(`${ctx}: expected [min, max] tuple`);
    }
    return [
      this.value(value[0], `${ctx}[0]`),
      this.value(value[1], `${ctx}[1]`),
    ];
  },
};

/**
 * JSON Query Definition Types
 */
export interface QueryDefinition {
  type: "select" | "insert" | "upsert" | "update" | "delete" | "count" | "create" | "drop" | "alter";
  table?: string;
  columns?: string[];
  data?: Record<string, unknown> | Record<string, unknown>[];
  where?: WhereClause;
  orderBy?: Record<string, "asc" | "desc" | "ASC" | "DESC">;
  groupBy?: string | string[];
  limit?: number;
  offset?: number;
  innerJoin?: JoinDefinition[];
  leftJoin?: JoinDefinition[];
  rightJoin?: JoinDefinition[];
  first?: boolean;
  distinct?: boolean;
  // Schema operations
  schema?: string | TableSchema;
  // Aggregate
  group_concat?: Record<string, string | [string, string]>;
  conflict?: string[];
  // Alter operations
  addColumns?: Record<string, ColumnDef>;
}

/**
 * Column definition in schema
 */
export interface ColumnDef {
  type: string;
  length?: number;
  precision?: number;
  scale?: number;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  notNull?: boolean;
  unique?: boolean;
  default?: string | number | boolean | null;
  onUpdate?: string;
  unsigned?: boolean;
  comment?: string;
  tailwind?: boolean; // For template fields
  computed?: Record<string, string>; // e.g., { "sha256": "original_text" }
  secret?: boolean; // Column value should be masked in output
  // Form metadata
  inputType?: string;
  label?: string;
  pattern?: string;
  options?: Array<{ value: unknown; label: string }>;
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
 * Table schema definition
 */
export interface TableSchema {
  table: string;
  columns: Record<string, ColumnDef>;
  indexes?: Record<string, IndexDef>;
  primaryKey?: string[];
  foreignKeys?: Record<string, ForeignKeyDef>;
  options?: {
    engine?: string;
    charset?: string;
    collate?: string;
  };
  validator?: unknown[] | false;
  // Entity metadata
  label?: string;
  singular?: string;
  icon?: Record<string, unknown>;
  listColumns?: string[];
  orderBy?: { column: string; direction: string };
  color?: string;
}

export interface JoinDefinition {
  table: string;
  as?: string;
  on: Record<string, string>;
}

export type WhereClause = Record<string, WhereValue> | WhereGroup;

export interface WhereGroup {
  or?: WhereClause[];
  and?: WhereClause[];
}

export type WhereValue =
  | unknown // Direct value for equality
  | { eq?: unknown }
  | { neq?: unknown; ne?: unknown; "!="?: unknown }
  | { gt?: unknown; ">"?: unknown }
  | { gte?: unknown; ">="?: unknown }
  | { lt?: unknown; "<"?: unknown }
  | { lte?: unknown; "<="?: unknown }
  | { like?: string }
  | { notLike?: string }
  | { in?: unknown[] }
  | { notIn?: unknown[] }
  | { between?: [unknown, unknown] }
  | { isNull?: boolean }
  | { isNotNull?: boolean };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * QueryNode - Handles JSON query definitions.
 *
 * SELECT:
 * { "query": { "type": "select", "table": "users", "columns": ["id", "name"] } }
 * { "query": { "type": "select", "table": "users", "where": { "id": 1 } }, "first": true }
 *
 * INSERT:
 * { "query": { "type": "insert", "table": "users", "data": { "name": "John" } } }
 *
 * UPDATE:
 * { "query": { "type": "update", "table": "users", "data": { "name": "Jane" }, "where": { "id": 1 } } }
 *
 * DELETE:
 * { "query": { "type": "delete", "table": "users", "where": { "id": 1 } } }
 *
 * COUNT:
 * { "query": { "type": "count", "table": "users" } }
 *
 * CREATE TABLE:
 * { "query": { "type": "create", "schema": "schema/tables" } }
 *
 * DROP TABLE:
 * { "query": { "type": "drop", "table": "users" } }
 */
export class QueryNode extends Node {
  async query(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    // Get connection name
    const connectionName = def.connection
      ? String(await resolve(def.connection, context))
      : (DatabaseNode.getDefaultConnection() ?? "default");

    // Get Knex instance
    const knex = DatabaseNode.getKnex(connectionName);

    // Resolve the query definition selectively to avoid resolver conflicts.
    // Column names like "slug", "length", "type" would collide with node keys
    // (StringNode, ArrayNode, etc.) if we passed the whole structure through
    // the resolver. Instead, resolve only the values that need it.
    const resolvedQuery = await resolveQueryDef(
      def.query as Record<string, unknown>,
      context,
    );

    // Run schema validator if defined (skip for system queries)
    if (!def.system) {
      const validatorResult = await runValidator(
        resolvedQuery,
        context,
      );
      if (validatorResult !== undefined) return validatorResult as NodeValue;
    }

    // Check for "first" flag at outer level
    const first = def.first === true || resolvedQuery.first === true;

    // Execute based on type
    switch (resolvedQuery.type) {
      case "select":
        return executeSelect(knex, resolvedQuery, first) as Promise<NodeValue>;
      case "insert":
        return executeInsert(knex, resolvedQuery) as Promise<NodeValue>;
      case "upsert":
        return executeUpsert(knex, resolvedQuery) as Promise<NodeValue>;
      case "update":
        return executeUpdate(knex, resolvedQuery) as Promise<NodeValue>;
      case "delete":
        return executeDelete(knex, resolvedQuery) as Promise<NodeValue>;
      case "count":
        return executeCount(knex, resolvedQuery) as Promise<NodeValue>;
      case "create":
        return executeCreate(knex, resolvedQuery) as Promise<NodeValue>;
      case "drop":
        return executeDrop(knex, resolvedQuery) as Promise<NodeValue>;
      case "alter":
        return executeAlter(knex, resolvedQuery) as Promise<NodeValue>;
      default:
        throw new Error(
          `Unknown query type: ${(resolvedQuery as QueryDefinition).type}`,
        );
    }
  }
}

/**
 * Run the schema validator before a query executes.
 * Returns a response object to abort, or undefined to continue.
 */
async function runValidator(
  query: QueryDefinition,
  context: Context,
): Promise<unknown | undefined> {
  if (!query.table || (context as Record<string, unknown>).$validating) {
    return undefined;
  }

  const tableSchema = query.table ? SchemaNode.get(query.table) : undefined;
  const validator =
    tableSchema?.validator !== undefined ? tableSchema.validator : SchemaNode.globalValidator;

  if (!validator || !Array.isArray(validator)) {
    return undefined;
  }

  const validatorContext: Context = {
    ...context,
    $validating: true,
    schema: tableSchema ?? { table: query.table },
    operation: query.type,
  };

  for (const step of validator) {
    const result = await resolve(step, validatorContext);

    // Check for response (error, redirect, etc.)
    if (isObject(result) && "type" in result) {
      const type = String((result as Record<string, unknown>).type);
      if (["error", "redirect", "json", "html", "notFound"].includes(type)) {
        return result;
      }
    }

    // Support "as" variable assignment
    if (isObject(step) && "as" in step) {
      const varName = String((step as Record<string, unknown>).as).replace(/^\$/, "");
      validatorContext[varName] = result;
    }
  }

  return undefined;
}


/**
 * Resolve a query definition, protecting where/data/orderBy keys (column
 * names) from being matched by nodes like StringNode ("slug", "title", etc.).
 * Uses the schema registry to identify column names.
 */
async function resolveQueryDef(
  raw: Record<string, unknown>,
  context: Context,
): Promise<QueryDefinition> {
  const { where, data, orderBy, groupBy, schema, addColumns, group_concat, conflict, ...rest } = raw;

  const query = validateQuery(await resolve(rest, context));

  const tableSchema = query.table ? SchemaNode.get(query.table) : undefined;
  const columns = tableSchema?.columns
    ? new Set(Object.keys(tableSchema.columns))
    : undefined;

  if (where) query.where = await resolveColumnValues(where, columns, context) as WhereClause;
  if (data !== undefined) {
    const rd = async (d: unknown) => await resolveColumnValues(d, columns, context) as Record<string, unknown>;
    query.data = Array.isArray(data) ? await Promise.all(data.map(rd)) : await rd(data);
  }
  if (orderBy) query.orderBy = orderBy as QueryDefinition["orderBy"];
  if (groupBy) query.groupBy = groupBy as QueryDefinition["groupBy"];
  if (schema) query.schema = schema as string | TableSchema;
  if (addColumns) query.addColumns = addColumns as Record<string, ColumnDef>;
  if (group_concat) query.group_concat = group_concat as QueryDefinition["group_concat"];
  if (conflict) query.conflict = conflict as string[];

  return query;
}

/**
 * Resolve an object that maps column names to values. Keys matching known
 * columns are preserved and only their values resolved. If no key matches
 * a column, the whole object is resolved as an expression (e.g. {"var":"$x"}).
 */
async function resolveColumnValues(
  obj: unknown,
  columns: Set<string> | undefined,
  context: Context,
): Promise<unknown> {
  if (!isObject(obj)) return resolve(obj, context);

  const keys = Object.keys(obj);
  const hasColumnKey = columns
    ? keys.some((k) => {
        const bare = k.includes(".") ? k.split(".").pop()! : k;
        return columns.has(bare) || k === "or" || k === "and";
      })
    : false;

  if (!hasColumnKey) return resolve(obj, context);

  const WHERE_OPS = new Set(["eq","neq","ne","!=","gt",">","gte",">=","lt","<","lte","<=","like","notLike","in","notIn","between","notBetween","null"]);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if ((key === "or" || key === "and") && Array.isArray(value)) {
      result[key] = await Promise.all(value.map((item) => resolveColumnValues(item, columns, context)));
    } else if (isObject(value) && Object.keys(value).some((k) => WHERE_OPS.has(k))) {
      // Where operator object — resolve inner values only, not the outer structure
      const op: Record<string, unknown> = {};
      for (const [opKey, opVal] of Object.entries(value)) {
        op[opKey] = Array.isArray(opVal)
          ? await Promise.all(opVal.map((v: unknown) => resolve(v, context)))
          : await resolve(opVal, context);
      }
      result[key] = op;
    } else {
      result[key] = await resolve(value, context);
    }
  }
  return result;
}

/**
 * Validate query structure at runtime
 */
function validateQuery(query: unknown): QueryDefinition {
  if (!query || typeof query !== "object") {
    throw new Error("Query must be an object");
  }

  const q = query as Record<string, unknown>;

  if (typeof q.type !== "string") {
    throw new Error("Query must have a type property");
  }

  const validTypes = [
    "select",
    "insert",
    "upsert",
    "update",
    "delete",
    "count",
    "create",
    "drop",
    "alter",
  ];
  if (!validTypes.includes(q.type)) {
    throw new Error(`Invalid query type: ${q.type}`);
  }

  // Schema operations don't require table (it's in the schema)
  if (q.type !== "create" && typeof q.table !== "string") {
    throw new Error("Query must have a table property");
  }

  return query as QueryDefinition;
}

/**
 * Execute a SELECT query
 */
async function executeSelect(
  knex: KnexType,
  query: QueryDefinition,
  first: boolean,
): Promise<unknown> {
  if (!query.table) throw new Error("Query requires a table name");
  let builder = knex(query.table);

  // Distinct
  if (query.distinct) {
    builder = builder.distinct();
  }

  // Columns
  if (query.columns && query.columns.length > 0) {
    builder = builder.select(query.columns);
  } else {
    builder = builder.select("*");
  }

  // Group Concat
  if (query.group_concat) {
    for (const [alias, colDef] of Object.entries(query.group_concat)) {
      const [col, sep] = Array.isArray(colDef) ? colDef : [colDef, ","];
      builder = builder.select(knex.raw(`GROUP_CONCAT(??, ?) as ??`, [col, sep, alias]));
    }
  }

  // Joins
  if (query.innerJoin) {
    builder = applyJoins(builder, query.innerJoin, "inner");
  }
  if (query.leftJoin) {
    builder = applyJoins(builder, query.leftJoin, "left");
  }
  if (query.rightJoin) {
    builder = applyJoins(builder, query.rightJoin, "right");
  }

  // Where
  if (query.where) {
    builder = applyWhere(builder, query.where);
  }

  // Group By
  if (query.groupBy) {
    const groups = Array.isArray(query.groupBy)
      ? query.groupBy
      : [query.groupBy];
    builder = builder.groupBy(groups);
  }

  // Order By
  if (query.orderBy) {
    for (const [column, direction] of Object.entries(query.orderBy)) {
      builder = builder.orderBy(
        column,
        direction.toLowerCase() as "asc" | "desc",
      );
    }
  }

  // Limit
  if (query.limit) {
    builder = builder.limit(query.limit);
  }

  // Offset
  if (query.offset) {
    builder = builder.offset(query.offset);
  }

  // Execute
  if (first) {
    const result = await builder.first();
    return result || null;
  }

  return builder;
}

/**
 * Execute an INSERT query
 */
async function executeInsert(
  knex: KnexType,
  query: QueryDefinition,
): Promise<number | number[]> {
  if (!query.table) throw new Error("Query requires a table name");
  if (!query.data) {
    throw new Error("INSERT query requires data");
  }

  // Validate and enrich data (computed columns, type coercion)
  const data = SchemaNode.validateInsert(query.table!, query.data);

  const result = await knex(query.table).insert(data);
  return Array.isArray(query.data) ? result : result[0];
}

/**
 * Execute an UPSERT query (INSERT ... ON CONFLICT ... DO UPDATE)
 */
async function executeUpsert(
  knex: KnexType,
  query: QueryDefinition,
): Promise<number | number[]> {
  if (!query.table) throw new Error("Query requires a table name");
  if (!query.data) {
    throw new Error("UPSERT query requires data");
  }
  if (!query.conflict || !query.conflict.length) {
    throw new Error("UPSERT query requires conflict columns");
  }

  const data = SchemaNode.validateInsert(query.table!, query.data);

  const result = await knex(query.table)
    .insert(data)
    .onConflict(query.conflict)
    .merge();
  return Array.isArray(query.data) ? result : result[0];
}

/**
 * Execute an UPDATE query
 */
async function executeUpdate(
  knex: KnexType,
  query: QueryDefinition,
): Promise<number> {
  if (!query.table) throw new Error("Query requires a table name");
  if (!query.data || Array.isArray(query.data)) {
    throw new Error("UPDATE query requires data object");
  }

  // Validate and filter data (strip unknown columns, coerce types)
  const data = SchemaNode.validateUpdate(
    query.table!,
    query.data as Record<string, unknown>,
  );

  let builder = knex(query.table);

  if (query.where) {
    builder = applyWhere(builder, query.where);
  }

  return builder.update(data);
}

/**
 * Execute a DELETE query
 */
async function executeDelete(
  knex: KnexType,
  query: QueryDefinition,
): Promise<number> {
  if (!query.table) throw new Error("Query requires a table name");
  let builder = knex(query.table);

  if (query.where) {
    builder = applyWhere(builder, query.where);
  } else {
    // Safety: require WHERE clause for DELETE
    throw new Error("DELETE query requires a WHERE clause");
  }

  return builder.delete();
}

/**
 * Execute a COUNT query
 */
async function executeCount(
  knex: KnexType,
  query: QueryDefinition,
): Promise<number> {
  let builder = knex(query.table!).count("* as count");

  if (query.where) {
    builder = applyWhere(builder, query.where);
  }

  const result = await builder.first();
  return Number((result as { count: number })?.count || 0);
}

/**
 * Execute a CREATE TABLE query from schema
 */
async function executeCreate(
  knex: KnexType,
  query: QueryDefinition,
): Promise<{ table: string; created: boolean }[]> {
  const results: { table: string; created: boolean; error?: string }[] = [];

  const schemas = resolveSchemas(query.schema);

  for (const schema of schemas) {
    // Register schema for validation/computed columns
    SchemaNode.register(schema);

    try {
      // Check if table exists
      const exists = await knex.schema.hasTable(schema.table);
      if (exists) {
        // Auto-detect and add missing columns
        const added = await syncMissingColumns(knex, schema);
        if (added.length > 0) {
          console.log(`[QueryNode] Table ${schema.table}: added columns [${added.join(", ")}]`);
        }
        results.push({ table: schema.table, created: false });
        continue;
      }

      // Create table
      await knex.schema.createTable(schema.table, (table) => {
        buildColumns(table, schema.columns, knex);
        if (schema.indexes) buildIndexes(table, schema.indexes);
        if (schema.foreignKeys)
          buildForeignKeys(table, schema.foreignKeys);
      });

      console.log(`[QueryNode] Created table: ${schema.table}`);
      results.push({ table: schema.table, created: true });
    } catch (error) {
      const e = error as Error;
      console.error(
        `[QueryNode] Error creating table ${schema.table}:`,
        e.message,
      );
      results.push({ table: schema.table, created: false, error: e.message });
    }
  }

  return results;
}

/**
 * Execute a DROP TABLE query
 */
async function executeDrop(
  knex: KnexType,
  query: QueryDefinition,
): Promise<{ table: string; dropped: boolean }> {
  const tableName = query.table!;

  try {
    await knex.schema.dropTableIfExists(tableName);
    console.log(`[QueryNode] Dropped table: ${tableName}`);
    return { table: tableName, dropped: true };
  } catch (error) {
    const e = error as Error;
    console.error(
      `[QueryNode] Error dropping table ${tableName}:`,
      e.message,
    );
    return { table: tableName, dropped: false };
  }
}

/**
 * Auto-detect and add missing columns to an existing table
 */
async function syncMissingColumns(
  knex: KnexType,
  schema: TableSchema,
): Promise<string[]> {
  const existingCols = await knex(schema.table).columnInfo();
  const existingNames = new Set(Object.keys(existingCols));
  const missing: [string, ColumnDef][] = [];

  for (const [name, col] of Object.entries(schema.columns)) {
    if (!existingNames.has(name)) {
      // Strip notNull for existing tables — rows already have NULL
      // Strip non-constant defaults (e.g. CURRENT_TIMESTAMP) — SQLite rejects these on ALTER TABLE
      const { notNull, ...safeDef } = col;
      if (typeof safeDef.default === "string" && /current_timestamp/i.test(safeDef.default)) {
        delete safeDef.default;
      }
      missing.push([name, safeDef as ColumnDef]);
    }
  }

  if (missing.length === 0) return [];

  await knex.schema.alterTable(schema.table, (table) => {
    buildColumns(table, Object.fromEntries(missing), knex);
  });

  return missing.map(([name]) => name);
}

/**
 * Execute an ALTER TABLE query to add columns
 */
async function executeAlter(
  knex: KnexType,
  query: QueryDefinition,
): Promise<{ table: string; added: string[] }> {
  const tableName = query.table!;
  const addColumns = query.addColumns;

  if (!addColumns || Object.keys(addColumns).length === 0) {
    throw new Error("ALTER query requires addColumns");
  }

  // Get existing columns to skip ones that already exist
  const existingCols = await knex(tableName).columnInfo();
  const existingNames = new Set(Object.keys(existingCols));
  const toAdd: Record<string, ColumnDef> = {};

  for (const [name, col] of Object.entries(addColumns)) {
    if (!existingNames.has(name)) {
      toAdd[name] = col;
    }
  }

  if (Object.keys(toAdd).length === 0) {
    console.log(`[QueryNode] ALTER ${tableName}: all columns already exist`);
    return { table: tableName, added: [] };
  }

  await knex.schema.alterTable(tableName, (table) => {
    buildColumns(table, toAdd, knex);
  });

  const added = Object.keys(toAdd);
  console.log(`[QueryNode] ALTER ${tableName}: added columns [${added.join(", ")}]`);
  return { table: tableName, added };
}

/**
 * Resolve schema(s) from the registry: "*" for all, or a table name for one.
 */
function resolveSchemas(
  schema: string | TableSchema | undefined,
): TableSchema[] {
  if (!schema) {
    throw new Error("CREATE query requires schema");
  }

  // Inline schema object
  if (typeof schema === "object") {
    return [schema];
  }

  // "*" — all registered schemas
  if (schema === "*") {
    return SchemaNode.getAll();
  }

  // Lookup by table name
  const found = SchemaNode.get(schema);
  if (found) return [found];

  throw new Error(`[QueryNode] Schema "${schema}" not found in registry`);
}

/**
 * Build columns from schema
 */
function buildColumns(
  table: KnexType.CreateTableBuilder,
  columns: Record<string, ColumnDef>,
  knex: KnexType,
): void {
  for (const [name, col] of Object.entries(columns)) {
    let column: KnexType.ColumnBuilder;

    switch (col.type.toLowerCase()) {
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
        column = table.string(name, col.length ?? 255);
        break;
      case "text":
      case "template":
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
          `[QueryNode] Unknown column type: ${col.type}, using string`,
        );
        column = table.string(name, col.length ?? 255);
    }

    // Apply modifiers
    if (!col.autoIncrement) {
      if (col.primaryKey) column.primary();
      if (col.unsigned) column.unsigned();
    }
    if (col.notNull) column.notNullable();
    if (col.unique && !col.primaryKey) column.unique();
    if (col.default !== undefined) {
      if (col.default === "CURRENT_TIMESTAMP") {
        column.defaultTo(knex.raw("CURRENT_TIMESTAMP"));
      } else {
        column.defaultTo(col.default);
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

/**
 * Apply JOIN clauses
 */
function applyJoins(
  builder: KnexType.QueryBuilder,
  joins: JoinDefinition[],
  type: "inner" | "left" | "right",
): KnexType.QueryBuilder {
  for (const join of joins) {
    const tableName = join.as ? `${join.table} as ${join.as}` : join.table;
    const onClauses = Object.entries(join.on);

    switch (type) {
      case "left":
        builder = builder.leftJoin(tableName, (qb) => {
          for (const [left, right] of onClauses) {
            qb.on(left, "=", right);
          }
        });
        break;
      case "right":
        builder = builder.rightJoin(tableName, (qb) => {
          for (const [left, right] of onClauses) {
            qb.on(left, "=", right);
          }
        });
        break;
      default:
        builder = builder.innerJoin(tableName, (qb) => {
          for (const [left, right] of onClauses) {
            qb.on(left, "=", right);
          }
        });
    }
  }

  return builder;
}

/**
 * Apply WHERE clauses
 */
function applyWhere(
  builder: KnexType.QueryBuilder,
  where: WhereClause,
): KnexType.QueryBuilder {
  // Handle OR groups
  if ("or" in where && Array.isArray(where.or)) {
    const conditions = where.or;
    builder = builder.where((qb) => {
      conditions.forEach((cond, i) => {
        if (i === 0) {
          applyWhereConditions(qb, cond);
        } else {
          qb.orWhere((subQb) => applyWhereConditions(subQb, cond));
        }
      });
    });
    return builder;
  }

  // Handle AND groups
  if ("and" in where && Array.isArray(where.and)) {
    const conditions = where.and;
    builder = builder.where((qb) => {
      conditions.forEach((cond) => {
        qb.andWhere((subQb) => applyWhereConditions(subQb, cond));
      });
    });
    return builder;
  }

  // Regular where conditions
  return applyWhereConditions(
    builder,
    where as Record<string, WhereValue>,
  );
}

/**
 * Apply individual WHERE conditions
 */
function applyWhereConditions(
  builder: KnexType.QueryBuilder,
  conditions: Record<string, WhereValue>,
): KnexType.QueryBuilder {
  for (const [col, value] of Object.entries(conditions)) {
    if (col === "or" || col === "and") continue;

    // Simple equality (non-object value)
    if (value === null || typeof value !== "object") {
      builder =
        value === null
          ? builder.whereNull(col)
          : builder.where(col, SqlValidator.value(value, col));
      continue;
    }

    const c = value as Record<string, unknown>;
    const v = (key: string) => SqlValidator.value(c[key], `${col}.${key}`);

    // Comparison operators (check multiple aliases)
    const comparisons: [string[], string][] = [
      [["eq"], "="],
      [["neq", "ne", "!="], "!="],
      [["gt", ">"], ">"],
      [["gte", ">="], ">="],
      [["lt", "<"], "<"],
      [["lte", "<="], "<="],
    ];

    let handled = false;
    for (const [keys, op] of comparisons) {
      const key = keys.find((k) => k in c);
      if (key) {
        builder =
          op === "!="
            ? builder.whereNot(col, v(key))
            : builder.where(col, op, v(key));
        handled = true;
        break;
      }
    }
    if (handled) continue;

    // String patterns
    if ("like" in c) {
      builder = builder.whereLike(
        col,
        SqlValidator.string(c.like, `${col}.like`),
      );
    } else if ("notLike" in c) {
      builder = builder.whereNot(
        col,
        "like",
        SqlValidator.string(c.notLike, `${col}.notLike`),
      );
    }
    // Arrays
    else if ("in" in c) {
      builder = builder.whereIn(col, SqlValidator.array(c.in, `${col}.in`));
    } else if ("notIn" in c) {
      builder = builder.whereNotIn(
        col,
        SqlValidator.array(c.notIn, `${col}.notIn`),
      );
    }
    // Range
    else if ("between" in c) {
      builder = builder.whereBetween(
        col,
        SqlValidator.tuple(c.between, `${col}.between`),
      );
    }
    // Null checks
    else if ("isNull" in c && c.isNull) {
      builder = builder.whereNull(col);
    } else if ("isNotNull" in c && c.isNotNull) {
      builder = builder.whereNotNull(col);
    }
    // Fallback: unknown object treated as equality
    else {
      builder = builder.where(col, SqlValidator.value(value, col));
    }
  }

  return builder;
}
