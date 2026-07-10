import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes);

// Component-wise approximate array compare (rgb/hsl arrays carry float rounding).
function closeArr(actual: unknown, expected: number[], eps = 1e-6) {
  assert.ok(Array.isArray(actual), `expected an array, got ${actual}`);
  const a = actual as number[];
  assert.equal(a.length, expected.length, `length ${a.length} !== ${expected.length}`);
  expected.forEach((e, i) => assert.ok(Math.abs(a[i] - e) < eps, `[${i}] ${a[i]} !~= ${e}`));
}

// ── hex parsing / formatting round-trips ──

test("toRgb: parses #rrggbb into 0..1 components", () => {
  closeArr(resolve({ toRgb: "#3366ff" }, {}), [0.2, 0.4, 1, 1]);
});

test("toRgb: parses #rgb and #rgba shorthand", () => {
  closeArr(resolve({ toRgb: "#f00" }, {}), [1, 0, 0, 1]);
  closeArr(resolve({ toRgb: "#ff000080" }, {}), [1, 0, 0, 128 / 255]);
});

test("toHex: emits #rrggbb, and #rrggbbaa when alpha < 1", () => {
  assert.equal(resolve({ toHex: [0.2, 0.4, 1] }, {}), "#3366ff");
  assert.equal(resolve({ toHex: [1, 0, 0, 0.5] }, {}), "#ff000080");
});

test("toRgb/toHex round-trip", () => {
  assert.equal(resolve({ toHex: { toRgb: "#3366ff" } }, {}), "#3366ff");
});

// ── rgb <-> hsl via the format sibling ──

test("toHsl: red converts to [0, 100, 50]", () => {
  closeArr(resolve({ toHsl: [1, 0, 0] }, {}), [0, 100, 50, 1]);
});

test("format sibling reads an array as hsl and converts to rgb", () => {
  closeArr(resolve({ toRgb: [0, 100, 50], format: "hsl" }, {}), [1, 0, 0, 1]);
});

test("hsl round-trips through rgb", () => {
  // A mid-tone: hsl(210, 50, 40) -> rgb -> back to the same hsl.
  const rgb = resolve({ toRgb: [210, 50, 40], format: "hsl" }, {});
  closeArr(resolve({ toHsl: rgb }, {}), [210, 50, 40, 1]);
});

// ── lighten / darken ──

test("lighten: raises HSL lightness by a 0..1 fraction", () => {
  closeArr(resolve({ lighten: ["#000000", 0.5] }, {}), [0.5, 0.5, 0.5, 1]);
});

test("darken: lowers HSL lightness by a 0..1 fraction", () => {
  closeArr(resolve({ darken: ["#ffffff", 0.5] }, {}), [0.5, 0.5, 0.5, 1]);
});

// ── mix ──

test("mix: blends component-wise in rgb space", () => {
  closeArr(resolve({ mix: ["#ff0000", "#0000ff", 0.5] }, {}), [0.5, 0, 0.5, 1]);
  closeArr(resolve({ mix: ["#ff0000", "#0000ff", 0] }, {}), [1, 0, 0, 1]);
  closeArr(resolve({ mix: ["#ff0000", "#0000ff", 1] }, {}), [0, 0, 1, 1]);
});

// ── luminance / contrast (WCAG) ──

test("luminance: black is 0, white is 1", () => {
  assert.equal(resolve({ luminance: "#000000" }, {}), 0);
  assert.ok(Math.abs((resolve({ luminance: "#ffffff" }, {}) as number) - 1) < 1e-9);
});

test("contrast: black on white is 21 (order-independent)", () => {
  const bw = resolve({ contrast: ["#000000", "#ffffff"] }, {}) as number;
  const wb = resolve({ contrast: ["#ffffff", "#000000"] }, {}) as number;
  assert.ok(Math.abs(bw - 21) < 1e-9, `${bw} !~= 21`);
  assert.ok(Math.abs(wb - 21) < 1e-9, `${wb} !~= 21`);
});

test("contrast: identical colors are 1", () => {
  assert.ok(Math.abs((resolve({ contrast: ["#3366ff", "#3366ff"] }, {}) as number) - 1) < 1e-9);
});

// ── color-returning ops emit in the format space ──

test("mix emits in the hsl space when format is hsl", () => {
  const out = resolve({ mix: [[0, 100, 50], [0, 100, 50], 0.5], format: "hsl" }, {});
  closeArr(out, [0, 100, 50, 1]);
});
