import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes, childContext, Node } from "../src/index.js";

// createResolver installs the global resolver that runSteps/resolve delegate to.
const resolve = createResolver(coreNodes);

test("setVars without bubble stays scoped to the child context (map do)", () => {
  const ctx: Record<string, unknown> = { total: 0 };
  resolve({ map: [1, 2, 3], item: "n", do: { setVars: { total: 99 } } }, ctx);
  assert.equal(ctx.total, 0); // write trapped in each iteration's copy
});

test("setVars with bubble writes up into the enclosing scope (map do)", () => {
  const ctx: Record<string, unknown> = { total: 0 };
  resolve({ map: [1, 2, 3], item: "n", do: { setVars: { total: 99 }, bubble: true } }, ctx);
  assert.equal(ctx.total, 99);
});

test("bubble enables accumulation across loop iterations", () => {
  const ctx: Record<string, unknown> = { sum: 0 };
  resolve(
    {
      map: [1, 2, 3],
      item: "n",
      do: { setVars: { sum: { add: [{ var: "$sum" }, { var: "$n" }] } }, bubble: true },
    },
    ctx,
  );
  assert.equal(ctx.sum, 6); // each iteration reads the bubbled running total
});

test("global `as` with bubble writes up the parent chain (foreach do step)", () => {
  const ctx: Record<string, unknown> = { picked: 0 };
  resolve({ foreach: [1, 2, 3], item: "n", do: [{ var: "$n", as: "picked", bubble: true }] }, ctx);
  assert.equal(ctx.picked, 3); // last iteration's value, escaped to the outer scope
});

test("global `as` without bubble stays in the child scope (foreach do step)", () => {
  const ctx: Record<string, unknown> = { picked: 0 };
  resolve({ foreach: [1, 2, 3], item: "n", do: [{ var: "$n", as: "picked" }] }, ctx);
  assert.equal(ctx.picked, 0);
});

test("setVars bubble accepts an expression, honored when it resolves truthy", () => {
  const on: Record<string, unknown> = { flag: true, total: 0 };
  resolve({ map: [1], item: "n", do: { setVars: { total: 99 }, bubble: { var: "$flag" } } }, on);
  assert.equal(on.total, 99);

  const off: Record<string, unknown> = { flag: false, total: 0 };
  resolve({ map: [1], item: "n", do: { setVars: { total: 99 }, bubble: { var: "$flag" } } }, off);
  assert.equal(off.total, 0); // flag false -> no bubble
});

test("global `as` bubble accepts an expression", () => {
  const ctx: Record<string, unknown> = { flag: true, picked: 0 };
  resolve(
    { foreach: [1, 2, 3], item: "n", do: [{ var: "$n", as: "picked", bubble: { var: "$flag" } }] },
    ctx,
  );
  assert.equal(ctx.picked, 3);
});

test("bubble reaches the topmost scope through nested child contexts", () => {
  const ctx: Record<string, unknown> = { hit: false };
  resolve(
    {
      // outer map -> inner map: two nested child scopes between the write and ctx
      map: [[1, 2]],
      item: "row",
      do: { map: { var: "$row" }, item: "cell", do: { setVars: { hit: true }, bubble: true } },
    },
    ctx,
  );
  assert.equal(ctx.hit, true);
});

test("dot-path writes bubble, creating the path in the enclosing scope", () => {
  const ctx: Record<string, unknown> = {}; // no `meta` yet
  resolve({ map: [1], item: "n", do: { setVars: { "meta.count": 5 }, bubble: true } }, ctx);
  assert.deepEqual(ctx.meta, { count: 5 });
});

test("dot-path write is trapped without bubble", () => {
  const ctx: Record<string, unknown> = {};
  resolve({ map: [1], item: "n", do: { setVars: { "meta.count": 5 } } }, ctx);
  assert.equal(ctx.meta, undefined);
});

test("PARENT link is non-enumerable: invisible to spread, keys, and JSON", () => {
  const parent: Record<string, unknown> = { a: 1 };
  const child = childContext(parent, { b: 2 });
  // the link never shows up in enumeration or serialization
  assert.deepEqual(Object.keys(child).sort(), ["a", "b"]);
  assert.equal(JSON.stringify(child), JSON.stringify({ a: 1, b: 2 }));
  // yet propagation still works through it
  Node.setContextValue(child, "escaped", true, true);
  assert.equal(parent.escaped, true);
  // a plain spread does NOT carry the parent link forward (no stale inheritance)
  const grandchild = { ...child } as Record<string, unknown>;
  Node.setContextValue(grandchild, "trapped", true, true);
  assert.equal(parent.trapped, undefined); // propagation stopped at the un-linked copy
});

test("childContext merges extra on top of the parent and links back", () => {
  const parent: Record<string, unknown> = { a: 1, shared: "parent" };
  const child = childContext(parent, { shared: "child", local: 2 });
  assert.equal(child.a, 1); // inherited
  assert.equal(child.shared, "child"); // extra overrides
  assert.equal(child.local, 2);
  Node.setContextValue(child, "a", 42, true);
  assert.equal(parent.a, 42); // link works
});
