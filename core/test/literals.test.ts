import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolver = createResolver(coreNodes());

// A literal in a template is one object in the parsed tree. The resolver hands
// out a copy of it, never the tree's own, so a node that mutates in place
// cannot edit the template for the next run.
test("a literal pushed into is fresh on every run", () => {
  const tpl = [
    { $setVars: { list: [] } },
    { $push: [{ $var: "list" }, 1] },
    { $var: "list" },
  ];
  assert.deepEqual(resolver(tpl, {}), [1]);
  assert.deepEqual(resolver(tpl, {}), [1]);
  assert.deepEqual(tpl[0], { $setVars: { list: [] } });
});

test("a literal is fresh on every loop iteration", () => {
  const body = [
    { $setVars: { list: [] } },
    { $push: [{ $var: "list" }, { $var: "item" }] },
    { $var: "list" },
  ];
  const out = resolver({ $map: [1, 2, 3], do: { $exec: { $var: "body" } } }, { body });
  assert.deepEqual(out, [[1], [2], [3]]);
});

test("nested literals are fresh too", () => {
  const tpl = [
    { $setVars: { state: { items: [] } } },
    { $push: [{ $var: "state.items" }, "x"] },
    { $var: "state" },
  ];
  resolver(tpl, {});
  assert.deepEqual(resolver(tpl, {}), { items: ["x"] });
});

// In-place mutation of a value read from context is untouched: `$var` hands
// back the context's own array, and the mutators edit it.
test("mutators still edit context data in place", () => {
  const list: unknown[] = [];
  const ctx = { list };
  resolver([
    { $push: [{ $var: "list" }, 1] },
    { $push: [{ $var: "list" }, 2] },
  ], ctx);
  assert.equal(ctx.list, list);
  assert.deepEqual(list, [1, 2]);
});

test("a value an op returns is not copied", () => {
  const shared = { a: [1] };
  const out = resolver({ $var: "shared" }, { shared });
  assert.equal(out, shared);
  const wrapped = resolver({ box: { $var: "shared" } }, { shared }) as Record<string, unknown>;
  assert.equal(wrapped.box, shared);
});

test("a class instance in a literal slot is passed through", () => {
  const date = new Date(0);
  const out = resolver({ when: { $var: "d" }, raw: date } as unknown, { d: date }) as Record<string, unknown>;
  assert.equal(out.raw, date);
});

// ── step keys at any depth ──────────────────────────────────────────────────

test("$catch works on a step nested in an argument", () => {
  const out = resolver({
    $concat: [{ $error: 500, message: "x", $catch: [{ $concat: ["fallback"] }] }, "!"],
  }, {});
  assert.equal(out, "fallback!");
});

test("$catch works on a step nested in a data object", () => {
  const out = resolver({
    a: { b: { $error: 500, message: "boom", $catch: [{ $var: "error.message" }] } },
  }, {});
  assert.deepEqual(out, { a: { b: "boom" } });
});

test("$catch works on a nested async step", async () => {
  const out = await resolver({
    $concat: [{ $sleep: 1, $then: [] }, { $error: 400, message: "late", $catch: [{ $var: "error.status" }] }],
  }, {});
  assert.equal(out, "400");
});

test("after a caught error the sequence carries on, sync or async", async () => {
  const sync = resolver([
    { $error: 500, message: "a", $as: "r", $catch: [{ $concat: ["caught"] }] },
    { $concat: [{ $var: "r" }, "+next"] },
  ], {});
  assert.equal(sync, "caught+next");
  const later = await resolver([
    { $sleep: 1 },
    { $exec: [{ $sleep: 1 }, { $error: 500, message: "b" }], $as: "r", $catch: [{ $concat: ["caught"] }] },
    { $concat: [{ $var: "r" }, "+next"] },
  ], {});
  assert.equal(later, "caught+next");
});

test("a nested $return in $catch ends the enclosing sequence", () => {
  const out = resolver([
    { $error: 500, message: "a", $catch: [{ $return: { $return: "stopped" } }] },
    { $concat: ["not reached"] },
  ], {});
  assert.equal(out, "stopped");
});

test("a single-expression $catch lets its $return end the enclosing sequence", () => {
  const out = resolver([
    { $error: 500, message: "a", $catch: { $return: "stopped" } },
    { $concat: ["not reached"] },
  ], {});
  assert.equal(out, "stopped");
});

test("an array $catch is a sequence that consumes one $return", () => {
  const out = resolver([
    { $error: 500, message: "a", $as: "r", $catch: [{ $return: "caught" }] },
    { $concat: [{ $var: "r" }, "+next"] },
  ], {});
  assert.equal(out, "caught+next");
});

