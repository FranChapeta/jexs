import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes);

// Regex lives on the string ops: a `/pattern/flags` argument is treated as a
// regular expression; any other string is literal.

test("contains: a /regex/ needle tests the pattern; a plain needle is a substring", () => {
  assert.equal(resolve({ contains: ["a1 b2", "/\\d/"] }, {}), true);
  assert.equal(resolve({ contains: ["abc", "/\\d/"] }, {}), false);
  assert.equal(resolve({ contains: ["hello world", "world"] }, {}), true);
});

test("match: returns matches for a /regex/ or bare pattern", () => {
  assert.deepEqual(resolve({ match: ["a1 b2", "/\\d/g"] }, {}), ["1", "2"]);
  // A bare pattern (no /.../) compiles as a regex source too; first match here.
  const first = resolve({ match: ["a1 b2", "\\d"] }, {}) as string[];
  assert.equal(first[0], "1");
  assert.equal(resolve({ match: ["abc", "/\\d/"] }, {}), null);
});

test("split: a /regex/ separator splits on the pattern; a plain separator is literal", () => {
  assert.deepEqual(resolve({ split: ["a1b2c", "/\\d/"] }, {}), ["a", "b", "c"]);
  assert.deepEqual(resolve({ split: ["a,b,c", ","] }, {}), ["a", "b", "c"]);
});

test("replace: regex substitution via a /pattern/flags search", () => {
  assert.equal(resolve({ replace: ["a1 b2", "/\\d/g", "#"] }, {}), "a# b#");
  // Without the g flag, only the first match is replaced.
  assert.equal(resolve({ replace: ["a1 b2", "/\\d/", "#"] }, {}), "a# b2");
  // Group refs work through the replacement string.
  assert.equal(resolve({ replace: ["John Smith", "/(\\w+) (\\w+)/", "$2 $1"] }, {}), "Smith John");
});

test("replace: literal search, all by default and first with all:false", () => {
  assert.equal(resolve({ replace: ["foo foo", "foo", "bar"] }, {}), "bar bar");
  assert.equal(resolve({ replace: ["foo foo", "foo", "bar"], all: false }, {}), "bar foo");
});
