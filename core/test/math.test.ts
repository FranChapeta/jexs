import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes());

// Tolerance helper for the floating-point trig / interpolation ops.
const close = (a: unknown, b: number, eps = 1e-9) =>
  assert.ok(typeof a === "number" && Math.abs(a - b) < eps, `${a} !~= ${b}`);

// ── Trig — degree-based in and out (matches the existing sin/cos/atan2) ──

test("tan: degrees in", () => {
  close(resolve({ $tan: 45 }, {}), 1);
  close(resolve({ $tan: 0 }, {}), 0);
});

test("asin/acos/atan: return degrees (inverse of sin/cos/tan)", () => {
  close(resolve({ $asin: 1 }, {}), 90);
  close(resolve({ $acos: 0 }, {}), 90);
  close(resolve({ $atan: 1 }, {}), 45);
});

test("trig round-trips through degrees", () => {
  close(resolve({ $asin: { $sin: 30 } }, {}), 30);
  close(resolve({ $acos: { $cos: 60 } }, {}), 60);
  close(resolve({ $atan: { $tan: 20 } }, {}), 20);
});

// ── log / exp / sign / trunc ──

test("log family", () => {
  close(resolve({ $log: Math.E }, {}), 1);
  close(resolve({ $log2: 8 }, {}), 3);
  close(resolve({ $log10: 1000 }, {}), 3);
  close(resolve({ $exp: 0 }, {}), 1);
  close(resolve({ $exp: 1 }, {}), Math.E);
});

test("sign and trunc", () => {
  assert.equal(resolve({ $sign: -42 }, {}), -1);
  assert.equal(resolve({ $sign: 0 }, {}), 0);
  assert.equal(resolve({ $sign: 7 }, {}), 1);
  assert.equal(resolve({ $trunc: -3.9 }, {}), -3);
  assert.equal(resolve({ $trunc: 3.9 }, {}), 3);
});

// ── hypot — array input, like sum ──

test("hypot: euclidean norm of an array", () => {
  assert.equal(resolve({ $hypot: [3, 4] }, {}), 5);
  assert.equal(resolve({ $hypot: [3, 4, 12] }, {}), 13);
  assert.equal(resolve({ $hypot: [] }, {}), 0);
});

// ── lerp / mapRange ──

test("lerp: interpolates and extrapolates", () => {
  assert.equal(resolve({ $lerp: [0, 100, 0.5] }, {}), 50);
  assert.equal(resolve({ $lerp: [10, 20, 0] }, {}), 10);
  assert.equal(resolve({ $lerp: [0, 100, 1.5] }, {}), 150); // extrapolates
});

test("mapRange: linear remap, extrapolates by default", () => {
  assert.equal(resolve({ $mapRange: [5, 0, 10, 0, 100] }, {}), 50);
  assert.equal(resolve({ $mapRange: [15, 0, 10, 0, 100] }, {}), 150);
  assert.equal(resolve({ $mapRange: [-5, 0, 10, 0, 100] }, {}), -50);
});

test("mapRange: clamp bounds the result to [outMin, outMax]", () => {
  assert.equal(resolve({ $mapRange: [15, 0, 10, 0, 100], clamp: true }, {}), 100);
  assert.equal(resolve({ $mapRange: [-5, 0, 10, 0, 100], clamp: true }, {}), 0);
  // Inverted output range still clamps correctly.
  assert.equal(resolve({ $mapRange: [15, 0, 10, 100, 0], clamp: true }, {}), 0);
});

test("mapRange: zero-width input range returns outMin", () => {
  assert.equal(resolve({ $mapRange: [5, 3, 3, 10, 20] }, {}), 10);
});

// ── Intl number formatters (explicit locale for determinism) ──

test("numberFormat: locale-aware decimal with fraction-digit control", () => {
  assert.equal(resolve({ $numberFormat: 1234.5, maximumFractionDigits: 1, locale: "en-US" }, {}), "1,234.5");
  assert.equal(resolve({ $numberFormat: 1000000, locale: "en-US" }, {}), "1,000,000");
  assert.equal(resolve({ $numberFormat: 3, minimumFractionDigits: 2, locale: "en-US" }, {}), "3.00");
});

