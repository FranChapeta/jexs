import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createResolver, coreNodes } from "@jexs/core";
import { serverNodes } from "../src/index.js";
import { DatabaseTableNode } from "../src/nodes/DatabaseTable.js";
import { DatabaseQueryNode } from "../src/nodes/DatabaseQuery.js";

// The registry is the resolver's own, so lookups go through a context attached to it.
const registry = {};
const resolve = createResolver([...coreNodes(), ...serverNodes({ root: "." })], { context: registry });
// A file, not `:memory:`: each pooled connection would open its own empty in-memory database.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jexs-query-"));
const conn = { connection: "query-test" };

after(async () => {
  await resolve({ $database: "close", connection: "query-test" }, {});
  resolve.destroy();
  await fs.rm(dir, { recursive: true, force: true });
});

test("a query step runs end to end against sqlite", async () => {
  const context = {};
  await resolve({ $database: "connect", connection: "query-test", type: "sqlite", filename: path.join(dir, "test.db") }, context);
  await resolve({ $table: "sync", ...conn, schema: {
    table: "people",
    properties: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      name: { type: "string" },
      email: { type: "string" },
    },
  } }, context);
  await resolve({ $query: "insert", ...conn, table: "people", data: [{ name: "Ada", email: "ada@x" }, { name: "Grace", email: "grace@x" }] }, context);

  const rows = await resolve({ $query: "select", ...conn, table: "people", orderBy: { name: "asc" } }, context);
  assert.deepEqual((rows as Array<{ name: string }>).map(r => r.name), ["Ada", "Grace"]);
  assert.equal(await resolve({ $query: "count", ...conn, table: "people" }, context), 2);

  // Column names and `where` operators are plain data, even when they share a name with an op.
  const grace = await resolve({ $query: "select", ...conn, table: "people", first: true,
    where: { email: "grace@x", id: { gt: 0, in: [1, 2] } } }, context);
  assert.equal((grace as { name: string }).name, "Grace");

  // Expressions resolve at any depth of a clause, operator objects and `or` lists included.
  const ada = await resolve({ $query: "select", ...conn, table: "people", first: true,
    where: { or: [{ email: { $var: "who" } }, { id: { lt: { $var: "min" } } }] } }, { who: "ada@x", min: 0 });
  assert.equal((ada as { name: string }).name, "Ada");
});

test("every condition in a where applies: each operator on a column, and or/and beside other columns", async () => {
  const names = async (where: unknown) =>
    ((await resolve({ $query: "select", ...conn, table: "people", where, orderBy: { name: "asc" } }, {})) as Array<{ name: string }>)
      .map(r => r.name);

  assert.deepEqual(await names({ id: { gt: 0, lt: 2 } }), ["Ada"]);
  assert.deepEqual(await names({ id: { gte: 1, in: [2] } }), ["Grace"]);
  assert.deepEqual(await names({ name: { like: "%a%", neq: "Ada" } }), ["Grace"]);
  assert.deepEqual(await names({ name: "Grace", or: [{ id: 1 }, { id: 2 }] }), ["Grace"]);
  assert.deepEqual(await names({ and: [{ name: "Grace" }], or: [{ id: 1 }, { id: 2 }] }), ["Grace"]);
  assert.deepEqual(await names({ email: { isNull: false } }), ["Ada", "Grace"]);
  await assert.rejects(names({ id: { gtt: 1 } }), /id: unknown operator "gtt"/);
});

