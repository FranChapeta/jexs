import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes, childContext, boundaryContext, Node } from "../src/index.js";

// createResolver installs the global resolver that runSteps/resolve delegate to.
const resolve = createResolver(coreNodes());

test("setVars without bubble stays scoped to the child context (map do)", () => {
  const ctx: Record<string, unknown> = { total: 0 };
  resolve({ $map: [1, 2, 3], item: "n", do: { $setVars: { total: 99 } } }, ctx);
  assert.equal(ctx.total, 0); // write trapped in each iteration's copy
});

test("setVars with bubble writes up into the enclosing scope (map do)", () => {
  const ctx: Record<string, unknown> = { total: 0 };
  resolve({ $map: [1, 2, 3], item: "n", do: { $setVars: { total: 99 }, $bubble: true } }, ctx);
  assert.equal(ctx.total, 99);
});

test("bubble enables accumulation across loop iterations", () => {
  const ctx: Record<string, unknown> = { sum: 0 };
  resolve(
    {
      $map: [1, 2, 3],
      item: "n",
      do: { $setVars: { sum: { $add: [{ $var: "sum" }, { $var: "n" }] } }, $bubble: true },
    },
    ctx,
  );
  assert.equal(ctx.sum, 6); // each iteration reads the bubbled running total
});

test("global `as` with bubble writes up the parent chain (foreach do step)", () => {
  const ctx: Record<string, unknown> = { picked: 0 };
  resolve({ $foreach: [1, 2, 3], item: "n", do: [{ $var: "n", $as: "picked", $bubble: true }] }, ctx);
  assert.equal(ctx.picked, 3); // last iteration's value, escaped to the outer scope
});

test("global `as` without bubble stays in the child scope (foreach do step)", () => {
  const ctx: Record<string, unknown> = { picked: 0 };
  resolve({ $foreach: [1, 2, 3], item: "n", do: [{ $var: "n", $as: "picked" }] }, ctx);
  assert.equal(ctx.picked, 0);
});

test("setVars bubble accepts an expression, honored when it resolves truthy", () => {
  const on: Record<string, unknown> = { flag: true, total: 0 };
  resolve({ $map: [1], item: "n", do: { $setVars: { total: 99 }, $bubble: { $var: "flag" } } }, on);
  assert.equal(on.total, 99);

  const off: Record<string, unknown> = { flag: false, total: 0 };
  resolve({ $map: [1], item: "n", do: { $setVars: { total: 99 }, $bubble: { $var: "flag" } } }, off);
  assert.equal(off.total, 0); // flag false -> no bubble
});

test("global `as` bubble accepts an expression", () => {
  const ctx: Record<string, unknown> = { flag: true, picked: 0 };
  resolve(
    { $foreach: [1, 2, 3], item: "n", do: [{ $var: "n", $as: "picked", $bubble: { $var: "flag" } }] },
    ctx,
  );
  assert.equal(ctx.picked, 3);
});

test("bubble reaches the topmost scope through nested child contexts", () => {
  const ctx: Record<string, unknown> = { hit: false };
  resolve(
    {
      // outer map -> inner map: two nested child scopes between the write and ctx
      $map: [[1, 2]],
      item: "row",
      do: { $map: { $var: "row" }, item: "cell", do: { $setVars: { hit: true }, $bubble: true } },
    },
    ctx,
  );
  assert.equal(ctx.hit, true);
});

test("dot-path writes bubble, creating the path in the enclosing scope", () => {
  const ctx: Record<string, unknown> = {}; // no `meta` yet
  resolve({ $map: [1], item: "n", do: { $setVars: { "meta.count": 5 }, $bubble: true } }, ctx);
  assert.deepEqual(ctx.meta, { count: 5 });
});

test("dot-path write is trapped without bubble", () => {
  const ctx: Record<string, unknown> = {};
  resolve({ $map: [1], item: "n", do: { $setVars: { "meta.count": 5 } } }, ctx);
  assert.equal(ctx.meta, undefined);
});

