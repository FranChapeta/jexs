import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

// The resolver the steps below run in; contexts are adopted at its entry points.
const resolve = createResolver(coreNodes());

test("filter: renames the item via the `item` sibling", () => {
  const out = resolve({ filter: [[1, 2, 3], { gt: [{ var: "n" }, 1] }], item: "n" }, {});
  assert.deepEqual(out, [2, 3]);
});

test("filter: default item is still `item` (backward compatible)", () => {
  const out = resolve({ filter: [[1, 2, 3], { gt: [{ var: "item" }, 1] }] }, {});
  assert.deepEqual(out, [2, 3]);
});

test("filter: renames the index via the `index` sibling", () => {
  const out = resolve({ filter: [["a", "b", "c"], { gt: [{ var: "i" }, 0] }], index: "i" }, {});
  assert.deepEqual(out, ["b", "c"]);
});

test("filter: item/index names may be expressions, resolved before use", () => {
  const out = resolve(
    { filter: [[1, 2, 3], { gt: [{ var: "n" }, 1] }], item: { var: "$itemVar" } },
    { itemVar: "n" },
  );
  assert.deepEqual(out, [2, 3]);
});

test("find: renames the item via the `item` sibling", () => {
  const out = resolve(
    { find: [[{ id: 1 }, { id: 2 }], { eq: [{ var: "x.id" }, 2] }], item: "x" },
    {},
  );
  assert.deepEqual(out, { id: 2 });
});

test("reduce: renames the item while accumulator stays available", () => {
  const out = resolve(
    { reduce: [[1, 2, 3], { add: [{ var: "accumulator" }, { var: "n" }] }, 0], item: "n" },
    {},
  );
  assert.equal(out, 6);
});

test("return: short-circuits a step array", () => {
  const out = resolve.runSteps(
    [
      { setVars: { x: 1 } },
      { if: { eq: [{ var: "$x" }, 1] }, then: { return: "early" } },
      "last",
    ],
    {},
  );
  assert.equal(out, "early");
});

test("return: absent, the last step's value wins", () => {
  const out = resolve.runSteps([{ setVars: { x: 1 } }, { var: "$x" }], {});
  assert.equal(out, 1);
});

test("a literal step is rejected, not silently run as a value", () => {
  // `["Hello"]` is a value dressed up as a sequence: every literal step resolves
  // to itself, so it can only ever be a no-op or the array's return value.
  assert.throws(() => resolve.runSteps(["Hello"], {}), /step must be an expression object/);
  assert.throws(() => resolve.runSteps([{ setVars: { x: 1 } }, 42], {}), /step must be an expression object/);
});
