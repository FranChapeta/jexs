import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createResolver, coreNodes } from "@jexs/core";
import type { Knex } from "knex";
import { serverNodes } from "../src/index.js";
import { DatabaseNode } from "../src/nodes/Database.js";
import { DatabaseTableNode } from "../src/nodes/DatabaseTable.js";

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
  await resolve({ $tableSync: {
    table: "people",
    properties: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      name: { type: "string" },
      email: { type: "string" },
    },
  }, ...conn }, context);
  await resolve({ $queryInsert: "people", ...conn, data: [{ name: "Ada", email: "ada@x" }, { name: "Grace", email: "grace@x" }] }, context);

  const rows = await resolve({ $querySelect: "people", ...conn, orderBy: { name: "asc" } }, context);
  assert.deepEqual((rows as Array<{ name: string }>).map(r => r.name), ["Ada", "Grace"]);
  assert.equal(await resolve({ $queryCount: "people", ...conn }, context), 2);

  // Column names and `where` operators are plain data, even when they share a name with an op.
  const grace = await resolve({ $querySelect: "people", ...conn, first: true,
    where: { email: "grace@x", id: { gt: 0, in: [1, 2] } } }, context);
  assert.equal((grace as { name: string }).name, "Grace");

  // Expressions resolve at any depth of a clause, operator objects and `or` lists included.
  const ada = await resolve({ $querySelect: "people", ...conn, first: true,
    where: { or: [{ email: { $var: "who" } }, { id: { lt: { $var: "min" } } }] } }, { who: "ada@x", min: 0 });
  assert.equal((ada as { name: string }).name, "Ada");

  // The table is the op's value, and may come from an expression.
  assert.equal(await resolve({ $queryCount: { $var: "table" }, ...conn }, { table: "people" }), 2);
  await assert.rejects(resolve({ $queryCount: 5, ...conn }, {}), /\$queryCount takes a table name, got number/);
});

test("a boolean column takes and gives booleans, whatever the database stores", async () => {
  await resolve({ $tableSync: {
    table: "flags",
    properties: { id: { type: "integer", primaryKey: true, autoIncrement: true }, on: { type: "boolean" }, label: { type: "string" } },
  }, ...conn }, {});
  await resolve({ $queryInsert: "flags", ...conn, data: [{ on: true, label: "a" }, { on: "1", label: "b" }, { on: 0, label: "c" }, { on: "false", label: "d" }] }, {});

  const rows = await resolve({ $querySelect: "flags", ...conn, orderBy: { id: "asc" } }, {}) as Array<{ on: unknown }>;
  assert.deepEqual(rows.map(r => r.on), [true, true, false, false]);
  const first = await resolve({ $querySelect: "flags", ...conn, first: true, where: { label: "c" } }, {}) as { on: unknown };
  assert.equal(first.on, false);
  assert.equal(await resolve({ $queryCount: "flags", ...conn, where: { on: true } }, {}), 2);

  await resolve({ $queryUpdate: "flags", ...conn, where: { label: "c" }, data: { on: "on" } }, {});
  const updated = await resolve({ $querySelect: "flags", ...conn, first: true, where: { label: "c" } }, {}) as { on: unknown };
  assert.equal(updated.on, true);
});

test("every condition in a where applies: each operator on a column, and or/and beside other columns", async () => {
  const names = async (where: unknown) =>
    ((await resolve({ $querySelect: "people", ...conn, where, orderBy: { name: "asc" } }, {})) as Array<{ name: string }>)
      .map(r => r.name);

  assert.deepEqual(await names({ id: { gt: 0, lt: 2 } }), ["Ada"]);
  assert.deepEqual(await names({ id: { gte: 1, in: [2] } }), ["Grace"]);
  assert.deepEqual(await names({ name: { like: "%a%", neq: "Ada" } }), ["Grace"]);
  assert.deepEqual(await names({ name: "Grace", or: [{ id: 1 }, { id: 2 }] }), ["Grace"]);
  assert.deepEqual(await names({ and: [{ name: "Grace" }], or: [{ id: 1 }, { id: 2 }] }), ["Grace"]);
  assert.deepEqual(await names({ email: { isNull: false } }), ["Ada", "Grace"]);
  await assert.rejects(names({ id: { gtt: 1 } }), /id: unknown operator "gtt"/);
  await assert.rejects(names({ email: { isNotNull: true } }), /email: unknown operator "isNotNull"/);
  await assert.rejects(names({ email: { isNull: "false" } }), /email.isNull: expected true or false, got string/);
});

