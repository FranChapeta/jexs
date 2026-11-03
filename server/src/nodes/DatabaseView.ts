import { Knex as KnexType } from "knex";
import { Node, Context, NodeValue, freezeData, isObject, loggerFor, resolve, resolveAll } from "@jexs/core";
import { DatabaseNode, listViews, runValidators, validatorsFor } from "./Database.js";
import { isCatalog, selectBuilder, type QueryDefinition } from "./DatabaseQuery.js";
import type { ColumnSchema } from "./DatabaseTable.js";
import { SchemaNode, isViewDocument, requireSchemaNode, schemaArg, viewId } from "./Schema.js";
import type { JexsNodeSchema, JexsPropertySchema } from "@jexs/core";

/** The `$querySelect` clauses a view document takes at its root, beside `from`. */
const SELECT_CLAUSES = ["columns", "where", "orderBy", "groupBy", "limit", "offset", "distinct", "innerJoin", "leftJoin", "rightJoin"] as const;

/**
 * A view document: JSON Schema for the rows the view gives, whose `properties`
 * are its columns, beside the select that gives them: the table it reads
 * `from` and `$querySelect`'s clauses. Shaped as a table document, with `view`
 * in place of `table`.
 */
export interface ViewJsonSchema extends Pick<QueryDefinition, (typeof SELECT_CLAUSES)[number]> {
  type?: "object";
  required?: string[];
  properties?: Record<string, ColumnSchema>;
  /** The view's name. */
  view: string;
  /** The table or view it reads. */
  from: string;
  /** A PostgreSQL materialized view. */
  materialized?: boolean;
  [key: string]: unknown;
}

const strings = { type: "array", items: { type: "string" } };
const names = { type: "array", items: { type: "string" } } as const;
const joins = { type: "array", items: { type: "object", required: ["table", "on"], properties: { table: { type: "string" }, as: { type: "string" }, on: { type: "object" } } } };

export class DatabaseViewNode extends Node {
  /** `viewSchema` is a view document. It is a root document kind, so a file
   *  whose root has `view` and `from` is checked as one. */
  static schemaDefs: Record<string, Record<string, unknown>> = {
    viewSchema: {
      type: "object",
      required: ["view", "from"],
      properties: {
        type:         { const: "object" },
        required:     { ...strings, description: "Columns every row has." },
        properties:   { type: "object", additionalProperties: { type: "object" }, description: "The view's columns, by name, each JSON Schema for its values. Without `columns`, they are what the view selects. A `boolean` one reads as `true`/`false`, whatever the database stores." },
        view:         { type: "string", description: "The view's name." },
        from:         { type: "string", description: "The table or view it reads." },
        columns:      { $ref: "#/$defs/_selectColumns", description: "What it selects, as `$querySelect` takes it: an array of columns by name, or an object of expressions by the name each gives the view's column (`{ \"cart\": \"cart\", \"revenue\": { \"sum\": [{ \"multiply\": [\"price\", \"qty\"] }] } }`)." },
        where:        { type: "object", description: "WHERE clause, as `$querySelect` takes it." },
        orderBy:      { type: "object", additionalProperties: { enum: ["asc", "desc", "ASC", "DESC"] }, description: "ORDER BY: `{ column: 'asc' | 'desc' }`." },
        groupBy:      { anyOf: [{ type: "string" }, strings], description: "GROUP BY column name or array of names." },
        limit:        { type: "integer", description: "LIMIT N." },
        offset:       { type: "integer", description: "OFFSET N." },
        distinct:     { type: "boolean", description: "SELECT DISTINCT." },
        innerJoin:    { ...joins, description: "INNER JOIN clauses." },
        leftJoin:     { ...joins, description: "LEFT JOIN clauses." },
        rightJoin:    { ...joins, description: "RIGHT JOIN clauses." },
        materialized: { type: "boolean", description: "A materialized view, which stores its rows until `$viewRefresh` (PostgreSQL only)." },
      },
    },
    /** `$viewCreate`'s and `$viewSync`'s value: a view document, or a view's
     *  name (`"*"` for every registered one), or a step producing either. */
    _viewSchemaSlot: {
      if: { type: "object", anyOf: [{ required: ["view"] }, { required: ["from"] }] },
      then: { $ref: "#/$defs/viewSchema" },
      else: { $ref: "#/$defs/strOrExpr" },
    },
  };

