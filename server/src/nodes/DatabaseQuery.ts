import { Knex as KnexType } from "knex";
import { Node, Context, NodeValue, isOwnedKey, resolveFields, resolverFor, runSteps } from "@jexs/core";
import { DatabaseNode } from "./Database.js";
import { COMPUTE_FNS, DatabaseTableNode, type ColumnSchema, type TableJsonSchema } from "./DatabaseTable.js";
import { requireSchemaNode, validate } from "./Schema.js";
import type { JexsMethodSchema, JexsNodeSchema, JexsOutput, JexsPropertySchema } from "@jexs/core";

const VALID_QUERY_TYPES = new Set(["select", "insert", "upsert", "update", "delete", "count"]);
/** Set on the context a validator runs in, so its own queries skip validation. A symbol, so no template can read or set it. */
const VALIDATING = Symbol("validating");

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
  type: "select" | "insert" | "upsert" | "update" | "delete" | "count";
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
  // Aggregate
  group_concat?: Record<string, string | [string, string]>;
  conflict?: string[];
  // Write-op extras
  /** Atomic `col = col + n` on update. */
  increment?: Record<string, number>;
  /** Atomic `col = col - n` on update. */
  decrement?: Record<string, number>;
  /** Columns to RETURN from insert/upsert/update/delete (SQLite ≥3.35 / Postgres). */
  returning?: string[];
  /** Columns to update on conflict for upsert; omit to merge all. */
  merge?: string[];
  /** INSERT OR IGNORE on conflict. */
  ignore?: boolean;
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
  | { neq?: unknown }
  | { gt?: unknown }
  | { gte?: unknown }
  | { lt?: unknown }
  | { lte?: unknown }
  | { like?: string }
  | { notLike?: string }
  | { in?: unknown[] }
  | { notIn?: unknown[] }
  | { between?: [unknown, unknown] }
  | { isNull?: boolean }
  | { isNotNull?: boolean };

/** The clauses a query op takes as siblings, by name. Declared before the class
 *  so the static schema initializer can read them (a `const` is not hoisted). */
const CLAUSE: Record<string, JexsPropertySchema> = {
  where:        { description: "WHERE clause: `{ column: value }`, an operator object (`{ column: { gt: 1, lt: 5 } }`), and nested `or`/`and` lists of clauses. Every entry must hold, each operator on a column included." },
  data:         { $ref: "#/$defs/_queryRows", description: "Row data: an object, an array of rows, or an expression producing either." },
  orderBy:      { description: "ORDER BY: `{ column: 'asc' | 'desc' }`." },
  groupBy:      { description: "GROUP BY column name or array of names." },
  first:        { type: "boolean", description: "Return a single row instead of an array." },
  columns:      { type: "array", description: "Columns to select (also the column for count distinct)." },
  limit:        { type: "number", description: "LIMIT N." },
  offset:       { type: "number", description: "OFFSET N." },
  distinct:     { type: "boolean", description: "SELECT DISTINCT (with `columns`, COUNT(DISTINCT col) on count)." },
  innerJoin:    { type: "array", description: "INNER JOIN clauses." },
  leftJoin:     { type: "array", description: "LEFT JOIN clauses." },
  rightJoin:    { type: "array", description: "RIGHT JOIN clauses." },
  group_concat: { description: "GROUP_CONCAT aggregate." },
  conflict:     { type: "array", description: "Conflict target columns (upsert)." },
  merge:        { type: "array", description: "Columns to update on conflict (upsert); omit to merge all." },
  ignore:       { type: "boolean", description: "INSERT OR IGNORE on conflict (insert)." },
  returning:    { type: "array", description: "Columns to RETURN (SQLite >=3.35 / Postgres)." },
  increment:    { description: "Atomic increment `{ col: amount }` (update)." },
  decrement:    { description: "Atomic decrement `{ col: amount }` (update)." },
};

/**
 * A value-mode variant: the op's `output` and the clauses it accepts. update and
 * delete resolve to a row count, and to the affected rows instead when
 * `returning` is present, so there `returning` is a presence variant.
 */
