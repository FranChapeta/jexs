import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

// The resolver the steps below run in; contexts are adopted at its entry points.
const resolve = createResolver(coreNodes());

test("map: exposes the index as `index`, like filter/find/reduce", () => {
  const out = resolve({ $map: ["a", "b", "c"], do: { $concat: [{ $var: "index" }, ":", { $var: "item" }] } }, {});
  assert.deepEqual(out, ["0:a", "1:b", "2:c"]);
});

test("map: renames the index via the `index` sibling", () => {
  const out = resolve({ $map: ["a", "b"], item: "x", index: "i", do: { $concat: [{ $var: "i" }, "=", { $var: "x" }] } }, {});
  assert.deepEqual(out, ["0=a", "1=b"]);
});

test("map: item/index names may be expressions, resolved before use", () => {
  const out = resolve(
    { $map: ["a", "b"], item: { $var: "itemVar" }, index: { $var: "indexVar" }, do: { $concat: [{ $var: "i" }, "=", { $var: "n" }] } },
    { itemVar: "n", indexVar: "i" },
  );
  assert.deepEqual(out, ["0=a", "1=b"]);
});

test("an iteration binds only its item and index", () => {
  const out = resolve({ $map: ["a"], do: { $var: "loop" } }, {});
  assert.deepEqual(out, [undefined]);
});

test("foreach: exposes the index as `index`, rename-able like the array ops'", () => {
  const ctx: Record<string, unknown> = { out: [] };
  resolve({ $foreach: ["a", "b"], do: { $push: [{ $var: "out" }, { $concat: [{ $var: "index" }, ":", { $var: "item" }] }] } }, ctx);
  resolve({ $foreach: ["c"], item: "x", index: { $var: "indexVar" }, do: { $push: [{ $var: "out" }, { $concat: [{ $var: "i" }, "=", { $var: "x" }] }] } }, { ...ctx, indexVar: "i" });
  assert.deepEqual(ctx.out, ["0:a", "1:b", "0=c"]);
});

test("filter: renames the item via the `item` sibling", () => {
  const out = resolve({ $filter: [1, 2, 3], do: { $gt: [{ $var: "n" }, 1] }, item: "n" }, {});
  assert.deepEqual(out, [2, 3]);
});

test("filter: default item is `item`", () => {
  const out = resolve({ $filter: [1, 2, 3], do: { $gt: [{ $var: "item" }, 1] } }, {});
  assert.deepEqual(out, [2, 3]);
});

test("filter: renames the index via the `index` sibling", () => {
  const out = resolve({ $filter: ["a", "b", "c"], do: { $gt: [{ $var: "i" }, 0] }, index: "i" }, {});
  assert.deepEqual(out, ["b", "c"]);
});

test("filter: item/index names may be expressions, resolved before use", () => {
  const out = resolve(
    { $filter: [1, 2, 3], do: { $gt: [{ $var: "n" }, 1] }, item: { $var: "itemVar" } },
    { itemVar: "n" },
  );
  assert.deepEqual(out, [2, 3]);
});

test("find: renames the item via the `item` sibling", () => {
  const out = resolve(
    { $find: [{ id: 1 }, { id: 2 }], do: { $eq: [{ $var: "x.id" }, 2] }, item: "x" },
    {},
  );
  assert.deepEqual(out, { id: 2 });
});

test("reduce: renames the item while accumulator stays available", () => {
  const out = resolve(
    { $reduce: [1, 2, 3], do: { $add: [{ $var: "accumulator" }, { $var: "n" }] }, initial: 0, item: "n" },
    {},
  );
  assert.equal(out, 6);
});

test("reduce: renames the accumulator via the `accumulator` sibling", () => {
  const out = resolve(
    { $reduce: [1, 2, 3], do: { $add: [{ $var: "total" }, { $var: "item" }] }, initial: 10, accumulator: "total" },
    {},
  );
  assert.equal(out, 16);
});

test("reduce: without `initial`, the first accumulator is undefined", () => {
  const out = resolve({ $reduce: ["a", "b"], do: { $concat: [{ $coalesce: [{ $var: "accumulator" }, ">"] }, { $var: "item" }] } }, {});
  assert.equal(out, ">ab");
});

