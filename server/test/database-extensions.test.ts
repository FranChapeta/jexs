import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createResolver, coreNodes } from "@jexs/core";
import { serverNodes } from "../src/index.js";

const resolve = createResolver([...coreNodes(), ...serverNodes({ root: "." })]);
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jexs-ext-"));
const filename = path.join(dir, "test.db");

// sqlite-vec is an optional peer: the tests that load it skip when it isn't installed.
// The specifier is a variable so the type checker doesn't look for its types.
const vecPackage = "sqlite-vec";
const vec: unknown = await import(vecPackage).catch(() => null);
const skipVec = vec === null && "sqlite-vec is not installed";

function loadablePath(): string {
  if (typeof vec !== "object" || vec === null || !("getLoadablePath" in vec) || typeof vec.getLoadablePath !== "function") {
    throw new Error("sqlite-vec has no getLoadablePath()");
  }
  return String(vec.getLoadablePath());
}

after(async () => {
  for (const connection of ["vec", "vec-path", "kept"]) await resolve({ $database: "close", connection }, {});
  resolve.destroy();
  await fs.rm(dir, { recursive: true, force: true });
});

test("a sqlite connection loads sqlite-vec from its package, and searches by vector", { skip: skipVec }, async () => {
  await resolve({ $database: "connect", connection: "vec", filename, extensions: ["sqlite-vec"] }, {});
  const sql = (sql: string, bindings?: unknown[]) => resolve({ $database: "raw", connection: "vec", sql, bindings }, {});
  const [{ version }] = await sql("select vec_version() as version") as Array<{ version: string }>;
  assert.match(version, /^v\d/);

  await sql("create virtual table items using vec0(embedding float[3])");
  await sql("insert into items(rowid, embedding) values (1, ?), (2, ?), (3, ?)", ["[1, 0, 0]", "[0, 1, 0]", "[0.9, 0.1, 0]"]);
  const nearest = await sql("select rowid from items where embedding match ? order by distance limit 2", ["[1, 0, 0]"]);
  assert.deepEqual(nearest, [{ rowid: 1 }, { rowid: 3 }]);
});

test("a sqlite connection loads an extension from its library's path", { skip: skipVec }, async () => {
  await resolve({ $database: "connect", connection: "vec-path", filename, extensions: [loadablePath()] }, {});
  const rows = await resolve({ $database: "raw", connection: "vec-path", sql: "select vec_version() as version" }, {});
  assert.equal((rows as unknown[]).length, 1);
});

test("an extension that is missing or fails to load fails connect, and keeps the connection it would replace", async () => {
  await resolve({ $database: "connect", connection: "kept", filename }, {});
  await assert.rejects(resolve({ $database: "connect", connection: "kept", filename, extensions: ["no-such-sqlite-extension"] }, {}),
    /The SQLite extension "no-such-sqlite-extension" is not installed\. Run: npm install no-such-sqlite-extension/);
  await assert.rejects(resolve({ $database: "connect", connection: "kept", filename, extensions: ["./no/such/library"] }, {}),
    /The SQLite extension "\.\/no\/such\/library" did not load/);
  await assert.rejects(resolve({ $database: "connect", connection: "kept", filename, extensions: ["node:path"] }, {}),
    /The package "node:path" has no load\(db\) function/);
  assert.deepEqual(await resolve({ $database: "raw", connection: "kept", sql: "select 1 as one" }, {}), [{ one: 1 }]);
});

test("extensions are a list of strings, on sqlite only", async () => {
  await assert.rejects(async () => resolve({ $database: "connect", connection: "bad", filename, extensions: "sqlite-vec" }, {}),
    /"extensions" takes a list of package names or library paths, got "sqlite-vec"/);
  await assert.rejects(async () => resolve({ $database: "connect", connection: "bad", filename, extensions: [""] }, {}),
    /"extensions" takes a list/);
  await assert.rejects(async () => resolve({ $database: "connect", connection: "bad", type: "pg", host: "localhost", db: "app", extensions: ["vector"] }, {}),
    /"extensions" are for SQLite: a pg database installs its own/);
});