function op(output: JexsOutput, markdown: string, clauses: string[], rowsWhenReturning = false): JexsMethodSchema {
  const siblings = Object.fromEntries(clauses.map(k => [k, CLAUSE[k]]));
  if (!rowsWhenReturning) return { output, markdownDescription: markdown, siblings };
  return {
    output, markdownDescription: markdown, siblings,
    variants: { returning: { ...CLAUSE.returning, output: "array", outputDescription: "The affected rows." } },
  };
}

export class DatabaseQueryNode extends Node {
  /** The steps `{ "$query": "validator" }` set, run before every query. An
   *  instance field, so one resolver's policy never judges another's queries. */
  globalValidator: unknown = null;

  static schemaDefs: Record<string, Record<string, unknown>> = {
    // `data` resolves whole, so an expression is one more object here.
    _queryRows: { anyOf: [{ type: "object" }, { type: "array", items: { type: "object" } }] },
  };

  static schema: JexsNodeSchema = {
    query: {
      type: "string",
      enum: ["select", "insert", "upsert", "update", "delete", "count", "validator"],
      markdownDescription: "Reads and writes a table's rows. The value is the operation; `table` is the target and the op's clauses (`where`, `data`, `first`, ...) sit beside it. A write to a table with a registered document (see `$table`) is checked against it.",
      examples: [
        "{ \"$query\": \"select\", \"table\": \"users\", \"where\": { \"id\": { \"$var\": \"id\" } }, \"first\": true }",
      ],
      siblings: {
        table:      { type: "string",  description: "Target table." },
        connection: { type: "string",  description: "Named database connection (default if omitted)." },
        system:     { type: "boolean", description: "Skip the validators: for the app's own queries, which have no request to authorize." },
      },
      variants: {
        select: op("any", "Reads rows. Returns an array (or the single row / `null` with `first`).",
          ["where", "orderBy", "groupBy", "first", "columns", "limit", "offset", "distinct", "innerJoin", "leftJoin", "rightJoin", "group_concat"]),
        insert: op("any", "Inserts `data` (object or array of rows). Returns the PK(s), or the rows with `returning`.",
          ["data", "ignore", "returning"]),
        upsert: op("any", "Inserts or updates on `conflict`. `merge` limits which columns update.",
          ["data", "conflict", "merge", "returning"]),
        update: op("number", "Updates matching rows. `increment`/`decrement` apply atomic deltas. Returns the row count (or rows with `returning`).",
          ["where", "data", "increment", "decrement"], true),
        delete: op("number", "Deletes matching rows (requires `where`). Returns the row count (or rows with `returning`).",
          ["where"], true),
        count:  op("number", "Counts matching rows; supports joins and `distinct` + `columns`.",
          ["where", "distinct", "columns", "innerJoin", "leftJoin", "rightJoin"]),
        validator: {
          output: "null",
          markdownDescription: "Sets the global validator: steps run before every query on every table to authorize it. They see `operation`, the table's document as `schema`, and `query` (`table`, `where`, `data`, ...), which they may narrow. Refuse with `{ \"$error\": 403 }`. A table document's own `validator` runs after this one, never instead of it. Queries with `system: true` skip both.",
          siblings: {
            do: { steps: true, description: "Steps run before each query." },
          },
        },
      },
    },
  };

  query(def: Record<string, unknown>, context: Context): NodeValue {
    if (def.$query === "validator") {
      this.globalValidator = def.do ?? null;
      return null;
    }
    return execQuery(def, context);
  }
}

async function execQuery(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
  // Every clause is a sibling holding plain data (column names, `where`
  // operators, row keys), so the step resolves in one pass.
  const r = await resolveFields(def, context, r => r);
  const query = toQuery(r);
  // Omitted `connection` falls back to whichever opened first; getKnex owns
  // that chain, so this does not repeat it.
  const knex = DatabaseNode.getKnex(context, r.connection);

  if (!r.system) await runValidators(query, context);

  switch (query.type) {
    case "select":  return executeSelect(knex, query, query.first === true) as Promise<NodeValue>;
    case "insert":  return executeInsert(knex, query, context) as Promise<NodeValue>;
    case "upsert":  return executeUpsert(knex, query, context) as Promise<NodeValue>;
    case "update":  return executeUpdate(knex, query, context) as Promise<NodeValue>;
    case "delete":  return executeDelete(knex, query) as Promise<NodeValue>;
    case "count":   return executeCount(knex, query) as Promise<NodeValue>;
  }
}

