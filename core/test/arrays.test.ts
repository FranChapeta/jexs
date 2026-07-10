import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes);

// fromEntries lives on ArrayNode (its input is an array of pairs) — the inverse
// of ObjectNode's `entries`. See also its round-trip with `entries` below.

test("fromEntries: builds an object from {key,value} pairs", () => {
  assert.deepEqual(
    resolve({ fromEntries: [{ key: "a", value: 1 }, { key: "b", value: 2 }] }, {}),
    { a: 1, b: 2 },
  );
});

test("fromEntries: accepts [key, value] tuple arrays", () => {
  assert.deepEqual(resolve({ fromEntries: [["a", 1], ["b", 2]] }, {}), { a: 1, b: 2 });
});

test("fromEntries round-trips entries", () => {
  const o = { a: 1, b: "two", c: true };
  const pairs = resolve({ entries: { var: "$o" } }, { o });
  assert.deepEqual(resolve({ fromEntries: pairs }, {}), o);
});

// ── Mutating family — these edit the array referenced by the first argument in
// place (so `{ var: "$x" }` mutates context.x directly), and return per the docs.

test("push: mutates the referenced array in place and returns it", () => {
  const ctx = { items: [1, 2] };
  const out = resolve({ push: [{ var: "$items" }, 3] }, ctx);
  assert.deepEqual(ctx.items, [1, 2, 3]);      // context array mutated
  assert.equal(out, ctx.items);                // returns the same reference
});

test("push: returns a new single-element array when target is not an array", () => {
  const ctx: Record<string, unknown> = {};
  const out = resolve({ push: [{ var: "$missing" }, "x"] }, ctx);
  assert.deepEqual(out, ["x"]);
  assert.equal(ctx.missing, undefined);        // nothing to mutate; not written back
});

test("unshift: prepends in place", () => {
  const ctx = { items: [2, 3] };
  resolve({ unshift: [{ var: "$items" }, 1] }, ctx);
  assert.deepEqual(ctx.items, [1, 2, 3]);
});

test("pop / shift: remove and return the end element in place", () => {
  const ctx = { items: [1, 2, 3] };
  assert.equal(resolve({ pop: { var: "$items" } }, ctx), 3);
  assert.deepEqual(ctx.items, [1, 2]);
  assert.equal(resolve({ shift: { var: "$items" } }, ctx), 1);
  assert.deepEqual(ctx.items, [2]);
});

test("remove: removes by index in place and returns the removed element", () => {
  const ctx = { items: ["a", "b", "c"] };
  assert.equal(resolve({ remove: [{ var: "$items" }, 1] }, ctx), "b");
  assert.deepEqual(ctx.items, ["a", "c"]);
  assert.equal(resolve({ remove: [{ var: "$items" }, 5] }, ctx), undefined); // out of range
  assert.deepEqual(ctx.items, ["a", "c"]);
});

test("insert: inserts at a clamped index in place", () => {
  const ctx = { items: ["a", "c"] };
  resolve({ insert: [{ var: "$items" }, 1, "b"] }, ctx);
  assert.deepEqual(ctx.items, ["a", "b", "c"]);
  resolve({ insert: [{ var: "$items" }, 99, "d"] }, ctx); // clamps to end
  assert.deepEqual(ctx.items, ["a", "b", "c", "d"]);
});

test("move: relocates an element in place", () => {
  const ctx = { items: ["a", "b", "c", "d"] };
  resolve({ move: [{ var: "$items" }, 2, 0] }, ctx); // move "c" to front
  assert.deepEqual(ctx.items, ["c", "a", "b", "d"]);
  resolve({ move: [{ var: "$items" }, 9, 0] }, ctx); // from out of range: no-op
  assert.deepEqual(ctx.items, ["c", "a", "b", "d"]);
});

// ── Reordering verbs now mutate the source by default too ──

test("sort / sortDesc / reverse mutate the referenced array in place", () => {
  const ctx = { nums: [3, 1, 2] };
  const out = resolve({ sort: { var: "$nums" } }, ctx);
  assert.deepEqual(ctx.nums, [1, 2, 3]);
  assert.equal(out, ctx.nums);                 // same reference
  resolve({ sortDesc: { var: "$nums" } }, ctx);
  assert.deepEqual(ctx.nums, [3, 2, 1]);
  resolve({ reverse: { var: "$nums" } }, ctx);
  assert.deepEqual(ctx.nums, [1, 2, 3]);
});

test("unique / flatten rewrite the source array in place", () => {
  const ua = { xs: [1, 2, 2, 3, 1] };
  resolve({ unique: { var: "$xs" } }, ua);
  assert.deepEqual(ua.xs, [1, 2, 3]);
  const fa = { xs: [1, [2, [3]]] };
  resolve({ flatten: { var: "$xs" } }, fa);
  assert.deepEqual(fa.xs, [1, 2, 3]);
});

// ── clone: true opts out of mutation, returning a copy ──

test("clone: reordering verbs return a copy, leaving the source untouched", () => {
  const ctx = { nums: [3, 1, 2] };
  const sorted = resolve({ sort: { var: "$nums" }, clone: true }, ctx);
  assert.deepEqual(sorted, [1, 2, 3]);
  assert.deepEqual(ctx.nums, [3, 1, 2]);       // source preserved
  assert.notEqual(sorted, ctx.nums);           // distinct array
});

test("clone: mutators apply the edit to a copy", () => {
  const ctx = { items: [1, 2] };
  const pushed = resolve({ push: [{ var: "$items" }, 3], clone: true }, ctx);
  assert.deepEqual(pushed, [1, 2, 3]);
  assert.deepEqual(ctx.items, [1, 2]);         // source unchanged
});

test("clone: pop/remove peek without removing from the source", () => {
  const ctx = { items: ["a", "b", "c"] };
  assert.equal(resolve({ pop: { var: "$items" }, clone: true }, ctx), "c");
  assert.equal(resolve({ remove: [{ var: "$items" }, 0], clone: true }, ctx), "a");
  assert.deepEqual(ctx.items, ["a", "b", "c"]); // nothing removed
});

// ── listFormat — Intl.ListFormat over an array input (explicit locale) ──

test("listFormat: joins with a locale-aware conjunction by default", () => {
  assert.equal(resolve({ listFormat: ["a", "b", "c"], locale: "en-US" }, {}), "a, b, and c");
  assert.equal(resolve({ listFormat: ["a"], locale: "en-US" }, {}), "a");
});

test("listFormat: disjunction type", () => {
  assert.equal(resolve({ listFormat: ["a", "b"], locale: "en-US", type: "disjunction" }, {}), "a or b");
});

test("listFormat: coerces non-string elements to strings", () => {
  assert.equal(resolve({ listFormat: [1, 2, 3], locale: "en-US" }, {}), "1, 2, and 3");
});

test("listFormat: resolves a nested-expression array", () => {
  assert.equal(resolve({ listFormat: { var: "$tags" }, locale: "en-US" }, { tags: ["x", "y"] }), "x and y");
});
