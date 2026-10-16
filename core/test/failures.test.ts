import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

// A failure is an error that reaches `$catch`, never a stand-in value (`null`,
// `0`, `false`, black) that reads like a real result.
const resolve = createResolver(coreNodes());

test("parsing what is not there is an error", () => {
  assert.throws(() => resolve({ $parseJSON: "{nope" }, {}), /^Error: \$parseJSON: /);
  assert.throws(() => resolve({ $parseInt: "px42" }, {}), /\$parseInt: "px42" does not start with a number/);
  assert.throws(() => resolve({ $parseFloat: "" }, {}), /\$parseFloat: "" does not start with a number/);
  assert.equal(resolve({ $parseInt: "42px" }, {}), 42, "a number with a unit after it still parses");
  assert.throws(() => resolve({ $toHex: "#zzz" }, {}), /"#zzz" is not a hex color/);
  assert.equal(resolve({ $toHex: "#0f08" }, {}), "#00ff0088");
});

test("arithmetic that has no answer is an error", () => {
  assert.throws(() => resolve({ $divide: [1, 0] }, {}), /\$divide by zero/);
  assert.throws(() => resolve({ $mod: [1, 0] }, {}), /\$mod by zero/);
  assert.throws(() => resolve({ $lerp: [0, 10] }, {}), /\$lerp takes 3 operands, got 2/);
  assert.throws(() => resolve({ $clamp: [5] }, {}), /\$clamp takes 3 operands, got 1/);
});

test("a comparison short of operands is an error, not false", () => {
  assert.throws(() => resolve({ $gt: [1] }, {}), /\$gt takes 2 operands, got 1/);
  assert.throws(() => resolve({ $eq: [1] }, {}), /\$eq takes 2 operands, got 1/);
  assert.throws(() => resolve({ $between: [5, 1] }, {}), /\$between takes 3 operands, got 2/);
  assert.equal(resolve({ $between: { $var: "range" } }, { range: [5, 1, 9] }), true, "the whole tuple may come from an expression");
});

test("a timer: stop reports whether one ran, while acting on a missing one is an error", () => {
  assert.equal(resolve({ $interval: "stop", id: "never" }, {}), false);
  assert.throws(() => resolve({ $interval: "pause", id: "never" }, {}), /\$interval pause: no timer "never" is running/);
  assert.throws(() => resolve({ $interval: "rewind", id: "x" }, {}), /\$interval: unknown operation "rewind"/);
  const ctx = {};
  resolve({ $interval: "start", id: "t", every: "1h", do: [] }, ctx);
  assert.equal(resolve({ $interval: "stop", id: "t" }, ctx), true);
});

test("setVars takes names and values", () => {
  assert.throws(() => resolve({ $setVars: "x" }, {}), /\$setVars takes an object of names and values/);
  assert.throws(() => resolve({ $setVars: { $var: "list" } }, { list: [1] }), /must resolve to an object/);
});
