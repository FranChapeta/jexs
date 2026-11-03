import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createResolver, coreNodes } from "@jexs/core";
import { serverNodes } from "../src/index.js";
import { DatabaseViewNode } from "../src/nodes/DatabaseView.js";

// The registry is the resolver's own, so lookups go through a context attached to it.
const registry = {};
const resolve = createResolver([...coreNodes(), ...serverNodes({ root: "." })], { context: registry });
// A file, not `:memory:`: each pooled connection would open its own empty in-memory database.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jexs-view-"));
const conn = { connection: "view-test" };

before(async () => {
  await resolve({ $database: "connect", ...conn, type: "sqlite", filename: path.join(dir, "test.db") }, {});
  await resolve({ $tableCreate: {
    table: "users",
    properties: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      name: { type: "string" },
      active: { type: "boolean" },
      admin: { type: "boolean" },
      team: { type: ["integer", "null"] },
    },
  }, ...conn }, {});
  await resolve({ $tableCreate: {
    table: "teams",
    properties: { id: { type: "integer", primaryKey: true, autoIncrement: true }, title: { type: "string" } },
  }, ...conn }, {});
  await resolve({ $queryInsert: "teams", ...conn, data: [{ title: "Core" }, { title: "Web" }] }, {});
  await resolve({ $queryInsert: "users", ...conn, data: [
    { name: "Ada", active: true, admin: true, team: 1 },
    { name: "Grace", active: true, admin: false, team: 2 },
    { name: "Linus", active: false, admin: false, team: 1 },
  ] }, {});
});

after(async () => {
  await resolve({ $database: "close", ...conn }, {});
  resolve.destroy();
  await fs.rm(dir, { recursive: true, force: true });
});

const names = (rows: unknown) => (rows as Array<{ name: string }>).map(row => row.name);

test("a view selects what its document says, and queries read it as a table", async () => {
  const doc = {
    view: "active_users",
    from: "users", where: { active: true }, orderBy: { name: "asc" },
    properties: { id: { type: "integer" }, name: { type: "string" }, admin: { type: "boolean" } },
  };
  assert.equal(await resolve({ $viewCreate: doc, ...conn }, {}), "active_users");
  // `properties` names the columns and, without `columns`, picks them.
  const rows = await resolve({ $querySelect: "active_users", ...conn, orderBy: { name: "asc" } }, {});
  assert.deepEqual(rows, [{ id: 1, name: "Ada", admin: true }, { id: 2, name: "Grace", admin: false }]);
  assert.equal(await resolve({ $queryCount: "active_users", ...conn, where: { admin: true } }, {}), 1);

  assert.deepEqual(await resolve({ $database: "views", ...conn }, {}), ["active_users"]);
  assert.equal(await resolve({ $includes: [{ $database: "tables", ...conn }, "active_users"] }, {}), false);
  await assert.rejects(resolve({ $viewCreate: doc, ...conn }, {}), /view "active_users" already exists; `\$viewSync` rebuilds it/);
});

test("`columns` names a view's columns, and joins are built in", async () => {
  await resolve({ $viewCreate: {
    view: "members",
    from: "users", columns: { name: "users.name", team: "teams.title" }, innerJoin: [{ table: "teams", on: { "users.team": "teams.id" } }],
    properties: { name: { type: "string" }, team: { type: "string" } },
  }, ...conn }, {});
  const rows = await resolve({ $querySelect: "members", ...conn, where: { team: "Core" }, orderBy: { name: "asc" } }, {});
  assert.deepEqual(rows, [{ name: "Ada", team: "Core" }, { name: "Linus", team: "Core" }]);
});