test("validators authorize every row query: global first, then the table's own", async () => {
  // `seen` is shared by reference with each validator's context, so their writes show here.
  const context = { seen: { global: "", table: "" } };
  const table = [{ $setVars: { "seen.table": { $concat: [{ $var: "operation" }, ":", { $var: "query.table" }] } } }];
  await resolve({ $query: "validator", do: [
    { $setVars: { "seen.global": { $concat: [{ $var: "operation" }, ":", { $var: "schema.table" }] } } },
    { $if: { $eq: [{ $var: "operation" }, "delete"] }, then: { $error: 403, message: "no deletes" } },
    // Narrow every select on notes to one author, the way a row-level policy would.
    { $if: { $and: [{ $eq: [{ $var: "operation" }, "select"] }, { $eq: [{ $var: "query.table" }, "notes"] }] },
      then: { $setVars: { "query.where": { author: "ada" } } } },
  ] }, context);
  try {
    // Structure is the app's own setup, so no validator runs for it.
    await resolve({ $table: "create", ...conn, schema: {
      table: "notes", validator: table,
      properties: { id: { type: "integer", primaryKey: true, autoIncrement: true }, author: { type: "string" } },
    } }, context);
    assert.deepEqual(context.seen, { global: "", table: "" });
    assert.deepEqual(DatabaseTableNode.get(registry, "notes")?.validator, table);

    await resolve({ $query: "insert", ...conn, table: "notes", data: [{ author: "ada" }, { author: "bob" }] }, context);
    assert.deepEqual(context.seen, { global: "insert:notes", table: "insert:notes" });

    const rows = await resolve({ $query: "select", ...conn, table: "notes" }, context);
    assert.deepEqual((rows as Array<{ author: string }>).map(r => r.author), ["ada"]);

    await assert.rejects(resolve({ $query: "delete", ...conn, table: "notes", where: { author: "bob" } }, context), /no deletes/);
    assert.equal(await resolve({ $query: "count", ...conn, table: "notes", system: true }, context), 2);
  } finally {
    await resolve({ $query: "validator", do: null }, {});
  }
});

test("create applies a composite primary key, and MySQL-only options elsewhere are ignored", async () => {
  await resolve({ $table: "create", ...conn, schema: {
    table: "memberships", primaryKey: ["team", "person"], options: { engine: "InnoDB", charset: "utf8mb4" },
    properties: { team: { type: "string" }, person: { type: "string" } },
  } }, {});
  await resolve({ $query: "insert", ...conn, table: "memberships", data: { team: "a", person: "ada" } }, {});
  await assert.rejects(resolve({ $query: "insert", ...conn, table: "memberships", data: { team: "a", person: "ada" } }, {}));
  await resolve({ $query: "insert", ...conn, table: "memberships", data: { team: "b", person: "ada" } }, {});
});

// Structure changes return what they changed, not a status object, and a
// failure throws instead of being recorded and passed over.
test("create, sync, alter, rename and drop return what they changed, and a failure throws", async () => {
  const schema = { table: "gadgets", properties: { name: { type: "string" } } };
  assert.equal(await resolve({ $table: "create", ...conn, schema }, {}), "gadgets");
  await assert.rejects(async () => resolve({ $table: "create", ...conn, schema }, {}), /already exists/);
  assert.deepEqual(await resolve({ $table: "sync", ...conn, schema }, {}), [], "already there");
  assert.equal(await resolve({ $table: "exists", ...conn, table: "gadgets" }, {}), true);

  const alter = { $table: "alter", ...conn, table: "gadgets", add: { size: { type: "integer" } } };
  assert.equal(await resolve(alter, {}), null);
  await assert.rejects(async () => resolve(alter, {}), /size/, "a column that exists is an error");
  await assert.rejects(async () => resolve({ $table: "alter", ...conn, table: "gadgets" }, {}), /alter needs a change/);

  assert.equal(await resolve({ $table: "rename", ...conn, table: "gadgets", to: "widgets" }, {}), "widgets");
  const tables = await resolve({ $table: "list", ...conn }, {}) as string[];
  assert.ok(tables.includes("widgets") && !tables.includes("gadgets"), tables.join(", "));

  assert.equal(await resolve({ $table: "drop", ...conn, table: "widgets" }, {}), null);
  assert.equal(await resolve({ $table: "exists", ...conn, table: "widgets" }, {}), false);

  await assert.rejects(
    async () => resolve({ $table: "sync", ...conn, schema: {
      table: "broken", properties: { name: { type: "string" } }, indexes: { by_missing: { columns: ["nope"] } },
    } }, {}),
    /nope/,
  );
  await resolve({ $schema: "unregister", id: "table/broken" }, {});
});

