import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createResolver, coreNodes, type Context } from "@jexs/core";
import { RouterNode } from "../src/nodes/Router.js";
import { FileNode } from "../src/nodes/File.js";

// A real root, because the handler paths that matter here end in FileNode
// rendering a template off disk.
let root = "";
let resolve: ReturnType<typeof createResolver>;

const get = (routes: unknown, context: Context = {}): Promise<unknown> =>
  Promise.resolve(resolve({ routes }, { request: { method: "GET", path: "/" }, ...context }));

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "jexs-router-"));
  await fs.writeFile(
    path.join(root, "page.json"),
    JSON.stringify({ tag: "p", content: [{ var: "$greeting" }] }),
  );
  resolve = createResolver([...coreNodes(), new RouterNode(), new FileNode(root)]);
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("a file handler renders its template", async () => {
  const routes = { methods: { GET: { file: "/page.json" } } };
  assert.deepEqual(await get(routes, { greeting: "hi" }), { response: "<p>hi</p>" });
});

test("a file handler takes an expression, not just a literal path", async () => {
  const routes = { methods: { GET: { file: { var: "$page" } } } };
  assert.deepEqual(
    await get(routes, { page: "/page.json", greeting: "from expr" }),
    { response: "<p>from expr</p>" },
  );
});

test("a run handler yields its last step", async () => {
  const routes = { methods: { GET: { run: [{ concat: ["a", "b"] }] } } };
  assert.deepEqual(await get(routes), { response: "ab" });
});

test("an expression resolving to a file handler takes the file path", async () => {
  const routes = { methods: { GET: { var: "$handler" } } };
  const ctx = { handler: { file: "/page.json" }, greeting: "indirect" };
  assert.deepEqual(await get(routes, ctx), { response: "<p>indirect</p>" });
});

test("an expression resolving to a run handler takes the run path", async () => {
  const routes = { methods: { GET: { var: "$handler" } } };
  const ctx = { handler: { run: [{ concat: ["from ", "steps"] }] } };
  assert.deepEqual(await get(routes, ctx), { response: "from steps" });
});

test("a resolved handler's own schema is what gates the request", async () => {
  // The expression IS the handler, so its `queryParams` arrive with the rest of
  // it rather than being declared beside the expression.
  const routes = { methods: { GET: { var: "$handler" } } };
  const ctx = {
    handler: {
      queryParams: { type: "object", required: ["page"] },
      run: [{ concat: ["ok"] }],
    },
    request: { method: "GET", path: "/", query: {} },
  };
  await assert.rejects(() => get(routes, ctx), /Invalid query/);
});

test("a resolved handler passes its own schema when the request satisfies it", async () => {
  const routes = { methods: { GET: { var: "$handler" } } };
  const ctx = {
    handler: {
      queryParams: { type: "object", required: ["page"] },
      run: [{ concat: ["ok"] }],
    },
    request: { method: "GET", path: "/", query: { page: "2" } },
  };
  assert.deepEqual(await get(routes, ctx), { response: "ok" });
});

test("an expression resolving to anything but a handler is an error", async () => {
  const routes = { methods: { GET: { var: "$data" } } };
  await assert.rejects(
    () => get(routes, { data: { ok: true } }),
    /must be, or resolve to, a "file" or "run" object/,
  );
});

test("an empty handler is an error rather than an empty body", async () => {
  await assert.rejects(
    () => get({ methods: { GET: {} } }),
    /must be, or resolve to, a "file" or "run" object/,
  );
});

test("only the handler expression is resolved, not a step's value", async () => {
  // The resolved handler leaves by `file` or `run`, so the expression is taken
  // once. A run STEP resolving to a handler-shaped object is just that step's
  // value, and stays the response body.
  const routes = { methods: { GET: { var: "$a" } } };
  const ctx = { a: { run: [{ var: "$b" }] }, b: { file: "/page.json" }, greeting: "x" };
  assert.deepEqual(await get(routes, ctx), { file: "/page.json" });
});
