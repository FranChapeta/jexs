import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes, runStepsDetached } from "../src/index.js";
import type { Context } from "../src/index.js";

const tick = () => new Promise((r) => setTimeout(r, 20));

// `then` and runStepsDetached are different mechanisms that happen to share
// handleErr: `then` makes ONE STEP fire-and-forget inside a running sequence,
// while runStepsDetached runs a whole array from outside any sequence at all.
// A detached run starts from a context the resolver already owns, so each test
// hands it over through createResolver's `context` option.
test("a `then` step inside detached steps still does not block the sequence", async () => {
  const ctx: Context = {};
  createResolver(coreNodes(), { context: ctx });
  const order: string[] = [];

  await runStepsDetached([
    { $sleep: 30, $then: [{ $var: "result" }] },
    { $concat: ["second"] },
  ], ctx);

  order.push("returned");
  await tick();
  // The sequence returned without waiting for the sleeping step.
  assert.deepEqual(order, ["returned"]);
});

test("handleErr reads `$catch` only, so a `then` sibling cannot be mistaken for one", async () => {
  const ctx: Context = {};
  createResolver(coreNodes(), { context: ctx });
  const withThen = { do: [{ $error: 500, message: "boom" }], $then: [{ $concat: ["x"] }] };

  // No `$catch` on the def -> the failure must still surface, not be swallowed
  // by the presence of `then`.
  await assert.rejects(runStepsDetached(withThen.do, ctx, withThen), /boom/);
});

test("a `$catch` on the def is honored while `then` is present", async () => {
  const ctx: Context = {};
  createResolver(coreNodes(), { context: ctx });
  const both = {
    do: [{ $error: 500, message: "boom" }],
    $then: [{ $concat: ["ignored"] }],
    $catch: [{ $concat: ["caught: ", { $var: "error.message" }] }],
  };
  assert.equal(await runStepsDetached(both.do, ctx, both), "caught: boom");
});

// The resolver's own fire-and-forget path is untouched by any of this.
test("`then` on a step still fires at that step's completion, unchanged", async () => {
  const resolver = createResolver(coreNodes());
  const ctx: Context = {};
  // Two things this pins beyond the fire-and-forget itself: `then` is a STEP
  // key, so it needs runSteps rather than resolving a bare array (which would
  // resolve elements in parallel); and its steps run in a childContext, so the
  // write needs `$bubble` to reach the caller's scope.
  const out = await resolver([
    { $concat: ["work"], $then: [{ $setVars: { landed: { $var: "result" } }, $bubble: true }] },
    { $concat: ["next"] },
  ], ctx);
  assert.equal(out, "next");
  await tick();
  assert.equal(ctx.landed, "work");
});

// A `load` handler seeds state during hydrate(), and callers read it as soon as
// hydrate() returns, so a detached run must start its steps on the caller's stack.
test("a detached run starts its steps synchronously", () => {
  const ctx: Context = {};
  createResolver(coreNodes(), { context: ctx });
  void runStepsDetached([{ $setVars: { seeded: true } }], ctx);
  assert.equal(ctx.seeded, true);
});

test("with a label, an unhandled error is logged and the promise resolves", async () => {
  const ctx: Context = {};
  createResolver(coreNodes(), { context: ctx });
  const logged: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    const out = await runStepsDetached([{ $error: 500, message: "boom" }], ctx, null, "[test] failed:");
    assert.equal(out, undefined);
  } finally {
    console.error = realError;
  }
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], "[test] failed:");
});

test("a detached run takes a single expression as well as an array", async () => {
  const ctx: Context = {};
  createResolver(coreNodes(), { context: ctx });
  assert.equal(await runStepsDetached({ $concat: ["one"] }, ctx), "one");
});