// The migration a schema change needs: add a column as optional, fill it, then
// make it NOT NULL; and rename, drop and reindex along the way.
test("alter adds, renames, changes and drops columns and indexes, in order", async () => {
  const info = async () => Object.fromEntries(
    (await resolve({ $database: "raw", ...conn, sql: "PRAGMA table_info(accounts)" }, {}) as Array<{ name: string; notnull: number }>)
      .map(c => [c.name, c.notnull]),
  );
  await resolve({ $table: "create", ...conn, schema: {
    table: "accounts",
    properties: { id: { type: "integer", primaryKey: true, autoIncrement: true }, mail: { type: "string" }, legacy: { type: "string" } },
    indexes: { by_mail: { type: "unique", columns: "mail" } },
  } }, {});
  await resolve({ $query: "insert", ...conn, table: "accounts", data: { mail: "ada@x", legacy: "1" } }, {});

  await resolve({ $table: "alter", ...conn, table: "accounts", add: { nick: { type: "string" } } }, {});
  await resolve({ $database: "raw", ...conn, sql: "UPDATE accounts SET nick = 'ada'" }, {});
  await resolve({ $table: "alter", ...conn, table: "accounts",
    dropIndexes: ["by_mail"],
    rename: { mail: "email" },
    change: { nick: { type: "string" } }, required: ["nick"],
    drop: ["legacy"],
    addIndexes: { by_email: { type: "unique", columns: "email" } },
  }, {});

  const { email, nick, legacy } = await info();
  assert.deepEqual({ email, nick, legacy }, { email: 0, nick: 1, legacy: undefined });
  const row = await resolve({ $query: "select", ...conn, table: "accounts", first: true }, {});
  assert.deepEqual(row, { id: 1, email: "ada@x", nick: "ada" });
  const insert = (data: object) => resolve({ $database: "raw", ...conn, sql: "INSERT INTO accounts (email, nick) VALUES (?, ?)", bindings: Object.values(data) }, {});
  await assert.rejects(insert({ email: "ada@x", nick: "b" }), /UNIQUE/);
  await assert.rejects(insert({ email: "b@x", nick: null }), /NOT NULL/);

  // A column named wrongly is refused before anything changes, on every database.
  const alter = (changes: object) => resolve({ $table: "alter", ...conn, table: "accounts", ...changes }, {});
  await assert.rejects(alter({ drop: ["nowhere"] }), /no column "nowhere" to drop in "accounts"/);
  await assert.rejects(alter({ add: { nick: { type: "string" } } }), /a column "nick" already exists, so cannot add/);
  await assert.rejects(alter({ rename: { email: "mail" }, change: { email: { type: "string" } } }), /no column "email" to change/);
  await assert.rejects(alter({ add: { odd: { sqlType: "nope" } } }), /column "odd" has an unknown sqlType "nope"/);

  // In a transaction an alter is all or nothing: the index fails, so the rename
  // and the change (a table rebuild on SQLite) before it are undone.
  await assert.rejects(resolve({ $database: "transaction", ...conn, do: [{ $table: "alter", ...conn, table: "accounts",
    rename: { email: "mail" }, change: { nick: { type: "string" } }, addIndexes: { broken: { columns: "nowhere" } },
  }] }, {}), /nowhere/);
  const after = await info();
  assert.deepEqual({ email: after.email, mail: after.mail, nick: after.nick }, { email: 0, mail: undefined, nick: 1 });
});

