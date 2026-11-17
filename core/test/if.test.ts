import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes());

test("`$if` needs a `then`", () => {
  assert.throws(() => resolve({ $if: true }, {}), /if needs a `then`/);
  assert.throws(() => resolve({ $if: false, else: "no" }, {}), /if needs a `then`/);
});

test("`$if` on a falsy condition without `else` gives undefined", () => {
  assert.equal(resolve({ $if: false, then: "yes" }, {}), undefined);
  assert.equal(resolve({ $if: { $not: false }, then: "yes" }, {}), "yes");
});

test("`$if` holds a stream or other non-plain object truthy, and an empty plain object falsy", async () => {
  const ctx: Record<string, unknown> = {};
  await resolve({ $stream: [], $as: "s" }, ctx);
  assert.equal(await resolve({ $if: { $var: "s" }, then: "yes", else: "no" }, ctx), "yes");
  assert.equal(resolve({ $if: { $var: "d" }, then: "yes", else: "no" }, { d: new Date(0) }), "yes");
  assert.equal(resolve({ $if: { $var: "o" }, then: "yes", else: "no" }, { o: {} }), "no");
  assert.equal(resolve({ $if: { $var: "o" }, then: "yes", else: "no" }, { o: Object.create(null) }), "no");
});
