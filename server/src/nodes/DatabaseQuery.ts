import { Knex as KnexType } from "knex";
import { Node, Context, NodeValue, isObject, isOwnedKey, resolveFields } from "@jexs/core";
import { DatabaseNode, authorizeRows } from "./Database.js";
import { COMPUTE_FNS, DatabaseTableNode, type ColumnSchema, type TableJsonSchema } from "./DatabaseTable.js";
import type { ViewJsonSchema } from "./DatabaseView.js";
import { isViewDocument, requireSchemaNode, validate, viewId } from "./Schema.js";
import type { JexsMethodSchema, JexsNodeSchema, JexsOutput, JexsPropertySchema } from "@jexs/core";

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
  /** What a select gives: columns by name, or expressions by the name each gives. */
  columns?: string[] | Record<string, ColumnExpression>;
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

/** A value computed from a row: a column, a number, null, or one operator over expressions. */
export type ColumnExpression = string | number | null | { [operator: string]: ColumnExpression[] };

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
  | { isNull?: boolean };

/** The operators an expression may use, named as core's math ops, and the
 *  fewest and most operands each takes. */
const OPERATOR_ARITY: Record<string, [number, number]> = {
  add: [2, Infinity], subtract: [2, Infinity], multiply: [2, Infinity], divide: [2, Infinity],
  abs: [1, 1], floor: [1, 1], ceil: [1, 1], round: [1, 2], upper: [1, 1], lower: [1, 1], coalesce: [2, Infinity],
  sum: [1, 1], avg: [1, 1], min: [1, 1], max: [1, 1], count: [1, 1],
  sumDistinct: [1, 1], avgDistinct: [1, 1], countDistinct: [1, 1], join: [1, 2],
};
const ARITHMETIC: Record<string, string> = { add: "+", subtract: "-", multiply: "*", divide: "/" };
/** The operators that are a SQL function of their one operand. */
const SCALAR: Record<string, string> = { abs: "ABS", floor: "FLOOR", ceil: "CEIL", upper: "UPPER", lower: "LOWER" };
/** The aggregate operators, and the SQL call each opens. */
const AGGREGATE: Record<string, string> = {
  sum: "SUM(", avg: "AVG(", min: "MIN(", max: "MAX(", count: "COUNT(",
  sumDistinct: "SUM(DISTINCT ", avgDistinct: "AVG(DISTINCT ", countDistinct: "COUNT(DISTINCT ",
};

/** The clauses a query op takes as siblings, by name. Declared before the class
 *  so the static schema initializer can read them (a `const` is not hoisted). */
const CLAUSE: Record<string, JexsPropertySchema> = {
  where:        { description: "WHERE clause: `{ column: value }`, an operator object (`{ column: { gt: 1, lt: 5 } }`), and nested `or`/`and` lists of clauses. Every entry must hold, each operator on a column included. The operators are `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `notLike`, `in`, `notIn`, `between` and `isNull` (`isNull: false` for NOT NULL)." },
  data:         { $ref: "#/$defs/_queryRows", description: "Row data: an object, an array of rows, or an expression producing either." },
  orderBy:      { description: "ORDER BY: `{ column: 'asc' | 'desc' }`." },
  groupBy:      { description: "GROUP BY column name or array of names." },
  first:        { type: "boolean", description: "Return a single row instead of an array." },
  columns:      { $ref: "#/$defs/_selectColumns", description: "What to select: an array of columns by name (`[\"id\", \"users.name as author\"]`), or an object of expressions by the name each gives (`{ \"author\": \"users.name\", \"net\": { \"subtract\": [\"amount\", \"refunded\"] } }`). An expression is a column name, a number, `null`, or one operator over expressions: `add`, `subtract`, `multiply`, `divide`, `abs`, `floor`, `ceil`, `round` (`[value, digits]`), `upper`, `lower`, `coalesce`, and per group `sum`, `avg`, `min`, `max`, `count` (`[\"*\"]` counts rows; counts are always numbers), `sumDistinct`, `avgDistinct`, `countDistinct` and `join` (the group's values in one string, `[value, separator]`, the separator a string, `,` by default). A string from a step names a column and a number is a value, so a step can pick the columns. Dividing integer columns gives an integer on SQLite and PostgreSQL. On count with `distinct`, the array's first column is the one COUNT(DISTINCT) counts." },
  limit:        { type: "number", description: "LIMIT N." },
  offset:       { type: "number", description: "OFFSET N." },
  distinct:     { type: "boolean", description: "SELECT DISTINCT (with `columns`, COUNT(DISTINCT col) on count)." },
  innerJoin:    { type: "array", description: "INNER JOIN clauses." },
  leftJoin:     { type: "array", description: "LEFT JOIN clauses." },
  rightJoin:    { type: "array", description: "RIGHT JOIN clauses." },
  conflict:     { type: "array", description: "Conflict target columns (upsert)." },
  merge:        { type: "array", description: "Columns to update on conflict (upsert); omit to merge all." },
  ignore:       { type: "boolean", description: "INSERT OR IGNORE on conflict (insert)." },
  returning:    { type: "array", description: "Columns to RETURN (SQLite >=3.35 / Postgres)." },
  increment:    { description: "Atomic increment `{ col: amount }` (update)." },
  decrement:    { description: "Atomic decrement `{ col: amount }` (update)." },
};