test("a transaction commits its steps together, or rolls them all back", async () => {
  await resolve({ $table: "create", ...conn, schema: {
    table: "ledger", properties: { id: { type: "integer", primaryKey: true, autoIncrement: true }, amount: { type: "integer" } },
  } }, {});
  const insert = (amount: number) => ({ $query: "insert", ...conn, table: "ledger", data: { amount } });
  const count = () => resolve({ $query: "count", ...conn, table: "ledger" }, {});

  assert.equal(await resolve({ $database: "transaction", ...conn, do: [insert(1), insert(2), { $concat: ["done"] }] }, {}), "done");
  assert.equal(await count(), 2);

  await assert.rejects(resolve({ $database: "transaction", ...conn, do: [insert(3), { $error: 500, message: "boom" }] }, {}), /boom/);
  assert.equal(await count(), 2, "rolled back");

  // A nested transaction is a savepoint: its failure, caught, undoes only its own steps.
  await resolve({ $database: "transaction", ...conn, do: [
    insert(4),
    { $database: "transaction", ...conn, do: [insert(5), { $error: 500 }], $catch: [{ $concat: ["caught"] }] },
  ] }, {});
  assert.deepEqual(
    (await resolve({ $query: "select", ...conn, table: "ledger", orderBy: { id: "asc" } }, {}) as Array<{ amount: number }>).map(r => r.amount),
    [1, 2, 4],
  );

  // Structure changes join it too.
  await assert.rejects(resolve({ $database: "transaction", ...conn, do: [
    { $table: "alter", ...conn, table: "ledger", add: { note: { type: "string" } } },
    { $error: 500 },
  ] }, {}));
  assert.equal(Object.keys(await resolve({ $query: "select", ...conn, table: "ledger", first: true }, {}) as object).includes("note"), false);
});

test("the $table validator authorizes each change to a table's structure", async () => {
  // `seen` is appended to in place, so the validator's records show here.
  const context = { seen: [] as unknown[], allow: false };
  await resolve({ $table: "validator", do: [
    { $push: [{ $var: "seen" }, { $concat: [{ $var: "operation" }, " ", { $var: "table" }, " ", { $var: "schema.table" }, " ", { $stringify: { $var: "changes" } }] }] },
    { $if: { $not: { $var: "allow" } }, then: { $error: 403, message: "structure is admin-only" } },
  ] }, context);
  try {
    const schema = { table: "audited", properties: { name: { type: "string" } } };
    await assert.rejects(resolve({ $table: "create", ...conn, schema }, context), /admin-only/);
    assert.equal(DatabaseTableNode.get(registry, "audited"), undefined, "a refused document is not registered");
    assert.equal(await resolve({ $table: "exists", ...conn, table: "audited" }, context), false);

    assert.equal(await resolve({ $table: "create", ...conn, schema, system: true }, context), "audited");
    context.allow = true;
    await resolve({ $table: "alter", ...conn, table: "audited", add: { age: { type: "integer" } } }, context);
    await resolve({ $table: "rename", ...conn, table: "audited", to: "audited2" }, context);
    await resolve({ $table: "drop", ...conn, table: "audited2" }, context);
    await resolve({ $table: "list", ...conn }, context);
    assert.deepEqual(context.seen, [
      "create audited audited ",
      "alter audited audited {\"add\":{\"age\":{\"type\":\"integer\"}}}",
      "rename audited audited {\"to\":\"audited2\"}",
      "drop audited2  ",
    ]);
  } finally {
    await resolve({ $table: "validator", do: null }, {});
  }
});

test("sync adds the columns and indexes a table lacks, and warns about what only alter may change", async () => {
  const warnings: string[] = [];
  const logger = { info: () => {}, warn: (message: string) => { warnings.push(message); }, error: () => {} };
  const own = createResolver([...coreNodes(), ...serverNodes({ root: "." })], { logger });
  const at = { connection: "sync-test" };
  try {
    await own({ $database: "connect", ...at, type: "sqlite", filename: path.join(dir, "sync.db") }, {});
    await own({ $table: "create", ...at, schema: { table: "pets", properties: { name: { type: "string" }, legacy: { type: "string" } } } }, {});
    await own({ $query: "insert", ...at, table: "pets", data: { name: "rex" } }, {});

    await own({ $table: "sync", ...at, schema: {
      table: "pets", required: ["name", "owner"],
      properties: { name: { type: "string" }, owner: { type: "string" }, born: { type: "string", sqlType: "timestamp", sqlDefault: "CURRENT_TIMESTAMP" } },
      indexes: { by_owner: { columns: "owner" } },
    } }, {});

    const indexes = await own({ $database: "raw", ...at, sql: "PRAGMA index_list(pets)" }, {}) as Array<{ name: string }>;
    assert.deepEqual(indexes.map(i => i.name), ["by_owner"]);
    const columns = await own({ $database: "raw", ...at, sql: "PRAGMA table_info(pets)" }, {}) as Array<{ name: string; notnull: number }>;
    assert.deepEqual(columns.map(c => [c.name, c.notnull]), [["name", 0], ["legacy", 0], ["owner", 0], ["born", 0]]);
    assert.equal(warnings.length, 2, warnings.join("\n"));
    assert.match(warnings[0], /added required columns \[owner\] as nullable/);
    assert.match(warnings[1], /columns \[legacy\] are not in its document/);
  } finally {
    await own({ $database: "close", ...at }, {});
    own.destroy();
  }
});