test("a view computes columns and aggregates, named by `properties`", async () => {
  await resolve({ $viewCreate: {
    view: "team_stats",
    from: "users",
    innerJoin: [{ table: "teams", on: { "users.team": "teams.id" } }],
    groupBy: "teams.title",
    columns: { title: "teams.title", members: { count: ["*"] }, admins: { sum: ["admin"] }, share: { divide: [{ sum: ["admin"] }, { count: ["*"] }] } },
    properties: { title: { type: "string" }, members: { type: "integer" }, admins: { type: "integer" }, share: { type: "integer" } },
  }, ...conn }, {});
  assert.deepEqual(await resolve({ $querySelect: "team_stats", ...conn, orderBy: { title: "asc" } }, {}), [
    { title: "Core", members: 2, admins: 1, share: 0 },
    { title: "Web", members: 1, admins: 0, share: 0 },
  ]);
  assert.deepEqual(await resolve({ $querySelect: "team_stats", ...conn, where: { members: { gt: 1 } }, columns: ["title"] }, {}), [{ title: "Core" }]);
  await resolve({ $viewDrop: "team_stats", ...conn }, {});
  await resolve({ $schema: "unregister", id: "view/team_stats" }, {});
});

test("a registered view is read-only", async () => {
  for (const step of [
    { $queryInsert: "active_users", data: { name: "x" } },
    { $queryUpsert: "active_users", data: { name: "x" }, conflict: ["id"] },
    { $queryUpdate: "active_users", where: {}, data: { name: "x" } },
    { $queryDelete: "active_users", where: {} },
  ]) {
    await assert.rejects(resolve({ ...step, ...conn }, {}), /"active_users" is a view, which is read-only/);
  }
});