  static commonSiblings: Record<string, JexsPropertySchema> = {
    connection: { type: "string", description: "Named database connection (default if omitted)." },
  };

  static schema: JexsNodeSchema = {
    viewCreate: {
      $ref: "#/$defs/_viewSchemaSlot",
      literal: true,
      output: "string",
      outputDescription: "The view's name.",
      markdownDescription: "Creates a view from a view document: JSON Schema for the rows it gives, whose `properties` are its columns, beside the select that gives them, the table it reads `from` and `$querySelect`'s clauses (`columns`, `where`, joins, `groupBy`, ...). The document is registered with `$schema` as `view/<name>` first, and once registered, `$querySelect` reads its boolean columns as booleans, the `rows` steps of a `$database` validator see it as `schema`, and writes to the view are refused. The value is the document, kept as written (load a file with `$file` and `data: true`), or the name of a registered one. A view that already exists is an error; `$viewSync` rebuilds it instead.",
      examples: [
        "{ \"$viewCreate\": { \"view\": \"active_users\", \"from\": \"users\", \"columns\": [\"id\", \"name\"], \"where\": { \"active\": true } } }",
        "{ \"$viewCreate\": { \"view\": \"cart_totals\", \"from\": \"lines\", \"columns\": { \"cart\": \"cart\", \"revenue\": { \"sum\": [{ \"multiply\": [\"price\", \"qty\"] }] } }, \"groupBy\": \"cart\" } }",
        "{ \"$viewCreate\": { \"$file\": \"db/active_users.json\", \"data\": true } }",
      ],
    },
    viewSync: {
      $ref: "#/$defs/_viewSchemaSlot",
      literal: true,
      output: names,
      outputDescription: "The names of the views it built.",
      markdownDescription: "Makes the database's views match view documents. A view holds no rows of its own, so each is rebuilt: the ones that exist are dropped and all are created again, each after the views among them it reads. It runs in a transaction, so on PostgreSQL and SQLite a failure leaves the views as they were. PostgreSQL refuses to drop a view another reads, so rebuild them together (`\"*\"`). The value is a view document, registered first as `$viewCreate` does; a registered view's name; or `\"*\"` for every registered view.",
      examples: [
        "{ \"$viewSync\": \"*\" }",
        "{ \"$viewSync\": { \"$file\": \"db/active_users.json\", \"data\": true } }",
      ],
    },
    viewDrop: {
      type: "string",
      output: "null",
      markdownDescription: "Drops the view the value names, materialized or not, if it exists. Its registered document, if any, stays registered; `$schema: \"unregister\"` forgets it.",
      examples: ["{ \"$viewDrop\": \"active_users\" }"],
    },
    viewRefresh: {
      type: "string",
      output: "null",
      markdownDescription: "Runs the query of the materialized view the value names again, replacing the rows it stores (PostgreSQL only).",
      examples: ["{ \"$viewRefresh\": \"daily_totals\", \"concurrently\": true }"],
      siblings: {
        concurrently: { type: "boolean", description: "Refresh without locking out reads, which needs a unique index on the view." },
      },
    },
  };

  async viewCreate(def: Record<string, unknown>, context: Context): Promise<string> {
    const connection = await resolve(def.connection ?? null, context, name => name);
    const [view] = await documentsOf(def.$viewCreate, connection, context, "create");
    const knex = DatabaseNode.getKnex(context, connection);
    if ((await listViews(knex)).includes(view.view)) {
      throw new Error(`$viewCreate: view "${view.view}" already exists; \`$viewSync\` rebuilds it`);
    }
    await createView(knex, view);
    loggerFor(context).info(`[view] Created view: ${view.view}`);
    return view.view;
  }