test("groupConcat joins a column per group, with a separator of its own", async () => {
  const row = await resolve({ $querySelect: "people", ...conn, columns: ["id"], groupConcat: { names: ["name", "|"], emails: "email" }, first: true }, {}) as { names: string; emails: string };
  assert.deepEqual(row.names.split("|").sort(), ["Ada", "Grace"]);
  assert.deepEqual(row.emails.split(",").sort(), ["ada@x", "grace@x"]);
});

test("update needs a where, and an empty one reaches every row", async () => {
  await assert.rejects(resolve({ $queryUpdate: "people", ...conn, data: { email: "x" } }, {}), /\$queryUpdate needs `where`; `where: {}` updates every row/);
  await assert.rejects(resolve({ $queryDelete: "people", ...conn }, {}), /\$queryDelete needs `where`/);
  assert.equal(await resolve({ $queryUpdate: "people", ...conn, where: {}, increment: { id: 0 } }, {}), 2);
});

test("validators authorize every row query: the connection's first, then the table's own", async () => {
  // `seen` is shared by reference with each validator's context, so their writes show here.
  const context = { seen: { global: "", table: "" } };
  const table = [{ $setVars: { "seen.table": { $concat: [{ $var: "operation" }, ":", { $var: "query.table" }] } } }];
  await resolve({ $database: "validator", ...conn, rows: [
    { $setVars: { "seen.global": { $concat: [{ $var: "operation" }, ":", { $var: "schema.table" }] } } },
    { $if: { $eq: [{ $var: "operation" }, "delete"] }, then: { $error: 403, message: "no deletes" } },
    // Narrow every select on notes to one author, the way a row-level policy would.
    { $if: { $and: [{ $eq: [{ $var: "operation" }, "select"] }, { $eq: [{ $var: "query.table" }, "notes"] }] },
      then: { $setVars: { "query.where": { author: "ada" } } } },
  ] }, context);
  try {
    // Structure is the app's own setup, so no validator runs for it.
    await resolve({ $tableCreate: {
      table: "notes", validator: table,
      properties: { id: { type: "integer", primaryKey: true, autoIncrement: true }, author: { type: "string" } },
    }, ...conn }, context);
    assert.deepEqual(context.seen, { global: "", table: "" });
    assert.deepEqual(DatabaseTableNode.get(registry, "notes")?.validator, table);

    await resolve({ $queryInsert: "notes", ...conn, data: [{ author: "ada" }, { author: "bob" }] }, context);
    assert.deepEqual(context.seen, { global: "insert:notes", table: "insert:notes" });

    const rows = await resolve({ $querySelect: "notes", ...conn }, context);
    assert.deepEqual((rows as Array<{ author: string }>).map(r => r.author), ["ada"]);

    await assert.rejects(resolve({ $queryDelete: "notes", ...conn, where: { author: "bob" } }, context), /no deletes/);
    assert.equal(await resolve({ $queryCount: "notes", ...conn, system: true }, context), 2);
  } finally {
    await resolve({ $database: "validator", ...conn, rows: [] }, {});
  }
});