test("sync rebuilds views, and \"*\" rebuilds every one, those another reads included", async () => {
  await resolve({ $viewCreate: { view: "admins", from: "active_users", columns: ["name"], where: { admin: true } }, ...conn }, {});
  assert.deepEqual(names(await resolve({ $querySelect: "admins", ...conn }, {})), ["Ada"]);

  // `active_users` changes under `admins`, which reads it.
  await resolve({ $schema: "register", schema: {
    view: "active_users",
    from: "users",
    properties: { id: { type: "integer" }, name: { type: "string" }, admin: { type: "boolean" } },
  } }, {});
  const built = await resolve({ $viewSync: "*", ...conn }, {}) as string[];
  // Registering again moved `active_users` last; it is still built before `admins`.
  assert.deepEqual(built, ["members", "active_users", "admins"]);
  assert.equal(await resolve({ $queryCount: "active_users", ...conn }, {}), 3);
  assert.deepEqual(names(await resolve({ $querySelect: "admins", ...conn }, {})), ["Ada"]);

  assert.deepEqual(await resolve({ $viewSync: "admins", ...conn }, {}), ["admins"]);
  await assert.rejects(resolve({ $viewSync: "never", ...conn }, {}), /\$viewSync: no document registered for view "never"/);
  await assert.rejects(resolve({ $viewSync: true, ...conn }, {}), /\$viewSync takes a view document or a registered view's name, or "\*"/);
  await assert.rejects(resolve({ $viewCreate: { view: "broken", columns: ["id"] }, ...conn }, {}), /needs a `view` name and the table it reads `from`/);
  assert.equal(DatabaseViewNode.get(registry, "broken"), undefined, "a document the database cannot build is not registered");
});

test("a failed sync leaves the views as they were", async () => {
  // Built after the others are dropped, and refused: a table has the name.
  await resolve({ $schema: "register", schema: { view: "teams", from: "users" } }, {});
  await assert.rejects(resolve({ $viewSync: "*", ...conn }, {}), /already exists/);
  assert.deepEqual(names(await resolve({ $querySelect: "admins", ...conn }, {})), ["Ada"]);
  await resolve({ $schema: "unregister", id: "view/teams" }, {});
});

test("views that read each other in a cycle are refused before anything changes", async () => {
  await resolve({ $schema: "register", schema: { view: "cycle_a", from: "cycle_b" } }, {});
  await resolve({ $schema: "register", schema: { view: "cycle_b", from: "users", innerJoin: [{ table: "cycle_a as a", on: { "a.id": "users.id" } }] } }, {});
  await assert.rejects(resolve({ $viewSync: "*", ...conn }, {}), /Views read each other in a cycle: cycle_a -> cycle_b -> cycle_a/);
  assert.equal(await resolve({ $includes: [{ $database: "views", ...conn }, "admins"] }, {}), true);
  await resolve({ $schema: "unregister", id: "view/cycle_a" }, {});
  await resolve({ $schema: "unregister", id: "view/cycle_b" }, {});
});

test("a validator's rows steps see a view's name and document, and may narrow its query", async () => {
  const rows = [
    { $if: { $not: { $eq: [{ $var: "schema.view" }, "active_users"] } }, then: { $error: 403, message: "only active_users" } },
    { $setVars: { "query.where": { name: "Grace" } } },
  ];
  const validated = (step: unknown) => resolve({ $database: "validator", ...conn, rows, do: [step] }, {});
  assert.deepEqual(names(await validated({ $querySelect: "active_users", ...conn })), ["Grace"]);
  await assert.rejects(validated({ $querySelect: "members", ...conn }), /only active_users/);
});

test("a validator's structure steps authorize each change to a view", async () => {
  const context = { seen: [] as unknown[], allow: false };
  const structure = [
    { $push: [{ $var: "seen" }, { $concat: [{ $var: "operation" }, " ", { $var: "view" }, " ", { $var: "schema.from" }] }] },
    { $if: { $not: { $var: "allow" } }, then: { $error: 403, message: "structure is admin-only" } },
  ];
  const validated = (step: unknown) => resolve({ $database: "validator", ...conn, structure, do: [step] }, context);

  const doc = { view: "audited_view", from: "users", columns: ["name"] };
  await assert.rejects(validated({ $viewCreate: doc, ...conn }), /admin-only/);
  assert.equal(DatabaseViewNode.get(registry, "audited_view"), undefined, "a refused document is not registered");
  context.allow = true;
  await validated({ $viewCreate: doc, ...conn });
  await validated({ $viewSync: "audited_view", ...conn });
  await validated({ $viewDrop: "audited_view", ...conn });
  assert.deepEqual(context.seen, ["create audited_view users", "create audited_view users", "sync audited_view users", "drop audited_view users"]);
  assert.equal(await resolve({ $includes: [{ $database: "views", ...conn }, "audited_view"] }, {}), false);

  // Under a validator, a view may not hand out the catalog.
  const catalog = { view: "leak", from: "users", leftJoin: [{ table: "sqlite_master", on: { "users.name": "sqlite_master.name" } }] };
  await assert.rejects(validated({ $viewCreate: catalog, ...conn }), /reads "sqlite_master", the database's own catalog/);
});

test("materialized views are PostgreSQL's", async () => {
  await assert.rejects(resolve({ $viewCreate: { view: "stored", from: "users", materialized: true }, ...conn }, {}), /materialized, which only PostgreSQL has/);
  assert.equal(DatabaseViewNode.get(registry, "stored"), undefined);
  await assert.rejects(resolve({ $viewRefresh: "active_users", ...conn }, {}), /only PostgreSQL has materialized views/);
});

test("a view document registers as view/<name> and validates rows", async () => {
  await resolve({ $schema: "register", schema: { view: "checked", from: "users", required: ["name"], properties: { name: { type: "string" } } } }, {});
  assert.ok(DatabaseViewNode.get(registry, "checked"));
  const result = await resolve({ $schema: "validate", schema: "view/checked", data: {} }, {}) as { valid: boolean };
  assert.equal(result.valid, false);
  await assert.rejects(resolve({ $schema: "register", schema: { $id: "x", view: "v", from: "t" } }, {}), /leave `\$id` out of a view document/);
  await assert.rejects(resolve({ $schema: "register", schema: { table: "t", properties: {}, view: "v", from: "t" } }, {}), /a table or a view, not both/);
});
