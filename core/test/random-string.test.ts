import { test } from "node:test";
import assert from "node:assert/strict";
import { randomString } from "../src/index.js";

// It names OAuth `state` values and the like, so it must not be predictable:
// the characters come from the platform's crypto source, never Math.random.
test("randomString draws from crypto, not Math.random", (t) => {
  t.mock.method(Math, "random", () => { throw new Error("Math.random used"); });
  const value = randomString(64);
  assert.equal(value.length, 64);
  assert.match(value, /^[A-Za-z0-9]{64}$/);
});

test("randomString defaults to 32 characters and differs between calls", () => {
  const a = randomString();
  assert.equal(a.length, 32);
  assert.notEqual(a, randomString());
});
