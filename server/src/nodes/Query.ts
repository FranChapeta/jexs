import { Knex as KnexType } from "knex";
import { Node, Context, NodeValue, resolve, resolveAll, runSteps } from "@jexs/core";
import { DatabaseNode } from "./Database.js";
import { SchemaNode } from "./Schema.js";
import type { JexsNodeSchema } from "@jexs/core";

const VALID_QUERY_TYPES = new Set(["select","insert","upsert","update","delete","count","create","drop","alter"]);
const WHERE_OPS = new Set(["eq","neq","ne","!=","gt",">","gte",">=","lt","<","lte","<=","like","notLike","in","notIn","between","notBetween","null"]);

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
  schema?: string | TableJsonSchema;
  // Aggregate
  group_concat?: Record<string, string | [string, string]>;
  conflict?: string[];
  // Alter operations
  addColumns?: Record<string, ColumnSchema>;
}

/**
 * SQL/DDL metadata for a column, attached under the `x-db` annotation key so the
 * containing document stays valid JSON Schema (Ajv ignores unknown keywords).
 */
export interface ColumnDbMeta {
  /** SQL column type for DDL (e.g. `varchar`, `biginteger`, `timestamp`).
   *  Falls back to a mapping from the JSON Schema `type` when omitted. */
  sqlType?: string;
  length?: number;
  precision?: number;
  scale?: number;
  primaryKey?: boolean;
  autoIncrement?: boolean;
  unique?: boolean;
  unsigned?: boolean;
  onUpdate?: string;
  default?: string | number | boolean | null;
  comment?: string;
  /** Derive this column from another on insert, e.g. `{ "sha256": "password" }`. */
  computed?: Record<string, string>;
  /** Mask the value in output. */
  secret?: boolean;
}

/**
 * A column definition: a standard JSON Schema property (`type`, `maxLength`,
 * `enum`, `pattern`, `format`, ...) plus optional `x-db` DDL metadata.
 */
