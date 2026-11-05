import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes());

const countTo = (n: unknown, extra: Record<string, unknown> = {}) => ({
  $while: { $lt: [{ $var: "count" }, n] },
  do: { $add: [{ $var: "count" }, 1], $as: "count" },
  ...extra,
});

test("while: runs do until the condition turns falsy, resolving to the last round", () => {
  assert.equal(resolve(countTo(3), { count: 0 }), 3);
});

test("while: what do sets is there after the loop", () => {
  assert.equal(resolve([countTo(4), { $var: "count" }], { count: 0 }), 4);
});

test("while: a condition falsy from the start runs nothing and resolves to undefined", () => {
  const context = { count: 5 };
  assert.equal(resolve(countTo(3), context), undefined);
  assert.equal(context.count, 5);
});

test("while: an array do runs as steps, the round's result its last step", () => {
  const loop = {
    $while: { $lt: [{ $var: "count" }, 2] },
    do: [{ $add: [{ $var: "count" }, 1], $as: "count" }, { $concat: ["round ", { $var: "count" }] }],
  };
  assert.equal(resolve(loop, { count: 0 }), "round 2");
});

test("while: synchronous rounds do not grow the stack", () => {
  assert.equal(resolve(countTo(100000), { count: 0 }), 100000);
});

test("while: rounds that wait run one after another", async () => {
  const loop = {
    $while: { $lt: [{ $var: "count" }, 3] },
    do: [{ $sleep: 1 }, { $add: [{ $var: "count" }, 1], $as: "count" }],
  };
  const out = resolve(loop, { count: 0 });
  assert.ok(out instanceof Promise);
  assert.equal(await out, 3);
});

test("while: a condition that waits is awaited before each round", async () => {
  const loop = { $while: { $runVar: "check" }, do: { $add: [{ $var: "count" }, 1], $as: "count" } };
  const context = { count: 0, check: [{ $sleep: 1 }, { $lt: [{ $var: "count" }, 2] }] };
  assert.equal(await resolve(loop, context), 2);
});

test("while: max allows that many rounds", () => {
  assert.equal(resolve(countTo(3, { max: 3 }), { count: 0 }), 3);
});

test("while: a condition still truthy after max rounds throws", () => {
  assert.throws(() => resolve(countTo(10, { max: 3 }), { count: 0 }), /ran its 3 rounds/);
});

test("while: max throws for rounds that wait too", async () => {
  const loop = { ...countTo(10, { max: 2 }), do: [{ $sleep: 1 }, { $add: [{ $var: "count" }, 1], $as: "count" }] };
  await assert.rejects(async () => resolve(loop, { count: 0 }), /ran its 2 rounds/);
});

test("while: max takes a whole number", () => {
  assert.throws(() => resolve(countTo(3, { max: -1 }), { count: 0 }), /whole number/);
  assert.throws(() => resolve(countTo(3, { max: 1.5 }), { count: 0 }), /whole number/);
  assert.throws(() => resolve(countTo(3, { max: "many" }), { count: 0 }), /whole number/);
});

test("while: an error in do ends the loop and reaches $catch", () => {
  const loop = { $while: true, do: { $error: 500, message: "stop" },$catch: { $var: "error.message" } };
  assert.equal(resolve(loop, {}), "stop");
});

test("while: needs a do", () => {
  assert.throws(() => resolve({ $while: false }, {}), /needs a `do`/);
});