test("$then works on a nested step", async () => {
  const ctx: Record<string, unknown> = {};
  const out = resolver({
    $concat: ["a", { $concat: ["b"], $then: [{ $setVars: { got: { $var: "result" } }, $bubble: true }] }],
  }, ctx);
  assert.equal(out, "a");
  await new Promise(r => setTimeout(r, 5));
  assert.equal(ctx.got, "b");
});

test("$as works on a step nested in an argument", () => {
  const ctx: Record<string, unknown> = { x: "v" };
  const out = resolver([
    { $concat: [{ $var: "x", $as: "y" }, "!"] },
    { $concat: [{ $var: "y" }, "?"] },
  ], ctx);
  assert.equal(out, "v?");
});

test("$as stores the $catch value", () => {
  const ctx: Record<string, unknown> = {};
  resolver({ $error: 500, message: "m", $as: "r", $catch: [{ $var: "error.message" }] }, ctx);
  assert.equal(ctx.r, "m");
});

test("$as with an async $bubble writes before the next step", async () => {
  const out = await resolver([
    { $exec: { $var: "inner" } },
    { $var: "got" },
  ], {
    inner: [{ $concat: ["up"], $as: "got", $bubble: { $exec: { $var: "slowTrue" } } }],
    slowTrue: [{ $sleep: 1 }, { $eq: [1, 1] }],
  });
  assert.equal(out, "up");
});

test("a long synchronous sequence does not grow the stack", () => {
  const steps = Array.from({ length: 50_000 }, (_, i) => ({ $add: [i, 1] }));
  assert.equal(resolver(steps, {}), 50_000);
});

test("an object with only global keys is refused", () => {
  assert.throws(
    () => resolver({ $catch: [{ $setVars: { ran: true } }] }, {}),
    /A step needs an op: "\$catch"/,
  );
  assert.throws(() => resolver({ a: 1, $as: "x" }, {}), /needs an op/);
});

test("$return alone is still a value, not an error", () => {
  assert.equal(resolver([{ $return: "early" }, { $concat: ["late"] }], {}), "early");
});

// ── map slots ───────────────────────────────────────────────────────────────

test("exec params from a step", () => {
  const out = resolver({
    $exec: { $var: "steps" },
    params: { $var: "p" },
  }, { steps: [{ $concat: ["hi ", { $var: "who" }] }], p: { who: "there" } });
  assert.equal(out, "hi there");
});

test("exec params that resolve to a non-object are ignored", () => {
  const steps = [{ $concat: ["x", { $var: "who" }] }];
  const out = resolver({ $exec: { $var: "steps" }, params: { $upper: "a" } }, { steps, who: "!" });
  assert.equal(out, "x!");
});

test("setVars from a step writes every key", () => {
  const ctx: Record<string, unknown> = { defaults: { a: 1, "b.c": 2 } };
  resolver({ $setVars: { $var: "defaults" } }, ctx);
  assert.equal(ctx.a, 1);
  assert.deepEqual(ctx.b, { c: 2 });
});

test("setVars from a literal still writes in order", () => {
  const ctx: Record<string, unknown> = {};
  resolver({ $setVars: { a: 1, b: { $add: [{ $var: "a" }, 1] } } }, ctx);
  assert.equal(ctx.b, 2);
});

test("setVars with data: true writes the values unresolved", () => {
  const ctx: Record<string, unknown> = {};
  resolver({ $setVars: { steps: [{ $concat: ["a", "b"] }] }, data: true }, ctx);
  assert.deepEqual(ctx.steps, [{ $concat: ["a", "b"] }]);
});

test("setVars with data: true writes the values unresolved", () => {
  const ctx: Record<string, unknown> = {};
  resolver({ $setVars: { steps: [{ $concat: ["a", "b"] }] }, data: true }, ctx);
  assert.deepEqual(ctx.steps, [{ $concat: ["a", "b"] }]);
});

test("switch cases from a step is a lookup table whose entries are data", () => {
  const table = { admin: { $setVars: { ran: true } } };
  const ctx: Record<string, unknown> = { table, role: "admin" };
  const out = resolver({ $switch: { $var: "role" }, cases: { $var: "table" } }, ctx);
  assert.equal(out, table.admin);
  assert.equal(ctx.ran, undefined);
});

test("switch literal cases stay lazy and ignore inherited names", () => {
  const ctx: Record<string, unknown> = {};
  const out = resolver({
    $switch: "b",
    cases: { a: { $setVars: { ranA: true } }, b: "B" },
  }, ctx);
  assert.equal(out, "B");
  assert.equal(ctx.ranA, undefined);
  assert.equal(resolver({ $switch: "toString", cases: { a: 1 }, default: "none" }, {}), "none");
});

test("a literal map key starting with $ dispatches", () => {
  assert.throws(() => resolver({ $setVars: { $nope: 1 } }, {}), /Unknown op "\$nope"/);
});