/**
 * A query op, valued by its table: its `output` and the clauses it accepts. An
 * op that changes existing rows (update, delete) requires `where`, and resolves
 * to a row count, or to the affected rows instead when `returning` is present,
 * so there `returning` is a presence variant.
 */
function op(output: JexsOutput, markdown: string, example: string, clauses: string[], changesRows = false): JexsMethodSchema {
  const siblings: Record<string, JexsPropertySchema> = Object.fromEntries(clauses.map(k => [k, CLAUSE[k]]));
  const schema: JexsMethodSchema = { type: "string", output, markdownDescription: markdown, examples: [example], siblings };
  if (changesRows) {
    siblings.where = { ...CLAUSE.where, required: true };
    schema.variants = { returning: { ...CLAUSE.returning, output: "array", outputDescription: "The affected rows." } };
  }
  return schema;
}

export class DatabaseQueryNode extends Node {
  static commonSiblings: Record<string, JexsPropertySchema> = {
    connection: { type: "string", description: "Named database connection (default if omitted)." },
  };

  static schemaDefs: Record<string, Record<string, unknown>> = {
    // `data` resolves whole, so an expression is one more object here.
    _queryRows: { anyOf: [{ type: "object" }, { type: "array", items: { type: "object" } }] },
    // A select's columns: an array of names, or an object of expressions by
    // name. An object with a `$` key is a step producing either, in a query op
    // that resolves its clauses.
    _selectColumns: {
      if: { type: "object", propertyNames: { not: { pattern: "^\\$" } } },
      then: { additionalProperties: { $ref: "#/$defs/_columnExpression" } },
      else: { anyOf: [{ type: "array", items: { anyOf: [{ type: "string" }, { $ref: "#/$defs/exprFlat" }] } }, { $ref: "#/$defs/exprFlat" }] },
    },
    // An object with no `$` key is one operator; one with a `$` key is a step
    // producing an expression.
    _columnExpression: {
      anyOf: [
        { type: ["string", "number", "null"] },
        {
          if: { type: "object", propertyNames: { not: { pattern: "^\\$" } } },
          then: {
            minProperties: 1,
            maxProperties: 1,
            properties: Object.fromEntries(Object.keys(OPERATOR_ARITY).map(op => [op, { type: "array", items: { $ref: "#/$defs/_columnExpression" } }])),
            additionalProperties: false,
          },
          else: { $ref: "#/$defs/exprFlat" },
        },
      ],
    },
  };

