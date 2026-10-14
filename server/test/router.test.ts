import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Node, createResolver, coreNodes, type Context } from "@jexs/core";
import { RouterNode } from "../src/nodes/Router.js";
import { FileNode } from "../src/nodes/File.js";

// A real root, because the handler paths that matter here end in FileNode
// rendering a template off disk.
let root = "";
let resolve: ReturnType<typeof createResolver>;

const get = (routes: unknown, context: Context = {}): Promise<unknown> =>
  Promise.resolve(resolve({ $routes: routes }, { request: { method: "GET", path: "/" }, ...context }));

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "jexs-router-"));
  await fs.writeFile(
    path.join(root, "page.json"),
    JSON.stringify({ $tag: "p", content: [{ $var: "greeting" }] }),
  );
  resolve = createResolver([...coreNodes(), new RouterNode(), new FileNode(root)]);
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test("a file handler renders its template", async () => {
  const routes = { methods: { GET: { $file: "/page.json" } } };
  assert.deepEqual(await get(routes, { greeting: "hi" }), "<p>hi</p>");
});

test("a file handler takes an expression, not just a literal path", async () => {
  const routes = { methods: { GET: { $file: { $var: "page" } } } };
  assert.deepEqual(
    await get(routes, { page: "/page.json", greeting: "from expr" }),
    "<p>from expr</p>",
  );
});

test("a do handler yields its last step", async () => {
  const routes = { methods: { GET: { do: [{ $concat: ["a", "b"] }] } } };
  assert.equal(await get(routes), "ab");
});

test("a do handler may be a single step", async () => {
  const routes = { methods: { GET: { do: { $concat: ["one ", "step"] } } } };
  assert.equal(await get(routes), "one step");
});

test("an expression resolving to a file handler takes the file path", async () => {
  const routes = { methods: { GET: { $var: "handler" } } };
  const ctx = { handler: { $file: "/page.json" }, greeting: "indirect" };
  assert.equal(await get(routes, ctx), "<p>indirect</p>");
});

test("an expression resolving to a do handler takes the do path", async () => {
  const routes = { methods: { GET: { $var: "handler" } } };
  const ctx = { handler: { do: [{ $concat: ["from ", "steps"] }] } };
  assert.equal(await get(routes, ctx), "from steps");
});

test("a resolved handler's own schema is what gates the request", async () => {
  // The expression IS the handler, so its `queryParams` arrive with the rest of
  // it rather than being declared beside the expression.
  const routes = { methods: { GET: { $var: "handler" } } };
  const ctx = {
    handler: {
      queryParams: { type: "object", required: ["page"] },
      do: [{ $concat: ["ok"] }],
    },
    request: { method: "GET", path: "/", query: {} },
  };
  await assert.rejects(() => get(routes, ctx), /Invalid query/);
});

test("a resolved handler passes its own schema when the request satisfies it", async () => {
  const routes = { methods: { GET: { $var: "handler" } } };
  const ctx = {
    handler: {
      queryParams: { type: "object", required: ["page"] },
      do: [{ $concat: ["ok"] }],
    },
    request: { method: "GET", path: "/", query: { page: "2" } },
  };
  assert.equal(await get(routes, ctx), "ok");
});

test("an expression resolving to anything but a handler is an error", async () => {
  const routes = { methods: { GET: { $var: "data" } } };
  await assert.rejects(
    () => get(routes, { data: { ok: true } }),
    /must be, or resolve to, a "\$file" step or a "do" object/,
  );
});

test("an empty handler is an error rather than an empty body", async () => {
  await assert.rejects(
    () => get({ methods: { GET: {} } }),
    /must be, or resolve to, a "\$file" step or a "do" object/,
  );
});

test("only the handler expression is resolved, not a step's value", async () => {
  // The resolved handler leaves by `file` or `do`, so the expression is taken
  // once. A STEP of its `do` resolving to a handler-shaped object is just that
  // step's value, and stays the response body.
  const routes = { methods: { GET: { $var: "a" } } };
  const ctx = { a: { do: [{ $var: "b" }] }, b: { $file: "/page.json" }, greeting: "x" };
  assert.deepEqual(await get(routes, ctx), { $file: "/page.json" });
});

// ── paramRegex ──

const at = (routes: unknown, urlPath: string) =>
  get(routes, { request: { method: "GET", path: urlPath } });
const idRoute = (paramRegex: string) => ({
  children: { "*": { paramName: "id", paramRegex, methods: { GET: { do: [{ $var: "request.params.id" }] } } } },
});

