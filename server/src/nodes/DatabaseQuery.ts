import { Knex as KnexType } from "knex";
import { Node, Context, NodeValue, isOwnedKey, resolveFields, runSteps } from "@jexs/core";
import { DatabaseNode } from "./Database.js";
import { COMPUTE_FNS, DatabaseTableNode, type ColumnSchema, type TableJsonSchema } from "./DatabaseTable.js";
import { requireSchemaNode, validate } from "./Schema.js";
import type { JexsMethodSchema, JexsNodeSchema, JexsOutput, JexsPropertySchema } from "@jexs/core";

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
  table: string;
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
 * A query op, valued by its table: its `output` and the clauses it accepts. update
 * and delete resolve to a row count, and to the affected rows instead when
 * `returning` is present, so there `returning` is a presence variant.
 */
function op(output: JexsOutput, markdown: string, example: string, clauses: string[], rowsWhenReturning = false): JexsMethodSchema {
  const schema: JexsMethodSchema = {
    type: "string", output, markdownDescription: markdown, examples: [example],
    siblings: Object.fromEntries(clauses.map(k => [k, CLAUSE[k]])),
  };
  if (rowsWhenReturning) {
    schema.variants = { returning: { ...CLAUSE.returning, output: "array", outputDescription: "The affected rows." } };
  }
  return schema;
}

export class DatabaseQueryNode extends Node {
  static commonSiblings: Record<string, JexsPropertySchema> = {
    connection: { type: "string", description: "Named database connection (default if omitted)." },
    system: { type: "boolean", description: "For the app's own queries, which have no request to authorize: skip the connection's validators, and allow the database's own catalog (`information_schema`, `pg_catalog`, `sqlite_master`, ...), which other queries are refused." },
  };

  static schemaDefs: Record<string, Record<string, unknown>> = {
    // `data` resolves whole, so an expression is one more object here.
    _queryRows: { anyOf: [{ type: "object" }, { type: "array", items: { type: "object" } }] },
  };

  static schema: JexsNodeSchema = {
    querySelect: op("any", "Reads rows from the table the value names. Returns an array, or with `first` the single row (`null` when none matches).",
      "{ \"$querySelect\": \"users\", \"where\": { \"id\": { \"$var\": \"id\" } }, \"first\": true }",
      ["where", "orderBy", "groupBy", "first", "columns", "limit", "offset", "distinct", "innerJoin", "leftJoin", "rightJoin", "group_concat"]),
    queryInsert: op("any", "Inserts `data` (a row or an array of rows) into the table the value names, checked against the table's registered document if it has one (see `$tableCreate`). Returns the new primary key (or keys), or the rows with `returning`.",
      "{ \"$queryInsert\": \"users\", \"data\": { \"name\": { \"$var\": \"name\" } } }",
      ["data", "ignore", "returning"]),
    queryUpsert: op("any", "Inserts `data`, or updates the row with the same `conflict` columns; `merge` limits which columns update. Checked like `$queryInsert`.",
      "{ \"$queryUpsert\": \"settings\", \"data\": { \"key\": \"theme\", \"value\": \"dark\" }, \"conflict\": [\"key\"] }",
      ["data", "conflict", "merge", "returning"]),
    queryUpdate: op("number", "Updates the rows that match `where` in the table the value names, checked against the table's registered document if it has one. `increment`/`decrement` apply atomic deltas. Returns the row count, or the rows with `returning`.",
      "{ \"$queryUpdate\": \"posts\", \"where\": { \"id\": 1 }, \"increment\": { \"views\": 1 } }",
      ["where", "data", "increment", "decrement"], true),
    queryDelete: op("number", "Deletes the rows that match `where`, which it requires, from the table the value names. Returns the row count, or the rows with `returning`.",
      "{ \"$queryDelete\": \"sessions\", \"where\": { \"id\": { \"$var\": \"id\" } } }",
      ["where"], true),
    queryCount: op("number", "Counts the rows that match `where` in the table the value names. Supports joins, and `distinct` with `columns` counts distinct values.",
      "{ \"$queryCount\": \"users\", \"where\": { \"active\": true } }",
      ["where", "distinct", "columns", "innerJoin", "leftJoin", "rightJoin"]),
  };

