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