test("paramRegex is anchored, so an alternation must match the whole segment", async () => {
  assert.equal(await at(idRoute("new|edit"), "/new"), "new");
  assert.equal(await at(idRoute("new|edit"), "/edit"), "edit");
  await assert.rejects(() => at(idRoute("new|edit"), "/newsletter"), { status: 404 });
  await assert.rejects(() => at(idRoute("new|edit"), "/reedit"), { status: 404 });
});

test("paramRegex still constrains a plain pattern", async () => {
  assert.equal(await at(idRoute("\\d+"), "/42"), "42");
  await assert.rejects(() => at(idRoute("\\d+"), "/4a"), { status: 404 });
});

test("paramRegex on a catch-all is anchored to the whole rest of the path", async () => {
  const routes = {
    children: { "**": { paramName: "rest", paramRegex: "a|b/c", methods: { GET: { do: [{ $var: "request.params.rest" }] } } } },
  };
  assert.equal(await at(routes, "/b/c"), "b/c");
  await assert.rejects(() => at(routes, "/a/x"), { status: 404 });
});

// ── Params ──

test("params are captured into request.params, and never into the context", async () => {
  const routes = { children: { "*": { paramName: "session", methods: { GET: { do: [{ $var: "request.params" }] } } } } };
  const context: Context = { request: { method: "GET", path: "/x" }, session: { user: 1 } };
  assert.deepEqual(await Promise.resolve(resolve({ $routes: routes }, context)), { session: "x" });
  assert.deepEqual(context.session, { user: 1 });
});

test("a param captured on a branch that matches no further is dropped", async () => {
  const routes = {
    children: {
      "*": { paramName: "id", children: { edit: { methods: { GET: { do: [{ $concat: ["edit"] }] } } } } },
      "**": { paramName: "rest", methods: { GET: { do: [{ $var: "request.params" }] } } },
    },
  };
  assert.deepEqual(await at(routes, "/7/x"), { rest: "7/x" });
});

test("an invalid paramRegex names the pattern", async () => {
  await assert.rejects(() => at(idRoute("["), "/x"), /Invalid paramRegex "\["/);
});

// ── Route nodes written as steps ─────────────────────────────────────────────

test("an $if node adds its subtree only when the condition holds", async () => {
  const routes = {
    children: {
      admin: { $if: { $var: "isAdmin" }, then: { $var: "adminRoutes" } },
      "**": { methods: { GET: { do: [{ $concat: ["fallback"] }] } } },
    },
  };
  const adminRoutes = { methods: { GET: { do: [{ $concat: ["admin"] }] } } };
  const request = { method: "GET", path: "/admin" };
  assert.deepEqual(await get(routes, { request, isAdmin: true, adminRoutes }), "admin");
  assert.equal(await get(routes, { request, isAdmin: false, adminRoutes }), "fallback");
});

test("a node written as a step resolves only when reached, after the params above it", async () => {
  class SubtreeNode extends Node {
    seen: unknown[] = [];
    subtree(_def: Record<string, unknown>, context: Context) {
      this.seen.push(context.request?.params?.team);
      return { methods: { GET: { do: [{ $var: "request.params.team" }] } } };
    }
  }
  const subtrees = new SubtreeNode();
  const local = createResolver([...coreNodes(), new RouterNode(), subtrees]);
  const routes = { children: { "*": { paramName: "team", children: { roster: { $subtree: true } } } } };
  const go = (path: string) => Promise.resolve(local({ $routes: routes }, { request: { method: "GET", path } }));

  await assert.rejects(() => go("/red/elsewhere"), { status: 404 });
  assert.deepEqual(subtrees.seen, []);
  assert.equal(await go("/red/roster"), "red");
  assert.deepEqual(subtrees.seen, ["red"]);
});

test("a node that resolves to anything but a route tree is an error", async () => {
  const routes = { children: { bad: { $concat: ["not a tree"] } } };
  await assert.rejects(() => at(routes, "/bad"), (err: { status?: number; message?: string }) =>
    err.status === 500 && /\/bad: a route node must be, or resolve to, a route tree/.test(String(err.message)));
});

test("a root written as a step that yields nothing matches nothing", async () => {
  await assert.rejects(() => get({ $if: false, then: { $var: "never" } }), { status: 404 });
});

test("an expression handler's query schema validates every request", async () => {
  const routes = { methods: { GET: { $var: "handler" } } };
  const handler = () => ({ queryParams: { type: "object", required: ["q"] }, do: [{ $concat: ["ok"] }] });
  for (let i = 0; i < 3; i++) {
    const out = await Promise.resolve(resolve(
      { $routes: routes },
      { request: { method: "GET", path: "/", query: { q: "x" } }, handler: handler() },
    ));
    assert.equal(out, "ok");
  }
  await assert.rejects(Promise.resolve(resolve(
    { $routes: routes },
    { request: { method: "GET", path: "/", query: {} }, handler: handler() },
  )), /q/);
});
