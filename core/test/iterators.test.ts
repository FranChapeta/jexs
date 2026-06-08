import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes, runSteps } from "../src/index.js";

// createResolver installs the global resolver that runSteps/resolve delegate to.
const resolve = createResolver(coreNodes);

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
  const out = runSteps(
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
  const out = runSteps([{ setVars: { x: 1 } }, "a", "b"], {});
  assert.equal(out, "b");
});