test("sync without a document syncs what is registered: one table by name, or all of them", async () => {
  await resolve({ $schema: "register", schema: { table: "later_a", properties: { name: { type: "string" } } } }, {});
  await resolve({ $schema: "register", schema: { table: "later_b", properties: { name: { type: "string" } } } }, {});
  assert.deepEqual(await resolve({ $table: "sync", ...conn, schema: "later_a" }, {}), ["later_a"]);
  const all = await resolve({ $table: "sync", ...conn }, {}) as string[];
  assert.ok(all.includes("later_b") && !all.includes("later_a"), all.join(", "));
  await assert.rejects(async () => resolve({ $table: "sync", ...conn, schema: "never" }, {}), /no document registered for table "never"/);
});

test("register reads a directory: table documents by table, others by their $id", async () => {
  const schemas = path.join(dir, "schemas");
  await fs.mkdir(schemas);
  await fs.writeFile(path.join(schemas, "posts.json"), JSON.stringify({ table: "posts", properties: { title: { type: "string" } } }));
  await fs.writeFile(path.join(schemas, "address.json"), JSON.stringify({ $id: "address", type: "object", required: ["city"] }));
  assert.deepEqual(await resolve({ $schema: "register", path: schemas }, {}), ["address", "table/posts"]);
  assert.deepEqual(await resolve({ $table: "sync", ...conn, schema: "posts" }, {}), ["posts"]);
});

test("a schema needs an id, which a table document takes from its table", async () => {
  await assert.rejects(resolve({ $table: "sync", ...conn, schema: { table: 5, properties: {} } }, {}), /needs a `table` name and `properties`/);
  await assert.rejects(resolve({ $schema: "register", schema: { type: "object" } }, {}), /needs an `\$id`/);
  await assert.rejects(resolve({ $schema: "register", schema: { $id: "x", table: "t", properties: {} } }, {}), /leave `\$id` out/);
});

test("a column's SQL default is `sqlDefault`, apart from JSON Schema's `default`", async () => {
  await resolve({ $table: "create", ...conn, schema: {
    table: "stamps",
    properties: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      label: { type: "string", default: "untitled" },
      made: { type: "string", sqlType: "timestamp", sqlDefault: "CURRENT_TIMESTAMP" },
    },
  } }, {});
  await resolve({ $query: "insert", ...conn, table: "stamps", data: { label: "a" } }, {});
  const row = await resolve({ $query: "select", ...conn, table: "stamps", first: true }, {}) as { made: unknown };
  assert.match(String(row.made), /^\d{4}-\d{2}-\d{2}/);
});

// The registry keeps its own copy of a document: the one a template wrote is a
// literal of that template, and steps may change what they read.
test("registering leaves the written document unchanged, and list hands out copies", async () => {
  const step = { $schema: "register", schema: { table: "kept", properties: { name: { type: "string" } } } };
  assert.deepEqual(await resolve(step, {}), ["table/kept"]);
  assert.deepEqual(step.schema, { table: "kept", properties: { name: { type: "string" } } });

  const all = await resolve({ $schema: "list" }, {}) as Array<{ table?: string; properties: Record<string, unknown> }>;
  all.find(doc => doc.table === "kept")!.properties.extra = { type: "string" };
  assert.equal(DatabaseTableNode.get(registry, "kept")?.properties?.extra, undefined);
});