  static schema: JexsNodeSchema = {
    querySelect: op("any", "Reads rows from the table the value names. Returns an array, or with `first` the single row (`null` when none matches).",
      "{ \"$querySelect\": \"users\", \"where\": { \"id\": { \"$var\": \"id\" } }, \"first\": true }",
      ["where", "orderBy", "groupBy", "first", "columns", "limit", "offset", "distinct", "innerJoin", "leftJoin", "rightJoin"]),
    queryInsert: op("any", "Inserts `data` (a row or an array of rows) into the table the value names, checked against the table's registered document if it has one (see `$tableCreate`). Returns the new primary key (or keys), or the rows with `returning`.",
      "{ \"$queryInsert\": \"users\", \"data\": { \"name\": { \"$var\": \"name\" } } }",
      ["data", "ignore", "returning"]),
    queryUpsert: op("any", "Inserts `data`, or updates the row with the same `conflict` columns; `merge` limits which columns update. Checked like `$queryInsert`.",
      "{ \"$queryUpsert\": \"settings\", \"data\": { \"key\": \"theme\", \"value\": \"dark\" }, \"conflict\": [\"key\"] }",
      ["data", "conflict", "merge", "returning"]),
    queryUpdate: op("number", "Updates the rows that match `where`, which it requires, in the table the value names, checked against the table's registered document if it has one. `where: {}` updates every row. `increment`/`decrement` apply atomic deltas. Returns the row count, or the rows with `returning`.",
      "{ \"$queryUpdate\": \"posts\", \"where\": { \"id\": 1 }, \"increment\": { \"views\": 1 } }",
      ["where", "data", "increment", "decrement"], true),
    queryDelete: op("number", "Deletes the rows that match `where`, which it requires, from the table the value names. `where: {}` deletes every row. Returns the row count, or the rows with `returning`.",
      "{ \"$queryDelete\": \"sessions\", \"where\": { \"id\": { \"$var\": \"id\" } } }",
      ["where"], true),
    queryCount: op("number", "Counts the rows that match `where` in the table the value names. Supports joins, and `distinct` with `columns` counts distinct values.",
      "{ \"$queryCount\": \"users\", \"where\": { \"active\": true } }",
      ["where", "distinct", "columns", "innerJoin", "leftJoin", "rightJoin"]),
  };

  querySelect(def: Record<string, unknown>, context: Context): NodeValue {
    return runQuery("select", def, context, async (knex, query) => {
      const builder = selectBuilder(knex, query);
      if (query.first) return readRows(context, query.table, (await builder.first()) || null);
      return readRows(context, query.table, await builder);
    });
  }

  queryInsert(def: Record<string, unknown>, context: Context): NodeValue {
    return runQuery("insert", def, context, async (knex, query) => {
      if (!query.data) throw new Error("$queryInsert needs `data`");
      let builder = knex(query.table).insert(rowsToWrite(context, query.table, query.data));
      if (query.ignore) builder = builder.onConflict().ignore();
      if (query.returning) builder = builder.returning(query.returning);
      const result = await builder;
      if (query.returning) return readRows(context, query.table, result);
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
      if (query.returning) return readRows(context, query.table, result);
      return Array.isArray(query.data) ? result : (result as number[])[0];
    });
  }

  queryUpdate(def: Record<string, unknown>, context: Context): NodeValue {
    return runQuery("update", def, context, (knex, query) => {
      if (!query.where) throw new Error("$queryUpdate needs `where`; `where: {}` updates every row");
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
      const builder = applyWhere(knex(query.table), query.where);
      return query.returning ? builder.update(data, query.returning).then(rows => readRows(context, query.table, rows)) : builder.update(data);
    });
  }

  queryDelete(def: Record<string, unknown>, context: Context): NodeValue {
    return runQuery("delete", def, context, (knex, query) => {
      if (!query.where) throw new Error("$queryDelete needs `where`; `where: {}` deletes every row");
      const builder = applyWhere(knex(query.table), query.where);
      return query.returning ? builder.delete(query.returning).then(rows => readRows(context, query.table, rows)) : builder.delete();
    });
  }

  queryCount(def: Record<string, unknown>, context: Context): NodeValue {
    return runQuery("count", def, context, async (knex, query) => {
      let builder = applyJoins(knex(query.table), query);
      // `distinct` with `columns` is COUNT(DISTINCT col); otherwise COUNT(*).
      if (query.distinct && query.columns !== undefined && !Array.isArray(query.columns)) {
        throw new Error("$queryCount: `distinct` counts a column by name, the first of a `columns` array");
      }
      const counted = query.distinct && Array.isArray(query.columns) ? query.columns[0] : undefined;
      builder = counted !== undefined ? builder.countDistinct(`${counted} as count`) : builder.count("* as count");
      if (query.where) builder = applyWhere(builder, query.where);
      const result = await builder.first();
      return Number((result as { count: number } | undefined)?.count || 0);
    });
  }
}

