import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes, Node } from "../src/index.js";

// A fake async node: `{ $defer: "X" }` resolves to "R:X" on a later microtask, so
// we can observe that a fire-and-forget `then` does not block the step sequence.
class DeferNode extends Node {
  get handlerKeys() { return ["defer"]; }
  resolve(def: Record<string, unknown>) {
    return Promise.resolve("R:" + String(def.$defer));
  }
}
const resolve = createResolver([new DeferNode(), ...coreNodes()]);

const flush = () => new Promise(r => setTimeout(r, 0));

test("then: `if/then/else` still resolves the branch (its `if` owner shadows the global `then`)", () => {
  assert.equal(resolve({ $if: true, then: "yes", else: "no" }, {}), "yes");
  assert.equal(resolve({ $if: false, then: "yes", else: "no" }, {}), "no");
  // A truthy `if` with only a `then` still yields the branch, not a continuation.
  assert.equal(resolve({ $if: true, then: "branch" }, {}), "branch");
});

test("then: fire-and-forget does not block the sequence and runs the continuation with $result", async () => {
  const ctx: Record<string, unknown> = {};
  const out = resolve([
    { $defer: "A", $then: [{ $as: "grabbed", $var: "result", $bubble: true }] },
    { $as: "second", $concat: ["step2"] },
    { $var: "second" },
  ], ctx);

  // The sequence completes without awaiting the deferred work (returns synchronously).
  assert.equal(out, "step2");
  // The continuation has not run yet on the same tick.
  assert.equal(ctx.grabbed, undefined);

  await flush();
  // After it settles, the continuation ran with the result bound as `result`.
  assert.equal(ctx.grabbed, "R:A");
});

test("then: the step itself yields null, as its result is delivered to `result`", async () => {
  const ctx: Record<string, unknown> = {};
  const out = resolve({ $defer: "Z", $then: [{ $as: "async", $var: "result", $bubble: true }] }, ctx);
  assert.equal(out, null);
  await flush();
  assert.equal(ctx.async, "R:Z");
});

test("then: `$as` beside it is refused, before the work starts", async () => {
  const ctx: Record<string, unknown> = {};
  assert.throws(
    () => resolve({ $defer: "Z", $as: "sync", $then: [{ $as: "ran", $var: "result", $bubble: true }] }, ctx),
    /`\$as` cannot store a `\$then` step's result/,
  );
  await flush();
  assert.equal(ctx.ran, undefined);
});
