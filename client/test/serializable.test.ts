import { test } from "node:test";
import assert from "node:assert/strict";
import { serializable } from "../src/serializable.js";

test("primitives pass through untouched", () => {
  assert.equal(serializable("x"), "x");
  assert.equal(serializable(42), 42);
  assert.equal(serializable(true), true);
  assert.equal(serializable(null), null);
  assert.equal(serializable(undefined), undefined);
  assert.equal(serializable(10n), 10n);
});

test("plain data passes through by identity", () => {
  const value = { a: 1, b: ["x", { c: true }] };
  assert.equal(serializable(value), value);
});

test("functions and symbols become null", () => {
  assert.equal(serializable(() => 1), null);
  assert.equal(serializable(Symbol("s")), null);
});

// The motivating case: querySelector and friends declare output "object" and
// return live elements. Structured clone throws on those, and an unsanitized
// reply would reject the whole call with an opaque error.
test("an unclonable object becomes null", () => {
  const unclonable = { handle: () => 1 };
  assert.deepEqual(serializable(unclonable), { handle: null });
});

test("a mixed array keeps its serializable members", () => {
  const out = serializable([1, "two", () => 3]) as unknown[];
  assert.deepEqual(out, [1, "two", null]);
});

test("a mixed object keeps its serializable members", () => {
  const out = serializable({ ok: 1, bad: () => 2 }) as Record<string, unknown>;
  assert.deepEqual(out, { ok: 1, bad: null });
});

// Recursion is one level deep on purpose: it rescues the common shapes without
// walking arbitrarily deep graphs on every reply.
test("nesting deeper than one level collapses rather than recursing forever", () => {
  const out = serializable({ outer: { inner: () => 1 } }) as Record<string, unknown>;
  assert.deepEqual(out, { outer: null });
});