/** The SELECT a select query reads with, for `$querySelect` and the views a view document defines. */
export function selectBuilder(knex: KnexType, query: QueryDefinition): KnexType.QueryBuilder {
  let builder = knex(query.table);
  if (query.distinct) builder = builder.distinct();
  const dialect = knex.client.dialect;
  const { columns } = query;
  if (Array.isArray(columns)) {
    for (const [i, column] of columns.entries()) {
      if (typeof column !== "string") throw new Error(`columns[${i}]: expected a column name; an expression goes in an object of columns by name`);
    }
    if (columns.length > 0) builder = builder.select(columns);
  } else if (isObject(columns)) {
    for (const [name, expression] of Object.entries(columns)) {
      const { sql, bindings } = compileExpression(dialect, expression, `columns.${name}`);
      builder = builder.select(knex.raw(`${sql} as ??`, [...bindings, name]));
    }
  } else if (columns !== undefined) {
    throw new Error("columns: expected an array of column names, or an object of expressions by name");
  }
  if (Object.keys(columns ?? {}).length === 0) builder = builder.select("*");
  builder = applyJoins(builder, query);
  if (query.where) builder = applyWhere(builder, query.where);
  if (query.groupBy) builder = builder.groupBy(Array.isArray(query.groupBy) ? query.groupBy : [query.groupBy]);
  for (const [column, direction] of Object.entries(query.orderBy ?? {})) {
    builder = builder.orderBy(column, direction.toLowerCase() as "asc" | "desc");
  }
  if (query.limit) builder = builder.limit(query.limit);
  if (query.offset) builder = builder.offset(query.offset);
  return builder;
}

/**
 * Compile an expression to SQL and its bindings: a column name to an identifier
 * (`??`), a number to a value (`?`), and an operator to the SQL over its
 * operands, so nothing an expression holds reaches the SQL as written. The
 * exceptions are the `*` of `count: ["*"]`, and `join`'s separator, a value.
 */
function compileExpression(dialect: string, expression: unknown, at: string): { sql: string; bindings: KnexType.RawBinding[] } {
  if (typeof expression === "string") return { sql: "??", bindings: [expression] };
  if (typeof expression === "number" && Number.isFinite(expression)) return { sql: "?", bindings: [expression] };
  if (expression === null) return { sql: "NULL", bindings: [] };
  const entries = isObject(expression) ? Object.entries(expression) : [];
  if (entries.length !== 1 || !Object.hasOwn(OPERATOR_ARITY, entries[0][0])) {
    throw new Error(`${at}: expected a column name, a number, null, or one operator: ${Object.keys(OPERATOR_ARITY).join(", ")}`);
  }
  const [op, operands] = entries[0];
  const [fewest, most] = OPERATOR_ARITY[op];
  if (!Array.isArray(operands) || operands.length < fewest || operands.length > most) {
    throw new Error(`${at}.${op}: expected ${fewest === most ? fewest : `${fewest}${most === Infinity ? " or more" : ` to ${most}`}`} operands in an array`);
  }
  if (op === "join") {
    const separator = operands[1] ?? ",";
    if (typeof separator !== "string") throw new Error(`${at}.join[1]: expected the separator, a string`);
    const value = compileExpression(dialect, operands[0], `${at}.join[0]`);
    const sql = dialect === "mysql" ? `GROUP_CONCAT(${value.sql} SEPARATOR ?)`
      : dialect === "sqlite3" ? `GROUP_CONCAT(${value.sql}, ?)`
      : `STRING_AGG(CAST(${value.sql} AS TEXT), ?)`;
    return { sql, bindings: [...value.bindings, separator] };
  }
  const parts = op === "count" && operands[0] === "*"
    ? [{ sql: "*", bindings: [] }]
    : operands.map((operand, i) => compileExpression(dialect, operand, `${at}.${op}[${i}]`));
  const sql = parts.map(part => part.sql);
  const bindings = parts.flatMap(part => part.bindings);
  if (Object.hasOwn(ARITHMETIC, op)) return { sql: `(${sql.join(` ${ARITHMETIC[op]} `)})`, bindings };
  if (Object.hasOwn(AGGREGATE, op)) {
    const call = `${AGGREGATE[op]}${sql[0]})`;
    // PostgreSQL counts in bigint, which its driver hands back as a string.
    const counts = op === "count" || op === "countDistinct";
    return { sql: counts && dialect === "postgresql" ? `CAST(${call} AS integer)` : call, bindings };
  }
  if (Object.hasOwn(SCALAR, op)) return { sql: `${SCALAR[op]}(${sql[0]})`, bindings };
  if (op === "coalesce") return { sql: `COALESCE(${sql.join(", ")})`, bindings };
  if (operands.length === 2 && !Number.isInteger(operands[1])) throw new Error(`${at}.round[1]: expected a whole number of digits`);
  // PostgreSQL rounds to digits only a numeric, which its driver hands back as a string.
  return dialect === "postgresql"
    ? { sql: `CAST(ROUND(CAST(${sql[0]} AS numeric)${sql[1] ? `, ${sql[1]}` : ""}) AS double precision)`, bindings }
    : { sql: `ROUND(${sql.join(", ")})`, bindings };
}