test("ordinal: English ordinal suffixes", () => {
  assert.equal(resolve({ $ordinal: 1, locale: "en-US" }, {}), "1st");
  assert.equal(resolve({ $ordinal: 2, locale: "en-US" }, {}), "2nd");
  assert.equal(resolve({ $ordinal: 3, locale: "en-US" }, {}), "3rd");
  assert.equal(resolve({ $ordinal: 4, locale: "en-US" }, {}), "4th");
  assert.equal(resolve({ $ordinal: 11, locale: "en-US" }, {}), "11th");
  assert.equal(resolve({ $ordinal: 21, locale: "en-US" }, {}), "21st");
  assert.equal(resolve({ $ordinal: 23, locale: "en-US" }, {}), "23rd");
});

// ── nested-expression inputs resolve like the rest of the node ──

test("math ops resolve nested-expression arguments", () => {
  assert.equal(resolve({ $hypot: [{ $var: "a" }, { $var: "b" }] }, { a: 3, b: 4 }), 5);
  assert.equal(resolve({ $mapRange: [{ $var: "v" }, 0, 10, 0, 100] }, { v: 5 }), 50);
});

test("toFixed formats its value with `decimals` places, 2 by default", () => {
  assert.equal(resolve({ $toFixed: 3.14159 }, {}), "3.14");
  assert.equal(resolve({ $toFixed: { $var: "price" }, decimals: 0 }, { price: 9.5 }), "10");
  assert.equal(resolve({ $toFixed: 1, decimals: 99 }, {}), (1).toFixed(20), "decimals are capped at 20");
});

test("add sums the array an expression returns", () => {
  assert.equal(resolve({ $add: { $var: "prices" } }, { prices: [1, 2, 3.5] }), 6.5);
});

test("randomNumber: an integer in [min, max], or a number with `decimals` places in it", () => {
  const seen = new Set<number>();
  for (let i = 0; i < 200; i++) {
    const n = resolve({ $randomNumber: [3, 5] }, {}) as number;
    assert.ok(Number.isInteger(n) && n >= 3 && n <= 5, String(n));
    seen.add(n);
    const f = resolve({ $randomNumber: [2, 3], decimals: 2 }, {}) as number;
    assert.ok(f >= 2 && f <= 3 && Number(f.toFixed(2)) === f, String(f));
  }
  assert.deepEqual([...seen].sort(), [3, 4, 5], "both ends come up");
  assert.ok(Number.isInteger(resolve({ $randomNumber: [0, 10], decimals: { $var: "missing" } }, {})));
});

test("randomNumber: decimals is a whole number from 0 to 15", () => {
  for (const bad of [-1, 1.5, 16, "2", null]) {
    assert.throws(() => resolve({ $randomNumber: [0, 1], decimals: bad }, {}), /decimals must be a whole number from 0 to 15/, JSON.stringify(bad));
  }
});

test("randomNumber: takes [min, max] and nothing shorter", () => {
  assert.throws(() => resolve({ $randomNumber: [6] }, {}), /\$randomNumber takes 2 operands, got 1/);
  assert.throws(() => resolve({ $randomNumber: [] }, {}), /\$randomNumber takes 2 operands, got 0/);
});

test("randomNumber: a seed makes it reproducible", () => {
  resolve({ $randomSeed: 7 }, {});
  const a = [resolve({ $randomNumber: [0, 100] }, {}), resolve({ $randomNumber: [0, 1], decimals: 6 }, {})];
  resolve({ $randomSeed: 7 }, {});
  const b = [resolve({ $randomNumber: [0, 100] }, {}), resolve({ $randomNumber: [0, 1], decimals: 6 }, {})];
  resolve({ $randomSeed: null }, {});
  assert.deepEqual(a, b);
});
