import { Knex as KnexType } from "knex";
import { Node, Context, NodeValue, isOwnedKey, isStep, resolve, resolveFields, runSteps } from "@jexs/core";
import { DatabaseNode } from "./Database.js";
import { SchemaNode } from "./Schema.js";
import type { JexsMethodSchema, JexsNodeSchema, JexsOutput, JexsPropertySchema } from "@jexs/core";

const VALID_QUERY_TYPES = new Set(["select","insert","upsert","update","delete","count","create","drop","alter"]);
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
  /** Mask the value in output. */
  secret?: boolean;
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
 * A table document: JSON Schema (draft 2020-12) for its rows, whose
 * `properties` are the columns, beside the settings that build and guard the
 * table. Ajv ignores those keys, so the document validates rows as it is. UI
 * metadata lives under `x-entity`.
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
  /** Steps QueryNode runs before each query on this table, after the global
   *  validator (see `runValidators`). Not run for the table's own `create`. */
  validator?: unknown;
  "x-entity"?: TableEntityMeta;
  [key: string]: unknown;
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

/** The clauses a query op takes as siblings, by name. Declared before the class
 *  so the static schema initializer can read them (a `const` is not hoisted). */
const CLAUSE: Record<string, JexsPropertySchema> = {
  where:        { description: "WHERE clause: `{ column: value }`, an operator object (`{ column: { gt: 5 } }`), or nested `or`/`and`." },
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
  schema:       { $ref: "#/$defs/_tableSchemaSlot", description: "Table to create (create): a registered name, `\"*\"` for every registered table, or a table document, kept as written so its `validator` stays steps. Load a document file with `data: true`." },
  conflict:     { type: "array", description: "Conflict target columns (upsert)." },
  merge:        { type: "array", description: "Columns to update on conflict (upsert); omit to merge all." },
  ignore:       { type: "boolean", description: "INSERT OR IGNORE on conflict (insert)." },
  addColumns:   { description: "Columns to add (alter)." },
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

/**
 * QueryNode: one `query` key whose value is the SQL operation; `table` is the
 * target and the op's clauses sit beside it, e.g.
 *   { "$query": "select", "table": "users", "where": { "id": 1 }, "first": true }
 * The op is a value-mode discriminator, so each op accepts only its own clauses
 * and narrows the output.
 */
export class QueryNode extends Node {
  static schemaDefs: Record<string, Record<string, unknown>> = {
    // `data` resolves whole, so an expression is one more object here.
    _queryRows: { anyOf: [{ type: "object" }, { type: "array", items: { type: "object" } }] },
  };

  static schema: JexsNodeSchema = {
    query: {
      type: "string",
      enum: ["select", "insert", "upsert", "update", "delete", "count", "create", "drop", "alter"],
      markdownDescription: "Runs a database query. The value is the SQL operation; `table` is the target and the op's clauses (`where`, `data`, `first`, ...) sit beside it.",
      examples: [
        "{ \"$query\": \"select\", \"table\": \"users\", \"where\": { \"id\": { \"$var\": \"id\" } }, \"first\": true }",
      ],
      siblings: {
        table:      { type: "string",  description: "Target table." },
        connection: { type: "string",  description: "Named DB connection (default if omitted)." },
        system:     { type: "boolean", description: "Skip the validators: for the app's own queries, such as creating tables at startup, which have no request to authorize." },
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
        create: op("array", "Creates table(s) from a registered `schema` or inline document. Returns a per-table status array.",
          ["schema"]),
        drop:   op("object", "Drops the table.", []),
        alter:  op("object", "Alters the table: add columns via `addColumns`.",
          ["addColumns"]),
      },
    },
  };

  query(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    return execQuery(def, context);
  }
}

async function execQuery(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
  // Every clause is a sibling holding plain data (column names, `where`
  // operators, row keys), so the step resolves in one pass. `schema` is the
  // exception: a table document carries `validator` steps that must reach
  // the registry as steps, so only a step producing the document is resolved.
  const { schema, ...clauses } = def;
  const r = await resolveFields(clauses, context, r => r);
  if (schema !== undefined) r.schema = isStep(schema) ? await resolve(schema, context) : schema;
  const query = toQuery(r);
  // Omitted `connection` falls back to whichever opened first; getKnex owns
  // that chain, so this does not repeat it.
  const knex = DatabaseNode.getKnex(context, r.connection == null ? undefined : String(r.connection));

  if (!r.system) await runValidators(query, context);

  switch (query.type) {
    case "select":  return executeSelect(knex, query, query.first === true) as Promise<NodeValue>;
    case "insert":  return executeInsert(knex, query, context) as Promise<NodeValue>;
    case "upsert":  return executeUpsert(knex, query, context) as Promise<NodeValue>;
    case "update":  return executeUpdate(knex, query, context) as Promise<NodeValue>;
    case "delete":  return executeDelete(knex, query) as Promise<NodeValue>;
    case "count":   return executeCount(knex, query) as Promise<NodeValue>;
    case "create":  return executeCreate(knex, query, context) as Promise<NodeValue>;
    case "drop":    return executeDrop(knex, query) as Promise<NodeValue>;
    case "alter":   return executeAlter(knex, query) as Promise<NodeValue>;
  }
}

/** The table documents a query touches: every table `create` makes, otherwise
 *  the one it names (a stand-in when it is not registered, so the global
 *  validator still sees the table name). */
function tablesOf(query: QueryDefinition, context: Context): TableJsonSchema[] {
  if (query.type === "create") return resolveSchemas(query.schema, context);
  if (!query.table) return [];
  return [SchemaNode.get(context, query.table) ?? { table: query.table, properties: {} }];
}

/**
 * Run the validators before a query executes, once per table it touches: the
 * global validator, then the table's own `validator`, so a table can add
 * checks but never lift the app-wide ones. They see the table document as
 * `schema`, the operation as `operation` and the query itself as `query`,
 * which they may narrow (e.g. add an owner to `where`) since this is the object
 * that runs. A validator refuses by throwing (`{ "$error": 403 }`).
 */
async function runValidators(query: QueryDefinition, context: Context): Promise<void> {
  if (Reflect.get(context, VALIDATING) === true) return;
  const operation = query.type === "count" ? "select" : query.type;
  const global = SchemaNode.globalValidator(context);
  for (const schema of tablesOf(query, context)) {
    // A table being created cannot approve its own creation: its document is
    // the caller's, so only the global validator judges it.
    const own = query.type === "create" ? undefined : schema.validator;
    if (global == null && own == null) continue;
    // A copy: a validator may narrow the query, but the registered document
    // stays as registered.
    const validatorContext: Context & { [VALIDATING]: true } = {
      ...context, [VALIDATING]: true, schema: structuredClone(schema), query, operation,
    };
    for (const steps of [global, own]) {
      if (steps != null) await runSteps(steps, validatorContext);
    }
  }
}

/** The resolved step as the QueryDefinition the execute* helpers consume: its clauses, without the resolver's `$` keys or the connection settings. */
function toQuery(r: Record<string, unknown>): QueryDefinition {
  const type = r.$query;
  if (typeof type !== "string" || !VALID_QUERY_TYPES.has(type)) {
    throw new Error(`Invalid query type: "${type}". Must be one of: ${[...VALID_QUERY_TYPES].join(", ")}`);
  }
  if (type !== "create" && typeof r.table !== "string") {
    throw new Error("Query must have a table property");
  }
  const query: Record<string, unknown> = { type };
  for (const [k, v] of Object.entries(r)) {
    if (!isOwnedKey(k) && k !== "connection" && k !== "system") query[k] = v;
  }
  return query as unknown as QueryDefinition;
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
  const data = SchemaNode.validateInsert(context, query.table!, query.data);

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

  const data = SchemaNode.validateInsert(context, query.table!, query.data);

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
    ? SchemaNode.validateUpdate(context, query.table!, query.data as Record<string, unknown>)
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
 * Execute a CREATE TABLE query from schema
 */
async function executeCreate(
  knex: KnexType,
  query: QueryDefinition,
  context: Context,
): Promise<{ table: string; created: boolean }[]> {
  const results: { table: string; created: boolean; error?: string }[] = [];

  const schemas = resolveSchemas(query.schema, context);

  for (const schema of schemas) {
    // Register schema for validation/computed columns
    SchemaNode.register(context, schema);
    const tableName = schema.table;

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
  context: Context,
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
    return SchemaNode.getAll(context);
  }

  // Lookup by table name
  const found = SchemaNode.get(context, schema);
  if (found) return [found];

  throw new Error(`[QueryNode] Schema "${schema}" not found in registry`);
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
