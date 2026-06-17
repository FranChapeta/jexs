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
