import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes);

// empty / notEmpty share the allocation-free `hasAnyKey` object check; these pin
// the contract across the value types it branches on.

test("empty: true for null/undefined, empty string/array/object", () => {
  assert.equal(resolve({ empty: null }, {}), true);
  assert.equal(resolve({ empty: { var: "$missing" } }, {}), true); // undefined
  assert.equal(resolve({ empty: "" }, {}), true);
  assert.equal(resolve({ empty: [] }, {}), true);
  assert.equal(resolve({ empty: { var: "$obj" } }, { obj: {} }), true);
});

test("empty: false for non-empty string/array/object and non-collections", () => {
  assert.equal(resolve({ empty: "x" }, {}), false);
  assert.equal(resolve({ empty: [1] }, {}), false);
  assert.equal(resolve({ empty: { var: "$obj" } }, { obj: { a: 1 } }), false);
  assert.equal(resolve({ empty: 0 }, {}), false);
  assert.equal(resolve({ empty: false }, {}), false);
});

test("notEmpty: inverse of empty across the same cases", () => {
  assert.equal(resolve({ notEmpty: null }, {}), false);
  assert.equal(resolve({ notEmpty: "" }, {}), false);
  assert.equal(resolve({ notEmpty: [] }, {}), false);
  assert.equal(resolve({ notEmpty: { var: "$obj" } }, { obj: {} }), false);
  assert.equal(resolve({ notEmpty: "x" }, {}), true);
  assert.equal(resolve({ notEmpty: [1] }, {}), true);
  assert.equal(resolve({ notEmpty: { var: "$obj" } }, { obj: { a: 1 } }), true);
});

// coalesce returns the first non-empty VALUE (not a boolean), sharing the empty
// rule above: null/undefined/""/[]/{} are skipped, 0 and false are kept.

test("coalesce: returns the first non-empty value", () => {
  assert.equal(resolve({ coalesce: [{ var: "$missing" }, "any"] }, {}), "any");
  assert.equal(resolve({ coalesce: ["", null, "x", "y"] }, {}), "x");
  assert.equal(resolve({ coalesce: [{ var: "$t" }, "any"] }, { t: "button" }), "button");
});

test("coalesce: keeps 0 and false (non-collections are not empty)", () => {
  assert.equal(resolve({ coalesce: [{ var: "$missing" }, 0] }, {}), 0);
  assert.equal(resolve({ coalesce: [null, false, "x"] }, {}), false);
});

test("coalesce: falls back to the last value when all are empty; empty array is undefined", () => {
  assert.deepEqual(resolve({ coalesce: ["", null, {}] }, {}), {});
  assert.deepEqual(resolve({ coalesce: [null, []] }, {}), []);
  assert.equal(resolve({ coalesce: [] }, {}), undefined);
});

test("coalesce: short-circuits, leaving later expressions unresolved", () => {
  // A side-effecting setVars in a later slot must not run once a value is found.
  const ctx: Record<string, unknown> = {};
  assert.equal(resolve({ coalesce: ["found", { setVars: { ran: true } }] }, ctx), "found");
  assert.equal(ctx.ran, undefined);
});

// exec resolves its value to a step sequence (typically a var holding steps),
// then runs it — so each step's `as` binding flows to later steps.

test("exec: runs a var-held step array as steps, `as` visible to later steps", () => {
  const steps = [
    { concat: ["Ada"], as: "name" },
    { concat: ["Hello, ", { var: "$name" }, "!"] },
  ];
  assert.equal(resolve({ exec: { var: "$steps" } }, { steps }), "Hello, Ada!");
});

test("exec: yields the last step's value, not the whole array", () => {
  assert.equal(resolve({ exec: { var: "$steps" } }, { steps: [1, 2, 3] }), 3);
});

test("exec: a non-array resolved value is returned as-is", () => {
  assert.equal(resolve({ exec: { concat: ["Hi ", { var: "$name" }] } }, { name: "Ada" }), "Hi Ada");
});
