import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes());

// A value an op cannot use is reported, rather than swapped for a default the
// template did not ask for. A value that is missing still takes the default.

test("an option outside its enum is refused, and a missing one takes the default", () => {
  assert.throws(() => resolve({ $segment: "a b", granularity: "line" }, {}), /Invalid segment granularity "line"/);
  assert.deepEqual(resolve({ $segment: "ab", granularity: { $var: "missing" } }, {}), ["a", "b"]);
  assert.throws(() => resolve({ $toHex: "#fff", format: "cmyk" }, {}), /Invalid color format "cmyk"/);
  assert.throws(() => resolve({ $dateFormat: 0, format: "us" }, {}), /Invalid date format "us"/);
  assert.equal(resolve({ $dateFormat: 0, format: { $var: "missing" } }, {}), "1970-01-01 00:00:00");
  assert.throws(() => resolve({ $dateNow: "unix" }, {}), /Invalid date format "unix"/);
});

test("$replace needs its three operands", () => {
  assert.throws(() => resolve({ $replace: ["abc", "b"] }, {}), /\$replace takes 3 operands, got 2/);
});

test("$range refuses a step of 0, which would never end", () => {
  assert.throws(() => resolve({ $range: [1, 5, 0] }, {}), /\$range step must not be 0/);
});

test("$fromEntries refuses an entry that is neither { key, value } nor [key, value]", () => {
  assert.throws(() => resolve({ $fromEntries: [["a", 1], "b"] }, {}), /\$fromEntries takes/);
  assert.throws(() => resolve({ $fromEntries: [["a"]] }, {}), /\$fromEntries takes/);
});

test("$avg, $min and $max of nothing give undefined, not 0", () => {
  assert.equal(resolve({ $avg: [] }, {}), undefined);
  assert.equal(resolve({ $min: [] }, {}), undefined);
  assert.equal(resolve({ $max: [] }, {}), undefined);
});

test("$error refuses a status that is not one, and a missing one is 500", async () => {
  const status = (code: unknown) => resolve({ $error: code, $catch: [{ $var: "error.status" }] }, {});
  assert.equal(status({ $var: "missing" }), 500);
  assert.equal(status(404), 404);
  assert.equal(status("404"), 404);
  for (const bad of [null, 0, 4.5, 99, 600, "nope", ""]) {
    assert.throws(() => resolve({ $error: bad }, {}), /\$error status must be an HTTP status/, JSON.stringify(bad));
  }
});