  querySelect(def: Record<string, unknown>, context: Context): NodeValue {
    return runQuery("select", def, context, async (knex, query) => {
      let builder = knex(query.table);
      if (query.distinct) builder = builder.distinct();
      builder = builder.select(query.columns && query.columns.length > 0 ? query.columns : "*");
      for (const [alias, colDef] of Object.entries(query.group_concat ?? {})) {
        const [col, sep] = Array.isArray(colDef) ? colDef : [colDef, ","];
        builder = builder.select(knex.raw("GROUP_CONCAT(??, ?) as ??", [col, sep, alias]));
      }
      builder = applyJoins(builder, query);
      if (query.where) builder = applyWhere(builder, query.where);
      if (query.groupBy) builder = builder.groupBy(Array.isArray(query.groupBy) ? query.groupBy : [query.groupBy]);
      for (const [column, direction] of Object.entries(query.orderBy ?? {})) {
        builder = builder.orderBy(column, direction.toLowerCase() as "asc" | "desc");
      }
      if (query.limit) builder = builder.limit(query.limit);
      if (query.offset) builder = builder.offset(query.offset);
      if (query.first) return (await builder.first()) || null;
      return builder;
    });
  }

  queryInsert(def: Record<string, unknown>, context: Context): NodeValue {
    return runQuery("insert", def, context, async (knex, query) => {
      if (!query.data) throw new Error("$queryInsert needs `data`");
      let builder = knex(query.table).insert(rowsToWrite(context, query.table, query.data));
      if (query.ignore) builder = builder.onConflict().ignore();
      if (query.returning) builder = builder.returning(query.returning);
      const result = await builder;
      if (query.returning) return result;
      return Array.isArray(query.data) ? result : (result as number[])[0];
    });
  }

  queryUpsert(def: Record<string, unknown>, context: Context): NodeValue {
    return runQuery("upsert", def, context, async (knex, query) => {
      if (!query.data) throw new Error("$queryUpsert needs `data`");
      if (!query.conflict || !query.conflict.length) throw new Error("$queryUpsert needs `conflict` columns");
      // `merge` (a subset of columns) lets the conflict update touch only some
      // columns, e.g. keep `created_at` intact; omit it to merge every inserted column.
      let builder = knex(query.table)
        .insert(rowsToWrite(context, query.table, query.data))
        .onConflict(query.conflict)
        .merge(query.merge && query.merge.length ? query.merge : undefined);
      if (query.returning) builder = builder.returning(query.returning);
      const result = await builder;
      if (query.returning) return result;
      return Array.isArray(query.data) ? result : (result as number[])[0];
    });
  }

  queryUpdate(def: Record<string, unknown>, context: Context): NodeValue {
    return runQuery("update", def, context, (knex, query) => {
      const changes = query.data;
      if ((!changes || Array.isArray(changes)) && !query.increment && !query.decrement) {
        throw new Error("$queryUpdate needs a `data` object, or `increment`/`decrement`");
      }
      const data = changes && !Array.isArray(changes) ? changesToWrite(context, query.table, changes) : {};
      // Atomic deltas: `col = col +/- n`, applied as raw after validation so they
      // bypass type coercion (the value is an expression, not a literal).
      for (const [col, amt] of Object.entries(query.increment ?? {})) {
        data[col] = knex.raw("?? + ?", [col, Number(amt)]);
      }
      for (const [col, amt] of Object.entries(query.decrement ?? {})) {
        data[col] = knex.raw("?? - ?", [col, Number(amt)]);
      }
      let builder = knex(query.table);
      if (query.where) builder = applyWhere(builder, query.where);
      return query.returning ? builder.update(data, query.returning) : builder.update(data);
    });
  }

  queryDelete(def: Record<string, unknown>, context: Context): NodeValue {
    return runQuery("delete", def, context, (knex, query) => {
      if (!query.where) throw new Error("$queryDelete needs `where`");
      const builder = applyWhere(knex(query.table), query.where);
      return query.returning ? builder.delete(query.returning) : builder.delete();
    });
  }