// A step producing the document (`$var`, a `$file` with `data: true`) resolves
// first; what it hands back is registered like a literal.
test("register takes a document from a step, and unregister forgets it", async () => {
  const doc = { table: "from_step", properties: { name: { type: "string" } } };
  assert.deepEqual(await resolve({ $schema: "register", schema: { $var: "doc" } }, { doc }), ["table/from_step"]);
  assert.ok(DatabaseTableNode.get(registry, "from_step"));
  assert.equal(await resolve({ $schema: "unregister", id: "table/from_step" }, {}), true);
  assert.equal(await resolve({ $schema: "unregister", id: "table/from_step" }, {}), false);
  assert.equal(DatabaseTableNode.get(registry, "from_step"), undefined);
});

test("a validator that changes `schema` does not change the registered table", async () => {
  await resolve({ $table: "create", ...conn, schema: {
    table: "guarded",
    properties: { id: { type: "integer", primaryKey: true, autoIncrement: true }, name: { type: "string" } },
    validator: [{ $setVars: { "schema.properties.injected": { type: "string" } } }],
  } }, {});
  await resolve({ $query: "select", ...conn, table: "guarded" }, {});
  assert.equal(DatabaseTableNode.get(registry, "guarded")?.properties?.injected, undefined);
});

test("validate checks a value against a registered schema by id, or one written out", async () => {
  await resolve({ $schema: "register", schema: { table: "signups", required: ["email"], properties: { email: { type: "string" } } } }, {});
  assert.deepEqual(await resolve({ $schema: "validate", schema: "table/signups", data: { email: "a@b.c" } }, {}), { valid: true, errors: [] });
  const missing = await resolve({ $schema: "validate", schema: "table/signups", data: {} }, {}) as { valid: boolean };
  assert.equal(missing.valid, false);

  // A schema written out keeps its `$` keywords: `$ref` reaches a registered one.
  const schema = { $ref: "table/signups" };
  const viaRef = await resolve({ $schema: "validate", schema, data: { $var: "row" } }, { row: { email: 5 } }) as { valid: boolean; errors: Array<{ path: string }> };
  assert.equal(viaRef.valid, false);
  assert.equal(viaRef.errors[0].path, "email");

  // An unknown id is the caller's mistake, not invalid data.
  await assert.rejects(async () => resolve({ $schema: "validate", schema: "nowhere", data: 1 }, {}), /No schema is registered as "nowhere"/);
});

// Route bodies validate against the same registered schemas.
test("a route body can $ref a table's document", async () => {
  await resolve({ $schema: "register", schema: { table: "members", required: ["name"], properties: { name: { type: "string" } } } }, {});
  const routes = { methods: { POST: { body: { $ref: "table/members" }, do: [{ $concat: ["ok"] }] } } };
  const request = (body: unknown) => ({ request: { method: "POST", path: "/", body } });
  assert.equal(await resolve({ $routes: routes }, request({ name: "ada" })), "ok");
  await assert.rejects(async () => resolve({ $routes: routes }, request({})), (err: { status?: number }) => err.status === 400);
});

// Schemas and the global validator belong to the resolver that registered
// them, so they never judge another resolver's queries.
test("two resolvers keep separate schemas and global validators", async () => {
  const a = {};
  const b = {};
  const ra = createResolver([...coreNodes(), ...serverNodes()], { context: a });
  const rb = createResolver([...coreNodes(), ...serverNodes()], { context: b });
  try {
    await ra({ $schema: "register", schema: { table: "isolated", properties: { email: { type: "string" } }, required: ["email"] } }, {});
    await ra({ $query: "validator", do: [{ $error: 403 }] }, {});

    assert.ok(DatabaseTableNode.get(a, "isolated"));
    assert.equal(DatabaseTableNode.get(b, "isolated"), undefined);
    assert.deepEqual(await rb({ $schema: "list" }, {}), []);
    assert.equal((rb.nodeFor("query") as DatabaseQueryNode).globalValidator, null);
  } finally {
    ra.destroy();
    rb.destroy();
  }
});