/**
 * Run a query op: resolve the step into its query (the op's value as `table`,
 * beside its clauses, without the `connection` setting), and under a validator
 * refuse the catalog and have the validators check it, then `run` it.
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
    if (!isOwnedKey(k) && k !== "connection") fields[k] = v;
  }
  fields.table = table;
  const query = fields as unknown as QueryDefinition;
  if (type !== "select" && type !== "count" && viewDocument(context, table)) {
    throw new Error(`${op}: "${table}" is a view, which is read-only`);
  }
  // Omitted `connection` falls back to whichever opened first; getKnex owns
  // that chain, so this does not repeat it.
  const knex = DatabaseNode.getKnex(context, r.connection);
  const joined = [query.innerJoin, query.leftJoin, query.rightJoin].flatMap(joins => joins ?? []).map(join => join.table);
  await authorizeRows(context, r.connection, op, query, [table, ...joined]);
  return run(knex, query);
}

/** The view document registered for `name`, as written. */
function viewDocument(context: Context, name: string): ViewJsonSchema | undefined {
  const doc = requireSchemaNode(context).documents.get(viewId(name));
  return isViewDocument(doc) ? doc as ViewJsonSchema : undefined;
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
    // Own columns only, so constructor and __proto__ in the data are never columns.
    if (Object.hasOwn(props, key)) result[key] = row[key];
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
    if (!Object.hasOwn(props, key)) continue;
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
    throw new Error(`Validation failed for "${tableName}": ${errors.join("; ")}`);
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
    // A `null` source is no value to derive from, as a missing one is: it
    // leaves the column unset rather than hashing the text "null".
    const value = source[sourceCol];
    if (computeFn && value !== undefined && value !== null) {
      target[colName] = computeFn(String(value));
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
 * Rows as read, with each boolean column of the table or view the query names
 * as a boolean: SQLite and MySQL hand back the 1/0 they store. A column read
 * under another name (an alias, a joined table's) is left as the database gave it.
 */
function readRows(context: Context, tableName: string, rows: unknown): unknown {
  const properties = (DatabaseTableNode.get(context, tableName) ?? viewDocument(context, tableName))?.properties;
  if (!properties) return rows;
  const columns = Object.keys(properties).filter(name => coercionType(properties[name]) === "boolean");
  if (columns.length === 0) return rows;
  const read = (row: unknown) => {
    if (!isObject(row)) return row;
    for (const name of columns) if (typeof row[name] === "number") row[name] = row[name] !== 0;
    return row;
  };
  return Array.isArray(rows) ? rows.map(read) : read(rows);
}

/**
 * Coerce a raw value to its stored representation. Pure type conversion only —
 * declarative constraints (max length, enum, pattern, format) are enforced by
 * the JSON Schema via Ajv after coercion.
 */
function coerceType(value: unknown, col: ColumnSchema, colName: string, tableName: string): unknown {
  // SQL NULL, never the text "null" or a 0: the schema says whether the column
  // takes it (`"type": ["string", "null"]`).
  if (value === null) return null;
  switch (coercionType(col)) {
    case "integer":
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

    // The driver stores it as the database keeps booleans (1/0 on SQLite and MySQL).
    case "boolean":
      if (typeof value === "string") return value !== "" && value !== "0" && value.toLowerCase() !== "false";
      return Boolean(value);

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
    else if (op === "isNull") {
      if (typeof operand !== "boolean") throw new Error(`${at}: expected true or false, got ${typeof operand}`);
      builder = operand ? builder.whereNull(col) : builder.whereNotNull(col);
    } else {
      throw new Error(`${col}: unknown operator "${op}"`);
    }
  }
  return builder;
}