  async viewSync(def: Record<string, unknown>, context: Context): Promise<string[]> {
    const connection = await resolve(def.connection ?? null, context, name => name);
    const views = inBuildOrder(await documentsOf(def.$viewSync, connection, context, "sync"));
    const knex = DatabaseNode.getKnex(context, connection);
    await knex.transaction(async trx => {
      const existing = new Set(await listViews(trx));
      for (const view of [...views].reverse()) {
        if (existing.has(view.view)) await dropView(trx, view.view);
      }
      for (const view of views) await createView(trx, view);
    });
    const built = views.map(view => view.view);
    if (built.length > 0) loggerFor(context).info(`[view] Built views: ${built.join(", ")}`);
    return built;
  }

  viewDrop(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$viewDrop, def.connection ?? null], context, async ([viewRaw, connection]) => {
      const view = String(viewRaw);
      await authorize(context, connection, "drop", view);
      const knex = DatabaseNode.getKnex(context, connection);
      if ((await listViews(knex)).includes(view)) await dropView(knex, view);
      loggerFor(context).info(`[view] Dropped view: ${view}`);
      return null;
    });
  }

  viewRefresh(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$viewRefresh, def.concurrently ?? false, def.connection ?? null], context, async ([viewRaw, concurrently, connection]) => {
      const view = String(viewRaw);
      await authorize(context, connection, "refresh", view);
      const knex = DatabaseNode.getKnex(context, connection);
      if (knex.client.dialect !== "postgresql") throw new Error(`$viewRefresh: only PostgreSQL has materialized views`);
      if (!await isMaterialized(knex, view)) throw new Error(`$viewRefresh: "${view}" is not a materialized view`);
      await knex.schema.refreshMaterializedView(view, concurrently === true);
      loggerFor(context).info(`[view] Refreshed view: ${view}`);
      return null;
    });
  }

  /** The document registered for view `viewName`, as written. A static rather
   *  than a method, since every method on a Node registers as an op. */
  static get(context: Context, viewName: string): ViewJsonSchema | undefined {
    const doc = requireSchemaNode(context).documents.get(viewId(viewName));
    return isViewDocument(doc) ? doc as ViewJsonSchema : undefined;
  }
}

/**
 * Under the validators around the step, if any, refuse a view built on the
 * database's own catalog, which would hand its rows to queries the catalog
 * check never sees, then run their `structure` steps. Those see `operation`,
 * `view`, and its document as `schema`, read-only: the registered one, or a
 * frozen copy of the one being applied. They refuse by throwing.
 */
async function authorize(
  context: Context, connection: unknown, operation: string, view: string,
  schema: ViewJsonSchema | undefined = DatabaseViewNode.get(context, view),
): Promise<void> {
  const validators = validatorsFor(context, connection);
  if (validators.length === 0) return;
  if (schema && (operation === "create" || operation === "sync")) {
    for (const name of readsOf(schema)) {
      if (isCatalog(name)) {
        throw new Error(`$view${operation === "create" ? "Create" : "Sync"}: view "${view}" reads "${name}", the database's own catalog, which no step under a validator may query`);
      }
    }
  }
  if (!validators.some(validator => validator.structure != null)) return;
  await runValidators(validators, "structure", context, { operation, view, schema });
}

/**
 * The view documents a `$viewCreate` or `$viewSync` names in its value, each
 * one the database can build and authorized by the validators around the
 * step: a document, which is
 * registered once authorized; a registered view's name; or, for `sync` only,
 * `"*"` for every registered view.
 */