export interface ColumnSchema {
  type?: string | string[];
  maxLength?: number;
  enum?: unknown[];
  pattern?: string;
  format?: string;
  default?: unknown;
  "x-db"?: ColumnDbMeta;
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
 * Table-level SQL/DDL metadata, under the `x-db` annotation key.
 */
export interface TableDbMeta {
  table: string;
  indexes?: Record<string, IndexDef>;
  primaryKey?: string[];
  foreignKeys?: Record<string, ForeignKeyDef>;
  options?: {
    engine?: string;
    charset?: string;
    collate?: string;
  };
  /** Per-table step validator run by QueryNode before queries. `false` opts out. */
  validator?: unknown[] | false;
}

/**
 * UI/entity metadata, under the `x-entity` annotation key. Not used by the
 * server runtime; consumed by admin/listing templates.
 */
export interface TableEntityMeta {
  label?: string;
  singular?: string;
  icon?: Record<string, unknown>;
  listColumns?: string[];
  orderBy?: { column: string; direction: string };
  color?: string;
}

/**
 * A table schema authored as a JSON Schema (draft 2020-12) document. The
 * `properties` map defines columns; DDL/runtime metadata live under `x-db`, and
 * UI metadata under `x-entity`, so the document validates as plain JSON Schema.
 */
export interface TableJsonSchema {
  type?: "object";
  required?: string[];
  properties: Record<string, ColumnSchema>;
  "x-db": TableDbMeta;
  "x-entity"?: TableEntityMeta;
  [key: string]: unknown;
}

/** The table name a schema document declares. */
export function tableNameOf(schema: TableJsonSchema): string {
  return schema["x-db"].table;
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
 */
export class QueryNode extends Node {
  static schema: JexsNodeSchema = {
    "query-select": queryMethod(
      "Executes a SELECT query on the given table. Primary value is the table name.",
      "{ \"query-select\": \"users\", \"where\": { \"id\": { \"var\": \"$id\" } }, \"query-first\": true }",
      "any",
      "An array of row objects (each a `{ column: value }` map). With `query-first: true`, the single matching row object or `null`.",
    ),
    "query-insert": queryMethod(
      "Inserts data into the given table. Provide `data` as a row object or an array of rows.",
      "{ \"query-insert\": \"users\", \"data\": { \"name\": \"John\" } }",
      "any",
      "The inserted row's primary key (DB-dependent), or an array of keys when `data` is an array of rows.",
    ),
    "query-upsert": queryMethod(
      "Inserts or updates a row. Use `conflict` to specify the target columns.",
      "{ \"query-upsert\": \"users\", \"data\": { \"id\": 1, \"name\": \"John\" }, \"conflict\": [\"id\"] }",
      "any",
      "The affected row's primary key, or an array of keys when `data` is an array of rows.",
    ),
    "query-update": queryMethod(
      "Updates rows in the given table matching `where`.",
      "{ \"query-update\": \"users\", \"data\": { \"name\": \"Jane\" }, \"where\": { \"id\": 1 } }",
      "number",
      "The number of rows updated.",
    ),
    "query-delete": queryMethod(
      "Deletes rows from the given table matching `where`.",
      "{ \"query-delete\": \"users\", \"where\": { \"id\": 1 } }",
      "number",
      "The number of rows deleted.",
    ),
    "query-count": queryMethod(
      "Counts rows in the given table.",
      "{ \"query-count\": \"users\", \"where\": { \"active\": true } }",
      "number",
      "The matching row count as a number.",
    ),
    "query-create": queryMethod(
      "Creates a table from a registered schema (`query-schema`) or inline column definitions.",
      "{ \"query-create\": \"users\", \"query-schema\": \"schema/users\" }",
      "null",
      "`null` on success; throws on SQL error.",
    ),
    "query-drop": queryMethod(
      "Drops the given table.",
      "{ \"query-drop\": \"users\" }",
      "null",
      "`null` on success; throws on SQL error.",
    ),
    "query-alter": queryMethod(
      "Alters the given table: add columns via `addColumns`.",
      "{ \"query-alter\": \"users\", \"addColumns\": { \"age\": { \"type\": \"integer\" } } }",
      "null",
      "`null` on success; throws on SQL error.",
    ),
  };

  /** Shared siblings across every `query-*` method. Framework auto-creates
   *  `_QueryNodeSiblings` in $defs and $ref's it from each method's byKey
   *  entry — sibling block stored once, not duplicated 9 times. */
  static commonSiblings = {
    table:           { type: "string"  as const, description: "Table name (overrides the primary value)." },
    "query-first":   { type: "boolean" as const, description: "Return a single row instead of an array." },
    connection:      { type: "string"  as const, description: "Named DB connection (default if omitted)." },
    where:           { description: "WHERE clause: `{ column: value }` or nested `or`/`and`." },
    data:            { description: "Row data for `insert`/`upsert`/`update`." },
    orderBy:         { description: "ORDER BY: `{ column: 'asc' | 'desc' }`." },
    "query-groupBy": { description: "GROUP BY column name or array of names." },
    "query-schema":  { description: "Table schema reference (used by `query-create`)." },
    group_concat:    { description: "GROUP_CONCAT aggregate." },
    conflict:        { type: "array"   as const, description: "Conflict target columns for `upsert`." },
    addColumns:      { description: "Columns to add (used by `query-alter`)." },
    columns:         { type: "array"   as const, description: "Columns to select." },
    limit:           { type: "number"  as const, description: "LIMIT N." },
    offset:          { type: "number"  as const, description: "OFFSET N." },
    distinct:        { type: "boolean" as const, description: "SELECT DISTINCT." },
    innerJoin:       { description: "INNER JOIN clauses." },
    leftJoin:        { description: "LEFT JOIN clauses." },
    rightJoin:       { description: "RIGHT JOIN clauses." },
    system:          { type: "boolean" as const, description: "Skip schema validator." },
  };

  ["query-select"](def: Record<string, unknown>, context: Context): Promise<NodeValue> { return this.execQuery("select", def, context); }
  ["query-insert"](def: Record<string, unknown>, context: Context): Promise<NodeValue> { return this.execQuery("insert", def, context); }
  ["query-upsert"](def: Record<string, unknown>, context: Context): Promise<NodeValue> { return this.execQuery("upsert", def, context); }
  ["query-update"](def: Record<string, unknown>, context: Context): Promise<NodeValue> { return this.execQuery("update", def, context); }
  ["query-delete"](def: Record<string, unknown>, context: Context): Promise<NodeValue> { return this.execQuery("delete", def, context); }
  ["query-count"](def: Record<string, unknown>, context: Context): Promise<NodeValue>  { return this.execQuery("count",  def, context); }
  ["query-create"](def: Record<string, unknown>, context: Context): Promise<NodeValue> { return this.execQuery("create", def, context); }
  ["query-drop"](def: Record<string, unknown>, context: Context): Promise<NodeValue>   { return this.execQuery("drop",   def, context); }
  ["query-alter"](def: Record<string, unknown>, context: Context): Promise<NodeValue>  { return this.execQuery("alter",  def, context); }

  private async execQuery(
    op: "select" | "insert" | "upsert" | "update" | "delete" | "count" | "create" | "drop" | "alter",
    def: Record<string, unknown>,
    context: Context,
  ): Promise<NodeValue> {
    // The dispatching key (e.g. "query-select") carries the table name as its
    // value when not explicitly set via the `table` sibling.
    const dispatchKey = `query-${op}`;
    const tableFromDispatch = def[dispatchKey];
    const adjustedDef: Record<string, unknown> = {
      ...def,
      query: op,
      table: def.table ?? tableFromDispatch,
    };

    const connRaw = await resolve(adjustedDef.connection ?? null, context);
    const connectionName = connRaw
      ? String(connRaw)
      : (DatabaseNode.getDefaultConnection() ?? "default");
    const knex = DatabaseNode.getKnex(connectionName);

    const resolvedQuery = await resolveQueryDef(adjustedDef, context);

    if (!adjustedDef.system) await runValidator(resolvedQuery, context);

    const first = adjustedDef["query-first"] === true || resolvedQuery.first === true;

    switch (resolvedQuery.type) {
      case "select":  return executeSelect(knex, resolvedQuery, first) as Promise<NodeValue>;
      case "insert":  return executeInsert(knex, resolvedQuery) as Promise<NodeValue>;
      case "upsert":  return executeUpsert(knex, resolvedQuery) as Promise<NodeValue>;
      case "update":  return executeUpdate(knex, resolvedQuery) as Promise<NodeValue>;
      case "delete":  return executeDelete(knex, resolvedQuery) as Promise<NodeValue>;
      case "count":   return executeCount(knex, resolvedQuery) as Promise<NodeValue>;
      case "create":  return executeCreate(knex, resolvedQuery) as Promise<NodeValue>;
      case "drop":    return executeDrop(knex, resolvedQuery) as Promise<NodeValue>;
      case "alter":   return executeAlter(knex, resolvedQuery) as Promise<NodeValue>;
      default: throw new Error(`Unknown query type: ${resolvedQuery.type}`);
    }
  }
}

/** Helper for the schema literal — keeps the 9 method entries terse.
 *  Common siblings come from `QueryNode.commonSiblings` (framework auto-wires). */
function queryMethod(
  markdown: string,
  example: string,
  output?: "string" | "number" | "boolean" | "array" | "object" | "null" | "any",
  outputDescription?: string,
): import("@jexs/core").JexsMethodSchema {
  return {
    type: "string",
    output,
    outputDescription,
    markdownDescription: markdown,
    examples: [example],
  };
}

/**
 * Run the schema validator before a query executes.
 * Returns a response object to abort, or undefined to continue.
 */
async function runValidator(
  query: QueryDefinition,
  context: Context,
): Promise<void> {
  if (!query.table || (context as Record<string, unknown>).$validating) {
    return;
  }

  const tableSchema = SchemaNode.get(query.table);
  const tableValidator = tableSchema?.["x-db"]?.validator;
  const validator = tableValidator !== undefined ? tableValidator : SchemaNode.globalValidator;

  if (!validator || !Array.isArray(validator)) return;

  const validatorContext: Context = {
    ...context,
    $validating: true,
    schema: tableSchema ?? { "x-db": { table: query.table }, properties: {} },
    operation: query.type === "count" ? "select" : query.type,
  };

  await Promise.resolve(runSteps(validator, validatorContext));
}


/**
 * Resolve a query definition, protecting where/data/orderBy keys (column
 * names) from being matched by nodes like StringNode ("slug", "title", etc.).
 * Uses the schema registry to identify column names.
 */
async function resolveQueryDef(
  def: Record<string, unknown>,
  context: Context,
): Promise<QueryDefinition> {
  const {
    where, data, orderBy, addColumns, group_concat, conflict,
    connection, system, as: _as, query: queryType,
    // Renamed siblings (avoid resolver-key collisions with other Nodes' primaries):
    "query-groupBy": groupBy,
    "query-first":   first,
    "query-schema":  schema,
    ...rest
  } = def;

  const query = validateQuery({ ...rest, query: queryType });

  const tableSchema = query.table ? SchemaNode.get(query.table) : undefined;
  const columns = tableSchema?.properties
    ? new Set(Object.keys(tableSchema.properties))
    : undefined;

  const rd = async (d: unknown) => await resolveColumnValues(d, columns, context) as Record<string, unknown>;

  await Promise.all([
    where
      ? resolveColumnValues(where, columns, context).then(v => { query.where = v as WhereClause; })
      : null,
    data !== undefined
      ? (Array.isArray(data) ? Promise.all(data.map(rd)) : rd(data))
          .then(v => { query.data = v as QueryDefinition["data"]; })
      : null,
    Promise.resolve(resolveAll(
      [orderBy ?? null, groupBy ?? null, schema ?? null, group_concat ?? null, conflict ?? null],
      context,
      ([rOrderBy, rGroupBy, rSchema, rGroupConcat, rConflict]) => {
        if (rOrderBy     !== null) query.orderBy      = rOrderBy     as QueryDefinition["orderBy"];
        if (rGroupBy     !== null) query.groupBy      = rGroupBy     as QueryDefinition["groupBy"];
        if (rSchema      !== null) query.schema       = rSchema      as string | TableJsonSchema;
        if (rGroupConcat !== null) query.group_concat = rGroupConcat as QueryDefinition["group_concat"];
        if (rConflict    !== null) query.conflict     = rConflict    as string[];
        return null;
      },
    )),
  ]);

  if (addColumns) query.addColumns = addColumns as Record<string, ColumnSchema>;

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
function validateQuery(q: Record<string, unknown>): QueryDefinition {
  const type = q.query;
  if (typeof type !== "string" || !VALID_QUERY_TYPES.has(type)) {
    throw new Error(`Invalid query type: "${type}". Must be one of: ${[...VALID_QUERY_TYPES].join(", ")}`);
  }

  q.type = type;

  if (type !== "create" && typeof q.table !== "string") {
    throw new Error("Query must have a table property");
  }

  return q as unknown as QueryDefinition;
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
  for (const [joins, type] of [
    [query.innerJoin, "inner"], [query.leftJoin, "left"], [query.rightJoin, "right"],
  ] as [JoinDefinition[] | undefined, "inner" | "left" | "right"][]) {
    if (joins) builder = applyJoins(builder, joins, type);
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
    const tableName = tableNameOf(schema);
    const db = schema["x-db"];

    try {
      // Check if table exists
      const exists = await knex.schema.hasTable(tableName);
      if (exists) {
        // Auto-detect and add missing columns
        const added = await syncMissingColumns(knex, schema);
        if (added.length > 0) {
          console.log(`[QueryNode] Table ${tableName}: added columns [${added.join(", ")}]`);
        }
        results.push({ table: tableName, created: false });
        continue;
      }

      // Create table
      const required = new Set(schema.required ?? []);
      await knex.schema.createTable(tableName, (table) => {
        buildColumns(table, schema.properties, required, knex);
        if (db.indexes) buildIndexes(table, db.indexes);
        if (db.foreignKeys)
          buildForeignKeys(table, db.foreignKeys);
      });

      console.log(`[QueryNode] Created table: ${tableName}`);
      results.push({ table: tableName, created: true });
    } catch (error) {
      const e = error as Error;
      console.error(
        `[QueryNode] Error creating table ${tableName}:`,
        e.message,
      );
      results.push({ table: tableName, created: false, error: e.message });
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
  schema: TableJsonSchema,
): Promise<string[]> {
  const tableName = tableNameOf(schema);
  const existingCols = await knex(tableName).columnInfo();
  const existingNames = new Set(Object.keys(existingCols));
  const missing: [string, ColumnSchema][] = [];

  for (const [name, col] of Object.entries(schema.properties)) {
    if (!existingNames.has(name)) {
      // Strip non-constant defaults (e.g. CURRENT_TIMESTAMP) — SQLite rejects
      // these on ALTER TABLE. notNull is not applied (empty required set below),
      // since existing rows already have NULL.
      const safeDef: ColumnSchema = { ...col, "x-db": { ...col["x-db"] } };
      const db = safeDef["x-db"]!;
      if (typeof db.default === "string" && /current_timestamp/i.test(db.default)) {
        delete db.default;
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
  const toAdd: Record<string, ColumnSchema> = {};

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
    buildColumns(table, toAdd, new Set(), knex);
  });

  const added = Object.keys(toAdd);
  console.log(`[QueryNode] ALTER ${tableName}: added columns [${added.join(", ")}]`);
  return { table: tableName, added };
}

/**
 * Resolve schema(s) from the registry: "*" for all, or a table name for one.
 */
function resolveSchemas(
  schema: string | TableJsonSchema | undefined,
): TableJsonSchema[] {
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
 * Map a JSON Schema `type` to a SQL column type, used as a fallback when a
 * column omits `x-db.sqlType`. JSON Schema's type vocabulary is coarser than
 * SQL's, so authors needing precise types (varchar vs text, bigint, timestamp)
 * should set `x-db.sqlType`.
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
 * (`type`, `maxLength`) plus `x-db` DDL metadata. NOT NULL is derived from
 * membership in `required`.
 */
function buildColumns(
  table: KnexType.CreateTableBuilder,
  properties: Record<string, ColumnSchema>,
  required: Set<string>,
  knex: KnexType,
): void {
  for (const [name, col] of Object.entries(properties)) {
    const db = col["x-db"] ?? {};
    const sqlType = (db.sqlType ?? jsonTypeToSql(col.type)).toLowerCase();
    const length = col.maxLength ?? db.length ?? 255;
    let column: KnexType.ColumnBuilder;

    switch (sqlType) {
      case "integer":
      case "int":
        column = db.autoIncrement
          ? table.increments(name)
          : table.integer(name);
        break;
      case "biginteger":
      case "bigint":
        column = db.autoIncrement
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
        column = table.float(name, db.precision, db.scale);
        break;
      case "double":
        column = table.double(name, db.precision, db.scale);
        break;
      case "decimal":
        column = table.decimal(name, db.precision ?? 8, db.scale ?? 2);
        break;
      case "varchar":
      case "string":
        column = table.string(name, length);
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
          `[QueryNode] Unknown column type: ${sqlType}, using string`,
        );
        column = table.string(name, length);
    }

    // Apply modifiers
    if (!db.autoIncrement) {
      if (db.primaryKey) column.primary();
      if (db.unsigned) column.unsigned();
    }
    if (required.has(name)) column.notNullable();
    if (db.unique && !db.primaryKey) column.unique();
    const defaultValue = db.default ?? (col.default as string | number | boolean | null | undefined);
    if (defaultValue !== undefined) {
      if (defaultValue === "CURRENT_TIMESTAMP") {
        column.defaultTo(knex.raw("CURRENT_TIMESTAMP"));
      } else {
        column.defaultTo(defaultValue);
      }
    }
    if (db.comment) column.comment(db.comment);
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
  const method = type === "left" ? "leftJoin" : type === "right" ? "rightJoin" : "innerJoin";
  for (const join of joins) {
    const tableName = join.as ? `${join.table} as ${join.as}` : join.table;
    builder = (builder[method] as Function)(tableName, (qb: KnexType.JoinClause) => {
      for (const [left, right] of Object.entries(join.on)) {
        qb.on(left, "=", right);
      }
    });
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