test("a child scope owns only its extras, and reads the rest from its parent", () => {
  const parent: Record<string, unknown> = { a: 1 };
  const child = childContext(parent, { b: 2 });
  assert.deepEqual(Object.keys(child), ["b"]);
  assert.equal(JSON.stringify(child), JSON.stringify({ b: 2 }));
  assert.equal(child.a, 1);
  // A plain spread is a top scope: a bubble from it has nowhere above to go.
  const copy = { ...child } as Record<string, unknown>;
  Node.setContextValue(copy, "trapped", true, true);
  assert.equal(parent.trapped, undefined);
  assert.equal(copy.trapped, true);
});

test("childContext's extras shadow the parent's, and a bubble from it writes the parent", () => {
  const parent: Record<string, unknown> = { a: 1, shared: "parent" };
  const child = childContext(parent, { shared: "child", local: 2 });
  assert.equal(child.a, 1);
  assert.equal(child.shared, "child");
  assert.equal(child.local, 2);
  Node.setContextValue(child, "a", 42, true);
  assert.equal(parent.a, 42);
  assert.equal(child.a, 42); // read from the parent, not a copy
});

test("a child scope reads its parent's variables as they are now, not as they were when it was made", () => {
  const parent: Record<string, unknown> = { paused: false };
  const child = childContext(parent);
  parent.paused = true;
  assert.equal(child.paused, true);
});

test("a write without bubble shadows the parent's variable in the writing scope", () => {
  const ctx: Record<string, unknown> = { total: 1 };
  const result = resolve([
    { $map: [1], do: [{ $setVars: { total: 2 } }, { $var: "total" }] },
  ], ctx);
  assert.deepEqual(result, [2]);
  assert.equal(ctx.total, 1);
});

test("a bubble writes the nearest enclosing scope that has the variable, and no scope above it", () => {
  const ctx: Record<string, unknown> = { total: 0 };
  // Each row declares its own `total`; the cells add into the row's, not the root's.
  const result = resolve(
    {
      $map: [[1, 2], [3, 4]],
      item: "row",
      do: [
        { $setVars: { total: 0 } },
        { $foreach: { $var: "row" }, item: "cell", do: [{ $setVars: { total: { $add: [{ $var: "total" }, { $var: "cell" }] } }, $bubble: true }] },
        { $var: "total" },
      ],
    },
    ctx,
  );
  assert.deepEqual(result, [3, 7]);
  assert.equal(ctx.total, 0);
});

test("a bubble passes over the writing scope's own variable of that name", () => {
  // The loop binds `index`; bubbling `index` from its steps writes the scope above.
  const ctx: Record<string, unknown> = { index: -1 };
  resolve({ $foreach: ["a", "b"], do: [{ $setVars: { index: { $var: "index" } }, $bubble: true }] }, ctx);
  assert.equal(ctx.index, 1);
});

test("a bubble stops at a boundary, which still reads its parent", () => {
  const parent: Record<string, unknown> = { seen: 0 };
  const boundary = boundaryContext(parent, { local: 1 });
  const inner = childContext(boundary);
  assert.equal(inner.seen, 0);
  Node.setContextValue(inner, "seen", 5, true);
  assert.equal(parent.seen, 0);
  assert.equal(boundary.seen, 5);
  assert.equal(inner.seen, 5);
});

test("nested boundaries each stop a bubble, and a top scope's bubble lands in it", () => {
  const top: Record<string, unknown> = {};
  const outer = boundaryContext(top);
  const inner = boundaryContext(childContext(outer));
  Node.setContextValue(childContext(inner), "seen", 1, true);
  assert.equal(inner.seen, 1);
  assert.equal(Object.hasOwn(outer, "seen"), false);
  Node.setContextValue(top, "own", 2, true);
  assert.equal(top.own, 2);
});

test("an interval started in a child scope reads a variable its caller changes later", async () => {
  const resolver = createResolver(coreNodes());
  const ctx: Record<string, unknown> = { paused: false };
  await resolver({ $map: [1], do: [{ $interval: "start", id: "live", every: "10ms", do: [{ $var: "paused", $as: "seen", $bubble: true }] }] }, ctx);
  ctx.paused = true;
  for (let i = 0; i < 50 && ctx.seen !== true; i++) await new Promise(r => setTimeout(r, 10));
  resolver({ $interval: "stop", id: "live" }, ctx);
  resolver.destroy();
  assert.equal(ctx.seen, true);
});