/** The table's document, or a stand-in when it is not registered, so the
 *  global validator still sees the table name. */
function documentOf(query: QueryDefinition, context: Context): TableJsonSchema {
  return DatabaseTableNode.get(context, query.table!) ?? { table: query.table!, properties: {} };
}

/**
 * Run the validators before a query executes: the global validator, then the
 * table's own `validator`, so a table can add checks but never lift the
 * app-wide ones. They see the table document as `schema`, the operation as
 * `operation` and the query itself as `query`, which they may narrow (e.g. add
 * an owner to `where`) since this is the object that runs. A validator refuses
 * by throwing (`{ "$error": 403 }`).
 */
async function runValidators(query: QueryDefinition, context: Context): Promise<void> {
  if (Reflect.get(context, VALIDATING) === true) return;
  const operation = query.type === "count" ? "select" : query.type;
  // The resolver's own node holds its global validator.
  const node = resolverFor(context).nodeFor("query");
  const global = node instanceof DatabaseQueryNode ? node.globalValidator : null;
  const schema = documentOf(query, context);
  const own = schema.validator;
  if (global == null && own == null) return;
  // A copy: a validator may narrow the query, but the registered document
  // stays as registered.
  const validatorContext: Context & { [VALIDATING]: true } = {
    ...context, [VALIDATING]: true, schema: structuredClone(schema), query, operation,
  };
  for (const steps of [global, own]) {
    if (steps != null) await runSteps(steps, validatorContext);
  }
}

/** The resolved step as the QueryDefinition the execute* helpers consume: its clauses, without the resolver's `$` keys or the `connection` and `system` settings. */
function toQuery(r: Record<string, unknown>): QueryDefinition {
  const type = r.$query;
  if (typeof type !== "string" || !VALID_QUERY_TYPES.has(type)) {
    throw new Error(`Invalid query type: "${type}". Must be one of: ${[...VALID_QUERY_TYPES].join(", ")}`);
  }
  if (typeof r.table !== "string") {
    throw new Error("Query must have a table property");
  }
  const query: Record<string, unknown> = { type };
  for (const [k, v] of Object.entries(r)) {
    if (!isOwnedKey(k) && k !== "connection" && k !== "system") query[k] = v;
  }
  return query as unknown as QueryDefinition;
}

// ── The rows a write sends, prepared by the table's document ─────────────────

/** Copies of table documents without `required`, to validate partial updates. */
const updateSchemas = new WeakMap<TableJsonSchema, object>();

/**
 * The row or rows an insert or upsert writes. With a registered document for
 * the table, each row keeps only its columns, gets its `computed` ones filled
 * and its auto-increment ones dropped, has its values coerced, and must be
 * valid; without one, the data is written as given.
 */
function rowsToWrite(context: Context, tableName: string, data: unknown): unknown {
  const schema = DatabaseTableNode.get(context, tableName);
  if (!schema) return data;
  return Array.isArray(data)
    ? data.map(row => rowToWrite(context, schema, row as Record<string, unknown>))
    : rowToWrite(context, schema, data as Record<string, unknown>);
}

function rowToWrite(context: Context, schema: TableJsonSchema, row: Record<string, unknown>): Record<string, unknown> {
  const props = schema.properties;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    if (key in props) result[key] = row[key];
  }

  for (const [colName, col] of Object.entries(props)) {
    if (col.computed && result[colName] === undefined) {
      // Read source values from the original row: a computed column's source
      // (e.g. a plaintext password) is often not itself a stored column.
      fillComputed(result, row, colName, col.computed);
    }

    if (col.autoIncrement) {
      delete result[colName];
      continue;
    }

    if (result[colName] !== undefined) {
      result[colName] = coerceType(result[colName], col, colName, schema.table);
    }
  }

  assertValid(context, schema, result, schema.table);
  return result;
}

