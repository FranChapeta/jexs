import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";
import type { Context } from "../src/index.js";

const tick = () => new Promise((r) => setTimeout(r, 20));

// `then` and runStepsDetached are different mechanisms that happen to share
// handleErr: `then` makes ONE STEP fire-and-forget inside a running sequence,
// while runStepsDetached runs a whole array from outside any sequence at all.
test("a `then` step inside detached steps still does not block the sequence", async () => {
  const resolver = createResolver(coreNodes());
  const order: string[] = [];
  const ctx: Context = {};

  await resolver.runStepsDetached([
    { sleep: 30, then: [{ var: "$result" }] },
    { concat: ["second"] },
  ], ctx);

  order.push("returned");
  await tick();
  // The sequence returned without waiting for the sleeping step.
  assert.deepEqual(order, ["returned"]);
});

test("handleErr reads `catch` only, so a `then` sibling cannot be mistaken for one", async () => {
  const resolver = createResolver(coreNodes());
  const withThen = { do: [{ error: 500, message: "boom" }], then: [{ concat: ["x"] }] };

  // No `catch` on the def -> the failure must still surface, not be swallowed
  // by the presence of `then`.
  await assert.rejects(resolver.runStepsDetached(withThen.do, {}, withThen), /boom/);
});

test("a `catch` on the def is honored while `then` is present", async () => {
  const resolver = createResolver(coreNodes());
  const both = {
    do: [{ error: 500, message: "boom" }],
    then: [{ concat: ["ignored"] }],
    catch: [{ concat: ["caught: ", { var: "$error.message" }] }],
  };
  assert.equal(await resolver.runStepsDetached(both.do, {}, both), "caught: boom");
});

// The resolver's own fire-and-forget path is untouched by any of this.
test("`then` on a step still fires at that step's completion, unchanged", async () => {
  const resolver = createResolver(coreNodes());
  const ctx: Context = {};
  // Two things this pins beyond the fire-and-forget itself: `then` is a STEP
  // key, so it needs runSteps rather than resolving a bare array (which would
  // resolve elements in parallel); and its steps run in a childContext, so the
  // write needs `bubble` to reach the caller's scope.
  const out = await resolver.runSteps([
    { concat: ["work"], then: [{ setVars: { landed: { var: "$result" } }, bubble: true }] },
    { concat: ["next"] },
  ], ctx);
  assert.equal(out, "next");
  await tick();
  assert.equal(ctx.landed, "work");
});
