import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createResolver, coreNodes } from "@jexs/core";
import { serverNodes } from "../src/index.js";
import { SchemaNode } from "../src/nodes/Schema.js";

const resolve = createResolver([...coreNodes(), ...serverNodes()]);
// A file, not `:memory:`: each pooled connection would open its own empty in-memory database.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jexs-query-"));
const conn = { connection: "query-test" };

after(async () => {
  await resolve({ $database: "close", name: "query-test" }, {});
  await fs.rm(dir, { recursive: true, force: true });
});

test("a query step runs end to end against sqlite", async () => {
  const context = {};
  await resolve({ $database: "connect", name: "query-test", type: "sqlite", filename: path.join(dir, "test.db") }, context);
  await resolve({ $query: "create", ...conn, schema: {
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

test("validators authorize every query: global first, then the table's own", async () => {
  // `seen` is shared by reference with each validator's context, so their writes show here.
  const context = { seen: { global: "", table: "" } };
  const table = [{ $setVars: { "seen.table": { $concat: [{ $var: "operation" }, ":", { $var: "query.table" }] } } }];
  await resolve({ $schema: "validator", run: [
    { $setVars: { "seen.global": { $concat: [{ $var: "operation" }, ":", { $var: "schema.table" }] } } },
    { $if: { $eq: [{ $var: "operation" }, "delete"] }, then: { $error: 403, message: "no deletes" } },
    // Narrow every select on notes to one author, the way a row-level policy would.
    { $if: { $and: [{ $eq: [{ $var: "operation" }, "select"] }, { $eq: [{ $var: "query.table" }, "notes"] }] },
      then: { $setVars: { "query.where": { author: "ada" } } } },
  ] }, context);
  try {
    // A table being created cannot approve itself: only the global validator runs.
    await resolve({ $query: "create", ...conn, schema: {
      table: "notes", validator: table,
      properties: { id: { type: "integer", primaryKey: true, autoIncrement: true }, author: { type: "string" } },
    } }, context);
    assert.deepEqual(context.seen, { global: "create:notes", table: "" });
    assert.deepEqual(SchemaNode.get("notes")?.validator, table);

    await resolve({ $query: "insert", ...conn, table: "notes", data: [{ author: "ada" }, { author: "bob" }] }, context);
    assert.deepEqual(context.seen, { global: "insert:notes", table: "insert:notes" });

    const rows = await resolve({ $query: "select", ...conn, table: "notes" }, context);
    assert.deepEqual((rows as Array<{ author: string }>).map(r => r.author), ["ada"]);

    await assert.rejects(resolve({ $query: "delete", ...conn, table: "notes", where: { author: "bob" } }, context), /no deletes/);
    assert.equal(await resolve({ $query: "count", ...conn, table: "notes", system: true }, context), 2);
  } finally {
    SchemaNode.globalValidator = null;
  }
});

test("create applies a composite primary key, and MySQL-only options elsewhere are ignored", async () => {
  await resolve({ $query: "create", ...conn, system: true, schema: {
    table: "memberships", primaryKey: ["team", "person"], options: { engine: "InnoDB", charset: "utf8mb4" },
    properties: { team: { type: "string" }, person: { type: "string" } },
  } }, {});
  await resolve({ $query: "insert", ...conn, system: true, table: "memberships", data: { team: "a", person: "ada" } }, {});
  await assert.rejects(resolve({ $query: "insert", ...conn, system: true, table: "memberships", data: { team: "a", person: "ada" } }, {}));
  await resolve({ $query: "insert", ...conn, system: true, table: "memberships", data: { team: "b", person: "ada" } }, {});
});

test("a table document needs a name and columns to be registered", async () => {
  await assert.rejects(resolve({ $query: "create", ...conn, system: true, schema: { table: 5, properties: {} } }, {}), /needs a `table` name and `properties`/);
  await assert.rejects(resolve({ $schema: "register", table: { table: "halfway" } }, {}), /needs a `table` name and `properties`/);
  assert.equal(SchemaNode.get("halfway"), undefined);
});

test("a column's SQL default is `sqlDefault`, apart from JSON Schema's `default`", async () => {
  await resolve({ $query: "create", ...conn, system: true, schema: {
    table: "stamps",
    properties: {
      id: { type: "integer", primaryKey: true, autoIncrement: true },
      label: { type: "string", default: "untitled" },
      made: { type: "string", sqlType: "timestamp", sqlDefault: "CURRENT_TIMESTAMP" },
    },
  } }, {});
  await resolve({ $query: "insert", ...conn, system: true, table: "stamps", data: { label: "a" } }, {});
  const row = await resolve({ $query: "select", ...conn, system: true, table: "stamps", first: true }, {}) as { made: unknown };
  assert.match(String(row.made), /^\d{4}-\d{2}-\d{2}/);
});

// The registry keeps its own copy of a table document: the one a template
// wrote is a literal of that template, and steps may change what they read.
test("registering a table leaves the written document unchanged", async () => {
  const step = { $schema: "register", table: { table: "kept", properties: { name: { type: "string" } } } };
  await resolve(step, {});
  assert.deepEqual(step.table, { table: "kept", properties: { name: { type: "string" } } });
  assert.ok(SchemaNode.get("kept")?.properties?.created_at, "the registry's copy has the common columns");
});

test("$schema get hands out a copy, so changing it leaves the registry alone", async () => {
  await resolve({ $schema: "register", table: { table: "copied", properties: { name: { type: "string" } } } }, {});
  const got = await resolve({ $schema: "get", table: "copied" }, {}) as { properties: Record<string, unknown> };
  got.properties.extra = { type: "string" };
  assert.equal(SchemaNode.get("copied")?.properties?.extra, undefined);
});

test("a validator that changes `schema` does not change the registered table", async () => {
  await resolve({ $query: "create", ...conn, system: true, schema: {
    table: "guarded",
    properties: { id: { type: "integer", sqlType: "increments" }, name: { type: "string" } },
    validator: [{ $setVars: { "schema.properties.injected": { type: "string" } } }],
  } }, {});
  await resolve({ $query: "select", ...conn, table: "guarded" }, {});
  assert.equal(SchemaNode.get("guarded")?.properties?.injected, undefined);
});