/**
 * The changes an update writes, prepared as a row is, except that only the
 * columns given are checked: `required` does not apply to a partial update, and
 * computed, auto-increment and timestamp columns are left to the database.
 */
function changesToWrite(context: Context, tableName: string, data: Record<string, unknown>): Record<string, unknown> {
  const schema = DatabaseTableNode.get(context, tableName);
  if (!schema) return data;
  const props = schema.properties;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!(key in props)) continue;
    const col = props[key];
    if (col.autoIncrement || col.computed) continue;
    if (coercionType(col) === "timestamp") continue;
    result[key] = coerceType(value, col, key, tableName);
  }

  let partial = updateSchemas.get(schema);
  if (!partial) {
    const { required: _required, ...rest } = schema;
    partial = rest;
    updateSchemas.set(schema, partial);
  }
  assertValid(context, partial, result, tableName);
  return result;
}

function assertValid(context: Context, schema: object, row: Record<string, unknown>, tableName: string): void {
  const { valid, errors } = validate(requireSchemaNode(context), schema, row);
  if (!valid) {
    throw new Error(`[Schema] Validation failed for "${tableName}": ${errors.join("; ")}`);
  }
}

function fillComputed(
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
function coercionType(col: ColumnSchema): string {
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
function coerceType(value: unknown, col: ColumnSchema, colName: string, tableName: string): unknown {
  switch (coercionType(col)) {
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
  context: Context,
): Promise<unknown> {
  if (!query.table) throw new Error("Query requires a table name");
  if (!query.data) {
    throw new Error("INSERT query requires data");
  }

  // Validate and enrich data (computed columns, type coercion)
  const data = rowsToWrite(context, query.table!, query.data);

  let builder = knex(query.table).insert(data);
  if (query.ignore) builder = builder.onConflict().ignore();
  if (query.returning) builder = builder.returning(query.returning);

  const result = await builder;
  if (query.returning) return result;
  return Array.isArray(query.data) ? result : (result as number[])[0];
}

/**
 * Execute an UPSERT query (INSERT ... ON CONFLICT ... DO UPDATE)
 */
async function executeUpsert(
  knex: KnexType,
  query: QueryDefinition,
  context: Context,
): Promise<unknown> {
  if (!query.table) throw new Error("Query requires a table name");
  if (!query.data) {
    throw new Error("UPSERT query requires data");
  }
  if (!query.conflict || !query.conflict.length) {
    throw new Error("UPSERT query requires conflict columns");
  }

  const data = rowsToWrite(context, query.table!, query.data);

  // `merge` (subset of columns) lets the conflict update touch only some columns
  // — e.g. keep `created_at` intact; omit to merge every inserted column.
  let builder = knex(query.table)
    .insert(data)
    .onConflict(query.conflict)
    .merge(query.merge && query.merge.length ? query.merge : undefined);
  if (query.returning) builder = builder.returning(query.returning);

  const result = await builder;
  if (query.returning) return result;
  return Array.isArray(query.data) ? result : (result as number[])[0];
}

/**
 * Execute an UPDATE query
 */
async function executeUpdate(
  knex: KnexType,
  query: QueryDefinition,
  context: Context,
): Promise<unknown> {
  if (!query.table) throw new Error("Query requires a table name");
  const hasDelta = !!(query.increment || query.decrement);
  if ((!query.data || Array.isArray(query.data)) && !hasDelta) {
    throw new Error("UPDATE query requires a data object or increment/decrement");
  }

  // Validate and filter data (strip unknown columns, coerce types).
  const data: Record<string, unknown> = query.data && !Array.isArray(query.data)
    ? changesToWrite(context, query.table!, query.data as Record<string, unknown>)
    : {};

  // Atomic deltas: `col = col +/- n`, applied as raw after validation so they
  // bypass type coercion (the value is an expression, not a literal).
  for (const [col, amt] of Object.entries(query.increment ?? {})) {
    data[col] = knex.raw("?? + ?", [col, Number(amt)]);
  }
  for (const [col, amt] of Object.entries(query.decrement ?? {})) {
    data[col] = knex.raw("?? - ?", [col, Number(amt)]);
  }

  let builder = knex(query.table);
  if (query.where) {
    builder = applyWhere(builder, query.where);
  }

  return query.returning ? builder.update(data, query.returning) : builder.update(data);
}

/**
 * Execute a DELETE query
 */
async function executeDelete(
  knex: KnexType,
  query: QueryDefinition,
): Promise<unknown> {
  if (!query.table) throw new Error("Query requires a table name");
  let builder = knex(query.table);

  if (query.where) {
    builder = applyWhere(builder, query.where);
  } else {
    // Safety: require WHERE clause for DELETE
    throw new Error("DELETE query requires a WHERE clause");
  }

  return query.returning ? builder.delete(query.returning) : builder.delete();
}

/**
 * Execute a COUNT query
 */
async function executeCount(
  knex: KnexType,
  query: QueryDefinition,
): Promise<number> {
  let builder = knex(query.table!);

  // Joins (valid on every driver for count).
  for (const [joins, type] of [
    [query.innerJoin, "inner"], [query.leftJoin, "left"], [query.rightJoin, "right"],
  ] as [JoinDefinition[] | undefined, "inner" | "left" | "right"][]) {
    if (joins) builder = applyJoins(builder, joins, type);
  }

  // `distinct` + `columns` → COUNT(DISTINCT col); otherwise COUNT(*).
  builder = query.distinct && query.columns && query.columns.length > 0
    ? builder.countDistinct(`${query.columns[0]} as count`)
    : builder.count("* as count");

  if (query.where) {
    builder = applyWhere(builder, query.where);
  }

  const result = await builder.first();
  return Number((result as { count: number })?.count || 0);
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
 * Apply a WHERE clause. Every entry must hold: each column, each operator on a
 * column, and an `or` or `and` group beside them, as Mongo, Prisma and
 * Sequelize read one object.
 */
function applyWhere(
  builder: KnexType.QueryBuilder,
  where: WhereClause,
): KnexType.QueryBuilder {
  for (const [key, value] of Object.entries(where)) {
    if (key === "or" || key === "and") {
      if (!Array.isArray(value)) throw new Error(`where.${key}: expected an array of clauses`);
      const groups = value as WhereClause[];
      builder = builder.where((qb) => {
        for (const cond of groups) {
          if (key === "or") qb.orWhere((sub) => applyWhere(sub, cond));
          else qb.andWhere((sub) => applyWhere(sub, cond));
        }
      });
    } else {
      builder = applyColumn(builder, key, value);
    }
  }
  return builder;
}

/** Comparison operators by name, and the SQL each is. */
const COMPARISONS: Record<string, string> = {
  eq: "=",
  neq: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

/** Apply one column's condition: a value for equality, or an object of operators. */
function applyColumn(
  builder: KnexType.QueryBuilder,
  col: string,
  value: WhereValue,
): KnexType.QueryBuilder {
  if (value === null) return builder.whereNull(col);
  if (typeof value !== "object" || value instanceof Date) {
    return builder.where(col, SqlValidator.value(value, col));
  }

  for (const [op, operand] of Object.entries(value as Record<string, unknown>)) {
    const at = `${col}.${op}`;
    const comparison = COMPARISONS[op];
    if (comparison === "!=") builder = builder.whereNot(col, SqlValidator.value(operand, at));
    else if (comparison) builder = builder.where(col, comparison, SqlValidator.value(operand, at));
    else if (op === "like") builder = builder.whereLike(col, SqlValidator.string(operand, at));
    else if (op === "notLike") builder = builder.whereNot(col, "like", SqlValidator.string(operand, at));
    else if (op === "in") builder = builder.whereIn(col, SqlValidator.array(operand, at));
    else if (op === "notIn") builder = builder.whereNotIn(col, SqlValidator.array(operand, at));
    else if (op === "between") builder = builder.whereBetween(col, SqlValidator.tuple(operand, at));
    else if (op === "isNull" || op === "isNotNull") {
      const isNull = (op === "isNull") === Boolean(operand);
      builder = isNull ? builder.whereNull(col) : builder.whereNotNull(col);
    } else {
      throw new Error(`${col}: unknown operator "${op}"`);
    }
  }
  return builder;
}