async function documentsOf(value: unknown, connection: unknown, context: Context, operation: "create" | "sync"): Promise<ViewJsonSchema[]> {
  const op = operation === "create" ? "$viewCreate" : "$viewSync";
  const doc = await schemaArg(value, context);
  const schemas = requireSchemaNode(context);
  const knex = DatabaseNode.getKnex(context, connection);
  if (isObject(doc)) {
    if (!isViewDocument(doc)) throw new Error("A view document needs a `view` name and the table it reads `from`.");
    checkBuildable(knex, doc as ViewJsonSchema);
    await authorize(context, connection, operation, doc.view, freezeData(structuredClone(doc as ViewJsonSchema)));
    SchemaNode.register(schemas, doc);
    return [DatabaseViewNode.get(context, doc.view)!];
  }
  let documents: ViewJsonSchema[];
  if (doc === "*" && operation === "sync") {
    documents = SchemaNode.all(schemas, viewId("")).filter(isViewDocument) as ViewJsonSchema[];
  } else if (typeof doc === "string") {
    const found = DatabaseViewNode.get(context, doc);
    if (!found) throw new Error(`${op}: no document registered for view "${doc}"`);
    documents = [found];
  } else {
    throw new Error(`${op} takes a view document or a registered view's name${operation === "sync" ? ", or \"*\" for every registered one" : ""}`);
  }
  for (const view of documents) {
    checkBuildable(knex, view);
    await authorize(context, connection, operation, view.view);
  }
  return documents;
}

/** The tables and views a view reads, as its document names them (`name as alias` for a join). */
function readsOf(view: ViewJsonSchema): string[] {
  const joined = [view.innerJoin, view.leftJoin, view.rightJoin].flatMap(joins => joins ?? []).map(join => join.table);
  return [view.from, ...joined].filter(name => typeof name === "string");
}

/** Views in the order to build them: each after the ones among them it reads. */
function inBuildOrder(views: ViewJsonSchema[]): ViewJsonSchema[] {
  const byName = new Map(views.map(view => [view.view, view]));
  const ordered: ViewJsonSchema[] = [];
  const place = (view: ViewJsonSchema, reading: string[]) => {
    if (ordered.includes(view)) return;
    if (reading.includes(view.view)) throw new Error(`Views read each other in a cycle: ${[...reading, view.view].join(" -> ")}`);
    for (const name of readsOf(view)) {
      const read = byName.get(name.split(/\s+as\s+/i)[0].trim());
      if (read) place(read, [...reading, view.view]);
    }
    ordered.push(view);
  };
  for (const view of views) place(view, []);
  return ordered;
}

/** Refuse a document the database cannot build, before anything changes. */
function checkBuildable(knex: KnexType, view: ViewJsonSchema): void {
  if (view.materialized && knex.client.dialect !== "postgresql") {
    throw new Error(`View "${view.view}" is materialized, which only PostgreSQL has`);
  }
}

/** Create the view a document declares. Without `columns`, it selects its `properties`. */
async function createView(knex: KnexType, view: ViewJsonSchema): Promise<void> {
  const query: QueryDefinition = { type: "select", table: view.from };
  for (const clause of SELECT_CLAUSES) {
    if (view[clause] !== undefined) Object.assign(query, { [clause]: view[clause] });
  }
  if (query.columns === undefined && view.properties) query.columns = Object.keys(view.properties);
  const build = (builder: KnexType.ViewBuilder) => { builder.as(selectBuilder(knex, query)); };
  await (view.materialized ? knex.schema.createMaterializedView(view.view, build) : knex.schema.createView(view.view, build));
}

/** Drop a view that exists, materialized or not. */
async function dropView(knex: KnexType, view: string): Promise<void> {
  await (await isMaterialized(knex, view) ? knex.schema.dropMaterializedView(view) : knex.schema.dropView(view));
}

/** Whether `view` is a PostgreSQL materialized view. */
async function isMaterialized(knex: KnexType, view: string): Promise<boolean> {
  if (knex.client.dialect !== "postgresql") return false;
  const row: unknown = await knex("pg_matviews").first("matviewname")
    .where("schemaname", knex.raw("current_schema()")).andWhere("matviewname", view);
  return row !== undefined;
}