// A validator runs in a copy of the caller's context: `query` is the object
// that runs, a query inside skips validation instead of recursing, and none of
// its writes reach the caller, not even with `$bubble`.
test("a validator changes the data a query writes and queries inside, but writes nothing of the caller's", async () => {
  await resolve({ $tableCreate: { table: "drafts", properties: {
    id: { type: "integer", primaryKey: true, autoIncrement: true }, author: { type: "string" }, stamp: { type: "string" },
  } }, ...conn }, {});
  await resolve({ $database: "validator", ...conn, rows: [
    { $if: { $eq: [{ $var: "operation" }, "insert"] }, then: { $setVars: { "query.data.stamp": "checked" } } },
    { $queryCount: "drafts", ...conn, $as: "existing" },
    { $concat: [{ $var: "operation" }, ":", { $var: "existing" }], $as: "lastCheck", $bubble: true },
  ] }, {});
  const context: Record<string, unknown> = {};
  try {
    // Inside a loop, so there is a scope between the query and the caller that a bubble would reach.
    await resolve({ $foreach: [1], do: [{ $queryInsert: "drafts", ...conn, data: { author: "ada" } }] }, context);
    assert.equal(context.lastCheck, undefined, "a validator writes nothing of the caller's");
    assert.equal(context.existing, undefined);
    const row = await resolve({ $querySelect: "drafts", ...conn, first: true, system: true }, {});
    assert.deepEqual(row, { id: 1, author: "ada", stamp: "checked" });
  } finally {
    await resolve({ $database: "validator", ...conn, rows: [] }, {});
  }
});