// The array is the op's whole value, so it can come from an expression, as `map`'s can.
test("filter, find and reduce take their array from an expression", () => {
  const ctx = { nums: [1, 2, 3] };
  assert.deepEqual(resolve({ $filter: { $var: "nums" }, do: { $gt: [{ $var: "item" }, 1] } }, { ...ctx }), [2, 3]);
  assert.equal(resolve({ $find: { $var: "nums" }, do: { $gt: [{ $var: "item" }, 1] } }, { ...ctx }), 2);
  assert.equal(resolve({ $reduce: { $var: "nums" }, do: { $add: [{ $var: "accumulator" }, { $var: "item" }] }, initial: 0 }, { ...ctx }), 6);
});

test("filter, find and reduce need a `do`", () => {
  assert.throws(() => resolve({ $filter: [1] }, {}), /filter needs a `do` condition/);
  assert.throws(() => resolve({ $find: [1] }, {}), /find needs a `do` condition/);
  assert.throws(() => resolve({ $reduce: [1] }, {}), /reduce needs a `do` reducer/);
});

test("return: short-circuits a step array", () => {
  const out = resolve(
    [
      { $setVars: { x: 1 } },
      { $if: { $eq: [{ $var: "x" }, 1] }, then: { $return: "early" } },
      "last",
    ],
    {},
  );
  assert.equal(out, "early");
});

test("return: absent, the last step's value wins", () => {
  const out = resolve([{ $setVars: { x: 1 } }, { $var: "x" }], {});
  assert.equal(out, 1);
});

test("a literal step is rejected, not silently run as a value", () => {
  // `["Hello"]` is a value dressed up as a sequence: every literal step resolves
  // to itself, so it can only ever be a no-op or the array's return value.
  assert.throws(() => resolve(["Hello"], {}), /step must be an expression object/);
  assert.throws(() => resolve([{ $setVars: { x: 1 } }, 42], {}), /step must be an expression object/);
});

// `do` runs as steps on every iterator: an array is a sequence, its `$as`
// writes are seen by the steps after it, and its last value is the item's.
const twoSteps = [{ $multiply: [{ $var: "item" }, 10], $as: "big" }, { $add: [{ $var: "big" }, 1] }];

test("do as steps: map, filter, find, reduce and mapValues run an array as a sequence", () => {
  assert.deepEqual(resolve({ $map: [1, 2], do: twoSteps }, {}), [11, 21]);
  assert.deepEqual(resolve({ $filter: [1, 2, 3], do: [{ $gt: [{ $var: "item" }, 1], $as: "keep" }, { $var: "keep" }] }, {}), [2, 3]);
  assert.equal(resolve({ $find: [1, 2, 3], do: [{ $multiply: [{ $var: "item" }, 2], $as: "d" }, { $eq: [{ $var: "d" }, 4] }] }, {}), 2);
  assert.equal(resolve({ $reduce: [1, 2], initial: 0, do: [{ $add: [{ $var: "accumulator" }, { $var: "item" }], $as: "s" }, { $multiply: [{ $var: "s" }, 2] }] }, {}), 8);
  assert.deepEqual(resolve({ $mapValues: { a: 1, b: 2 }, do: twoSteps }, {}), { a: 11, b: 21 });
});

test("do as steps: a step's `$as` stays in its iteration", () => {
  const ctx: Record<string, unknown> = {};
  resolve({ $map: [1, 2], do: twoSteps }, ctx);
  assert.equal(ctx.big, undefined);
});

test("do as steps: `$return` ends an item's sequence with its value, and the op goes on", () => {
  const early = { $if: { $gt: [{ $var: "item" }, 1] }, then: { $return: "big" } };
  assert.deepEqual(resolve({ $map: [1, 2], do: [early, { $concat: ["small"] }] }, {}), ["small", "big"]);
});

test("do as steps: a one-step `$return` sequence builds the array a literal `do` used to", () => {
  assert.deepEqual(resolve({ $map: [1, 2], do: [{ $return: [{ $var: "item" }, { $var: "index" }] }] }, {}), [[1, 0], [2, 1]]);
});

test("do as steps: a data template still builds one object per item", () => {
  assert.deepEqual(resolve({ $map: [1, 2], do: { n: { $var: "item" }, i: { $var: "index" } } }, {}), [{ n: 1, i: 0 }, { n: 2, i: 1 }]);
});

test("do as steps: async steps run in order within an item", async () => {
  const out = await resolve({ $map: [1, 2], do: [{ $sleep: 1 }, { $multiply: [{ $var: "item" }, 3] }] }, {});
  assert.deepEqual(out, [3, 6]);
});