  queryCount(def: Record<string, unknown>, context: Context): NodeValue {
    return runQuery("count", def, context, async (knex, query) => {
      let builder = applyJoins(knex(query.table), query);
      // `distinct` with `columns` is COUNT(DISTINCT col); otherwise COUNT(*).
      builder = query.distinct && query.columns && query.columns.length > 0
        ? builder.countDistinct(`${query.columns[0]} as count`)
        : builder.count("* as count");
      if (query.where) builder = applyWhere(builder, query.where);
      const result = await builder.first();
      return Number((result as { count: number } | undefined)?.count || 0);
    });
  }
}

/** Schemas, and table name prefixes, that hold a database's own catalog. */
const CATALOG_SCHEMAS = new Set(["information_schema", "pg_catalog", "pg_toast", "mysql", "performance_schema", "sys"]);
const CATALOG_TABLE = /^(sqlite_|pg_|pragma_)/;

/** Whether a table name, as knex reads it (`schema.table`, perhaps `as alias`), is part of the catalog. */
function isCatalog(name: string): boolean {
  const parts = name.split(/\s+as\s+/i)[0].trim().toLowerCase().split(".");
  return parts.slice(0, -1).some(p => CATALOG_SCHEMAS.has(p)) || CATALOG_TABLE.test(parts[parts.length - 1]);
}

/**
 * Run a query op: resolve the step into its query (the op's value as `table`,
 * beside its clauses, without the `connection` and `system` settings), refuse
 * the catalog and have the connection's validators check it unless the step is
 * `system`, then `run` it.
 */
async function runQuery(
  type: QueryDefinition["type"], def: Record<string, unknown>, context: Context,
  run: (knex: KnexType, query: QueryDefinition) => unknown,
): Promise<unknown> {
  // Every clause is a sibling holding plain data (column names, `where`
  // operators, row keys), so the step resolves in one pass.
  const r = await resolveFields(def, context, r => r);
  const op = `$query${type[0].toUpperCase()}${type.slice(1)}`;
  const table = r[op];
  if (typeof table !== "string") throw new Error(`${op} takes a table name, got ${typeof table}`);
  const fields: Record<string, unknown> = { type };
  for (const [k, v] of Object.entries(r)) {
    if (!isOwnedKey(k) && k !== "connection" && k !== "system") fields[k] = v;
  }
  fields.table = table;
  const query = fields as unknown as QueryDefinition;
  // Omitted `connection` falls back to whichever opened first; getKnex owns
  // that chain, so this does not repeat it.
  const knex = DatabaseNode.getKnex(context, r.connection);
  if (!r.system) {
    const joined = [query.innerJoin, query.leftJoin, query.rightJoin].flatMap(joins => joins ?? []).map(join => join.table);
    for (const name of [table, ...joined]) {
      if (typeof name !== "string") throw new Error(`${op}: a join's \`table\` must be a table name`);
      if (isCatalog(name)) throw new Error(`${op}: "${name}" is the database's own catalog, which only a step with \`system: true\` may query`);
    }
    await runValidators(query, r.connection, context);
  }
  return run(knex, query);
}

/**
 * Run the validators before a query executes: the connection's `rows`, then
 * the table's own `validator`, so a table can add checks but never lift the
 * connection's. They see the table document as `schema`, the operation as
 * `operation` and the query itself as `query`, which they may narrow (e.g. add
 * an owner to `where`) since this is the object that runs. A validator refuses
 * by throwing (`{ "$error": 403 }`).
 */
async function runValidators(query: QueryDefinition, connection: unknown, context: Context): Promise<void> {
  if (Reflect.get(context, VALIDATING) === true) return;
  const operation = query.type === "count" ? "select" : query.type;
  const global = DatabaseNode.validators(context, connection).rows;
  // A stand-in for a table with no registered document, so the connection's
  // validator still sees the table's name.
  const schema: TableJsonSchema = DatabaseTableNode.get(context, query.table) ?? { table: query.table, properties: {} };
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

/** Apply the query's `innerJoin`, `leftJoin` and `rightJoin` clauses. */
function applyJoins(builder: KnexType.QueryBuilder, query: QueryDefinition): KnexType.QueryBuilder {
  for (const method of ["innerJoin", "leftJoin", "rightJoin"] as const) {
    for (const join of query[method] ?? []) {
      const tableName = join.as ? `${join.table} as ${join.as}` : join.table;
      builder = builder[method](tableName, qb => {
        for (const [left, right] of Object.entries(join.on)) qb.on(left, "=", right);
      });
    }
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