test("a query reaches the database's own catalog only with system: true", async () => {
  const refused = /is the database's own catalog, which only a step with `system: true` may query/;
  await assert.rejects(resolve({ $querySelect: "sqlite_master", ...conn }, {}), refused);
  await assert.rejects(resolve({ $queryCount: "main.sqlite_master", ...conn }, {}), refused);
  await assert.rejects(resolve({ $querySelect: "information_schema.tables as t", ...conn }, {}), refused);
  await assert.rejects(resolve({ $querySelect: "people", ...conn,
    innerJoin: [{ table: "sqlite_master", on: { "people.name": "sqlite_master.name" } }] }, {}), refused);
  await assert.rejects(resolve({ $querySelect: "people", ...conn, leftJoin: [{ table: 5, on: {} }] }, {}), /a join's `table` must be a table name/);
  const tables = await resolve({ $querySelect: "sqlite_master", ...conn, system: true, where: { type: "table", name: "people" } }, {}) as unknown[];
  assert.equal(tables.length, 1);
});

test("validators belong to their connection, and one is cleared with an empty list", async () => {
  const other = { connection: "query-other" };
  await resolve({ $database: "connect", ...other, type: "sqlite", filename: path.join(dir, "other.db") }, {});
  try {
    await resolve({ $tableCreate: { table: "pads", properties: { name: { type: "string" } } }, ...other }, {});
    await assert.rejects(async () => resolve({ $database: "validator", ...other }, {}), /needs `rows` or `structure` steps/);
    await resolve({ $database: "validator", ...other, rows: [{ $error: 403, message: "read-only" }] }, {});
    await assert.rejects(resolve({ $queryCount: "pads", ...other }, {}), /read-only/);
    assert.equal(await resolve({ $queryCount: "people", ...conn }, {}), 2, "the other connection is unaffected");
    // Setting `structure` leaves `rows` as it was.
    await resolve({ $database: "validator", ...other, structure: [] }, {});
    await assert.rejects(resolve({ $queryCount: "pads", ...other }, {}), /read-only/);
    await resolve({ $database: "validator", ...other, rows: [] }, {});
    assert.equal(await resolve({ $queryCount: "pads", ...other }, {}), 0);
  } finally {
    await resolve({ $database: "close", ...other }, {});
  }
});

test("create applies a composite primary key, and MySQL-only options elsewhere are ignored", async () => {
  await resolve({ $tableCreate: {
    table: "memberships", primaryKey: ["team", "person"], options: { engine: "InnoDB", charset: "utf8mb4" },
    properties: { team: { type: "string" }, person: { type: "string" } },
  }, ...conn }, {});
  await resolve({ $queryInsert: "memberships", ...conn, data: { team: "a", person: "ada" } }, {});
  await assert.rejects(resolve({ $queryInsert: "memberships", ...conn, data: { team: "a", person: "ada" } }, {}));
  await resolve({ $queryInsert: "memberships", ...conn, data: { team: "b", person: "ada" } }, {});
});

// Structure changes return what they changed, not a status object, and a
// failure throws instead of being recorded and passed over.
test("create, sync, alter, rename and drop return what they changed, and a failure throws", async () => {
  const schema = { table: "gadgets", properties: { name: { type: "string" } } };
  assert.equal(await resolve({ $tableCreate: schema, ...conn }, {}), "gadgets");
  await assert.rejects(async () => resolve({ $tableCreate: schema, ...conn }, {}), /already exists/);
  assert.deepEqual(await resolve({ $tableSync: schema, ...conn }, {}), [], "already there");
  const exists = (table: string) => resolve({ $includes: [{ $database: "tables", ...conn }, table] }, {});
  assert.equal(await exists("gadgets"), true);

  const alter = { $tableAlter: "gadgets", ...conn, add: { size: { type: "integer" } } };
  assert.equal(await resolve(alter, {}), null);
  await assert.rejects(async () => resolve(alter, {}), /size/, "a column that exists is an error");
  await assert.rejects(async () => resolve({ $tableAlter: "gadgets", ...conn }, {}), /\$tableAlter needs a change/);

  assert.equal(await resolve({ $tableRename: "gadgets", ...conn, to: "widgets" }, {}), "widgets");
  const tables = await resolve({ $database: "tables", ...conn }, {}) as string[];
  assert.ok(tables.includes("widgets") && !tables.includes("gadgets"), tables.join(", "));

  assert.equal(await resolve({ $tableDrop: "widgets", ...conn }, {}), null);
  assert.equal(await exists("widgets"), false);

  await assert.rejects(
    async () => resolve({ $tableSync: {
      table: "broken", properties: { name: { type: "string" } }, indexes: { by_missing: { columns: ["nope"] } },
    }, ...conn }, {}),
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
  await resolve({ $tableCreate: {
    table: "accounts",
    properties: { id: { type: "integer", primaryKey: true, autoIncrement: true }, mail: { type: "string" }, legacy: { type: "string" } },
    indexes: { by_mail: { type: "unique", columns: "mail" } },
  }, ...conn }, {});
  await resolve({ $queryInsert: "accounts", ...conn, data: { mail: "ada@x", legacy: "1" } }, {});

  await resolve({ $tableAlter: "accounts", ...conn, add: { nick: { type: "string" } } }, {});
  await resolve({ $database: "raw", ...conn, sql: "UPDATE accounts SET nick = 'ada'" }, {});
  await resolve({ $tableAlter: "accounts", ...conn,
    dropIndexes: ["by_mail"],
    rename: { mail: "email" },
    change: { nick: { type: "string" } }, required: ["nick"],
    drop: ["legacy"],
    addIndexes: { by_email: { type: "unique", columns: "email" } },
  }, {});

  const { email, nick, legacy } = await info();
  assert.deepEqual({ email, nick, legacy }, { email: 0, nick: 1, legacy: undefined });
  const row = await resolve({ $querySelect: "accounts", ...conn, first: true }, {});
  assert.deepEqual(row, { id: 1, email: "ada@x", nick: "ada" });
  const insert = (data: object) => resolve({ $database: "raw", ...conn, sql: "INSERT INTO accounts (email, nick) VALUES (?, ?)", bindings: Object.values(data) }, {});
  await assert.rejects(insert({ email: "ada@x", nick: "b" }), /UNIQUE/);
  await assert.rejects(insert({ email: "b@x", nick: null }), /NOT NULL/);

  // A column named wrongly is refused before anything changes, on every database.
  const alter = (changes: object) => resolve({ $tableAlter: "accounts", ...conn, ...changes }, {});
  await assert.rejects(alter({ drop: ["nowhere"] }), /no column "nowhere" to drop in "accounts"/);
  await assert.rejects(alter({ add: { nick: { type: "string" } } }), /a column "nick" already exists, so cannot add/);
  await assert.rejects(alter({ rename: { email: "mail" }, change: { email: { type: "string" } } }), /no column "email" to change/);
  await assert.rejects(alter({ add: { odd: { sqlType: "nope" } } }), /column "odd" has an unknown sqlType "nope"/);

  // In a transaction an alter is all or nothing: the index fails, so the rename
  // and the change (a table rebuild on SQLite) before it are undone.
  await assert.rejects(resolve({ $database: "transaction", ...conn, do: [{ $tableAlter: "accounts", ...conn,
    rename: { email: "mail" }, change: { nick: { type: "string" } }, addIndexes: { broken: { columns: "nowhere" } },
  }] }, {}), /nowhere/);
  const after = await info();
  assert.deepEqual({ email: after.email, mail: after.mail, nick: after.nick }, { email: 0, mail: undefined, nick: 1 });
});

test("a transaction commits its steps together, or rolls them all back", async () => {
  await resolve({ $tableCreate: {
    table: "ledger", properties: { id: { type: "integer", primaryKey: true, autoIncrement: true }, amount: { type: "integer" } },
  }, ...conn }, {});
  const insert = (amount: number) => ({ $queryInsert: "ledger", ...conn, data: { amount } });
  const count = () => resolve({ $queryCount: "ledger", ...conn }, {});

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
    (await resolve({ $querySelect: "ledger", ...conn, orderBy: { id: "asc" } }, {}) as Array<{ amount: number }>).map(r => r.amount),
    [1, 2, 4],
  );

  // Structure changes join it too.
  await assert.rejects(resolve({ $database: "transaction", ...conn, do: [
    { $tableAlter: "ledger", ...conn, add: { note: { type: "string" } } },
    { $error: 500 },
  ] }, {}));
  assert.equal(Object.keys(await resolve({ $querySelect: "ledger", ...conn, first: true }, {}) as object).includes("note"), false);
});

test("the connection's structure validator authorizes each change to a table's structure", async () => {
  // `seen` is appended to in place, so the validator's records show here.
  const context = { seen: [] as unknown[], allow: false };
  await resolve({ $database: "validator", ...conn, structure: [
    { $push: [{ $var: "seen" }, { $concat: [{ $var: "operation" }, " ", { $var: "table" }, " ", { $var: "schema.table" }, " ", { $stringify: { $var: "changes" } }] }] },
    { $concat: ["structure"], $as: "leaked", $bubble: true },
    { $if: { $not: { $var: "allow" } }, then: { $error: 403, message: "structure is admin-only" } },
  ] }, context);
  try {
    const schema = { table: "audited", properties: { name: { type: "string" } } };
    await assert.rejects(resolve({ $tableCreate: schema, ...conn }, context), /admin-only/);
    assert.equal(DatabaseTableNode.get(registry, "audited"), undefined, "a refused document is not registered");
    assert.equal(await resolve({ $includes: [{ $database: "tables", ...conn }, "audited"] }, context), false);

    assert.equal(await resolve({ $tableCreate: schema, ...conn, system: true }, context), "audited");
    context.allow = true;
    await resolve({ $tableAlter: "audited", ...conn, add: { age: { type: "integer" } } }, context);
    await resolve({ $tableRename: "audited", ...conn, to: "audited2" }, context);
    await resolve({ $tableDrop: "audited2", ...conn }, context);
    await resolve({ $database: "tables", ...conn }, context);
    assert.deepEqual(context.seen, [
      "create audited audited ",
      "alter audited audited {\"add\":{\"age\":{\"type\":\"integer\"}}}",
      "rename audited audited {\"to\":\"audited2\"}",
      "drop audited2  ",
    ]);
    assert.equal(Reflect.get(context, "leaked"), undefined, "a validator writes nothing of the caller's");
  } finally {
    await resolve({ $database: "validator", ...conn, structure: [] }, {});
  }
});

test("sync adds the columns and indexes a table lacks, and warns about what only alter may change", async () => {
  const warnings: string[] = [];
  const logger = { info: () => {}, warn: (message: string) => { warnings.push(message); }, error: () => {} };
  const own = createResolver([...coreNodes(), ...serverNodes({ root: "." })], { logger });
  const at = { connection: "sync-test" };
  try {
    await own({ $database: "connect", ...at, type: "sqlite", filename: path.join(dir, "sync.db") }, {});
    await own({ $tableCreate: { table: "pets", properties: { name: { type: "string" }, legacy: { type: "string" } } }, ...at }, {});
    await own({ $queryInsert: "pets", ...at, data: { name: "rex" } }, {});

    await own({ $tableSync: {
      table: "pets", required: ["name", "owner"],
      properties: { name: { type: "string" }, owner: { type: "string" }, born: { type: "string", sqlType: "timestamp", sqlDefault: "CURRENT_TIMESTAMP" } },
      indexes: { by_owner: { columns: "owner" } },
    }, ...at }, {});

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

test("sync given a name syncs what is registered: one table by name, or all of them with \"*\"", async () => {
  await resolve({ $schema: "register", schema: { table: "later_a", properties: { name: { type: "string" } } } }, {});
  await resolve({ $schema: "register", schema: { table: "later_b", properties: { name: { type: "string" } } } }, {});
  assert.deepEqual(await resolve({ $tableSync: "later_a", ...conn }, {}), ["later_a"]);
  const all = await resolve({ $tableSync: "*", ...conn }, {}) as string[];
  assert.ok(all.includes("later_b") && !all.includes("later_a"), all.join(", "));
  await assert.rejects(async () => resolve({ $tableSync: "never", ...conn }, {}), /\$tableSync: no document registered for table "never"/);
  await assert.rejects(async () => resolve({ $tableSync: true, ...conn }, {}), /\$tableSync takes a table document or a registered table's name, or "\*"/);
  await assert.rejects(async () => resolve({ $tableCreate: "*", ...conn }, {}), /\$tableCreate: no document registered for table "\*"/);
});

// Each driver hands back raw results in a shape of its own; `raw` gives the rows
// from all of them. Stand-in connections, since only SQLite runs here.
test("raw gives the rows on every database", async () => {
  const node = resolve.nodeFor("database");
  assert.ok(node instanceof DatabaseNode);
  const rows = [{ n: 1 }];
  const fake = (type: "pg" | "mysql", result: unknown) => {
    const knex = { raw: async () => result, destroy: async () => {} } as unknown as Knex;
    node.connections.set(`fake-${type}`, { knex, info: { type, tls: false }, validators: {} });
  };
  fake("pg", { rows, rowCount: 1, command: "SELECT" });
  fake("mysql", [rows, [{ name: "n" }]]);
  try {
    assert.deepEqual(await resolve({ $database: "raw", connection: "fake-pg", sql: "select 1 as n" }, {}), rows);
    assert.deepEqual(await resolve({ $database: "raw", connection: "fake-mysql", sql: "select 1 as n" }, {}), rows);
    assert.deepEqual(await resolve({ $database: "raw", ...conn, sql: "select 1 as n" }, {}), rows);
  } finally {
    node.connections.delete("fake-pg");
    node.connections.delete("fake-mysql");
  }
});

test("connecting under a name already open replaces that connection", async () => {
  const swap = { connection: "swap" };
  await resolve({ $database: "connect", ...swap, filename: path.join(dir, "first.db") }, {});
  try {
    await resolve({ $tableCreate: { table: "only_first", properties: { n: { type: "integer" } } }, ...swap }, {});
    await resolve({ $database: "connect", ...swap, filename: path.join(dir, "second.db") }, {});
    assert.deepEqual(await resolve({ $database: "tables", ...swap }, {}), []);
    assert.equal((await resolve({ $database: "info", ...swap }, {}) as { filename: string }).filename, path.join(dir, "second.db"));
  } finally {
    await resolve({ $database: "close", ...swap }, {});
  }
});

test("an index type other than index or unique is refused, and a null source leaves a computed column unset", async () => {
  await assert.rejects(resolve({ $tableCreate: {
    table: "searchable", properties: { body: { type: "string" } }, indexes: { by_body: { type: "fulltext", columns: "body" } },
  }, ...conn }, {}), /Index "by_body" has an unknown type "fulltext"; it takes "index" or "unique"/);
  await resolve({ $schema: "unregister", id: "table/searchable" }, {});

  await resolve({ $tableCreate: { table: "logins", properties: {
    id: { type: "integer", primaryKey: true, autoIncrement: true },
    password_hash: { type: ["string", "null"], computed: { sha256: "password" } },
  } }, ...conn }, {});
  await resolve({ $queryInsert: "logins", ...conn, data: { password: null } }, {});
  await resolve({ $queryInsert: "logins", ...conn, data: { password: "secret" } }, {});
  const hashes = (await resolve({ $querySelect: "logins", ...conn, orderBy: { id: "asc" } }, {}) as Array<{ password_hash: unknown }>).map(r => r.password_hash);
  assert.equal(hashes[0], null);
  assert.match(String(hashes[1]), /^[0-9a-f]{64}$/);
});

test("register reads a directory: table documents by table, others by their $id", async () => {
  const schemas = path.join(dir, "schemas");
  await fs.mkdir(schemas);
  await fs.writeFile(path.join(schemas, "posts.json"), JSON.stringify({ table: "posts", properties: { title: { type: "string" } } }));
  await fs.writeFile(path.join(schemas, "address.json"), JSON.stringify({ $id: "address", type: "object", required: ["city"] }));
  assert.deepEqual(await resolve({ $schema: "register", path: schemas }, {}), ["address", "table/posts"]);
  assert.deepEqual(await resolve({ $tableSync: "posts", ...conn }, {}), ["posts"]);
});

test("a schema needs an id, which a table document takes from its table", async () => {
  await assert.rejects(resolve({ $tableSync: { table: 5, properties: {} }, ...conn }, {}), /needs a `table` name and `properties`/);
  await assert.rejects(resolve({ $schema: "register", schema: { type: "object" } }, {}), /needs an `\$id`/);
  await assert.rejects(resolve({ $schema: "register", schema: { $id: "x", table: "t", properties: {} } }, {}), /leave `\$id` out/);
});

test("a column's SQL default is `sqlDefault`, apart from JSON Schema's `default`", async () => {
  await resolve({ $tableCreate: {
    table: "stamps",
    properties: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      label: { type: "string", default: "untitled" },
      made: { type: "string", sqlType: "timestamp", sqlDefault: "CURRENT_TIMESTAMP" },
    },
  }, ...conn }, {});
  await resolve({ $queryInsert: "stamps", ...conn, data: { label: "a" } }, {});
  const row = await resolve({ $querySelect: "stamps", ...conn, first: true }, {}) as { made: unknown };
  assert.match(String(row.made), /^\d{4}-\d{2}-\d{2}/);
  // JSON Schema's `default` is not the column's: a row the database fills itself has no label.
  await resolve({ $database: "raw", ...conn, sql: "INSERT INTO stamps (id) VALUES (2)" }, {});
  const raw = await resolve({ $querySelect: "stamps", ...conn, where: { id: 2 }, first: true }, {}) as { label: unknown };
  assert.equal(raw.label, null);
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
  await resolve({ $tableCreate: {
    table: "guarded",
    properties: { id: { type: "integer", primaryKey: true, autoIncrement: true }, name: { type: "string" } },
    validator: [{ $setVars: { "schema.properties.injected": { type: "string" } } }],
  }, ...conn }, {});
  await resolve({ $querySelect: "guarded", ...conn }, {});
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

// Schemas and connections, with their validators, belong to the resolver that
// made them, so they never judge another resolver's queries.
test("two resolvers keep separate schemas and validators", async () => {
  const a = {};
  const b = {};
  const ra = createResolver([...coreNodes(), ...serverNodes()], { context: a });
  const rb = createResolver([...coreNodes(), ...serverNodes()], { context: b });
  const shared = { connection: "isolated", type: "sqlite", filename: path.join(dir, "isolated.db") };
  try {
    await ra({ $schema: "register", schema: { table: "isolated", properties: { email: { type: "string" } }, required: ["email"] } }, {});
    await ra({ $database: "connect", ...shared }, {});
    await rb({ $database: "connect", ...shared }, {});
    await ra({ $tableSync: "isolated", connection: "isolated" }, {});
    await ra({ $database: "validator", connection: "isolated", rows: [{ $error: 403, message: "a's policy" }] }, {});

    assert.ok(DatabaseTableNode.get(a, "isolated"));
    assert.equal(DatabaseTableNode.get(b, "isolated"), undefined);
    assert.deepEqual(await rb({ $schema: "list" }, {}), []);
    await assert.rejects(ra({ $queryCount: "isolated", connection: "isolated" }, {}), /a's policy/);
    assert.equal(await rb({ $queryCount: "isolated", connection: "isolated" }, {}), 0);
  } finally {
    await ra({ $database: "close", connection: "isolated" }, {});
    await rb({ $database: "close", connection: "isolated" }, {});
    ra.destroy();
    rb.destroy();
  }
});
