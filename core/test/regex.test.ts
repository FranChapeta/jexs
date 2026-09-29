import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";
import { splitPath } from "../src/helpers.js";

const resolve = createResolver(coreNodes());

// The string ops search literally unless the step says `regex: true`; `$match`
// is always a regex. A pattern is a bare source string, never `/.../flags`.

// ── literal by default ──

test("a slash-delimited needle is literal text, not a pattern", () => {
  assert.equal(resolve({ $contains: ["/badminton", "/admin/"] }, {}), false);
  assert.equal(resolve({ $contains: ["/admin/users", "/admin/"] }, {}), true);
  assert.equal(resolve({ $replace: ["/api/v1", "/api/", "/"] }, {}), "/v1");
  assert.deepEqual(resolve({ $split: ["a/b/c", "/b/"] }, {}), ["a", "c"]);
});

test("a needle from data never runs as a pattern", () => {
  assert.equal(resolve({ $contains: ["hello world", { $var: "q" }] }, { q: "/w.rld/i" }), false);
  assert.equal(resolve({ $contains: ["a+b", { $var: "q" }] }, { q: "a+b" }), true);
});

test("replace: literal, every occurrence by default and the first with all:false", () => {
  assert.equal(resolve({ $replace: ["foo foo", "foo", "bar"] }, {}), "bar bar");
  assert.equal(resolve({ $replace: ["foo foo", "foo", "bar"], all: false }, {}), "bar foo");
});

test("replace: a literal replacement keeps `$` sequences verbatim in both modes", () => {
  assert.equal(resolve({ $replace: ["a-b", "-", "$&$1"] }, {}), "a$&$1b");
  assert.equal(resolve({ $replace: ["a-b-c", "-", "$&"], all: false }, {}), "a$&b-c");
});

test("flags without regex: true is refused", () => {
  assert.throws(() => resolve({ $contains: ["abc", "B"], flags: "i" }, {}), /"flags" applies only with "regex": true/);
});

// ── regex: true ──

test("contains: regex: true tests the pattern, flags apply", () => {
  assert.equal(resolve({ $contains: ["a1 b2", "\\d"], regex: true }, {}), true);
  assert.equal(resolve({ $contains: ["abc", "\\d"], regex: true }, {}), false);
  assert.equal(resolve({ $contains: ["Admin", "^admin"], regex: true, flags: "i" }, {}), true);
  assert.equal(resolve({ $contains: ["Admin", "^admin"], regex: true }, {}), false);
});

test("split: regex: true splits on the pattern", () => {
  assert.deepEqual(resolve({ $split: ["a1b22c", "\\d+"], regex: true }, {}), ["a", "b", "c"]);
  assert.deepEqual(resolve({ $split: ["a , b,c", "\\s*,\\s*"], regex: true }, {}), ["a", "b", "c"]);
});

test("replace: regex: true replaces every match by default, the first with all:false", () => {
  assert.equal(resolve({ $replace: ["a1 b22", "\\d+", "#"], regex: true }, {}), "a# b#");
  assert.equal(resolve({ $replace: ["a1 b22", "\\d+", "#"], regex: true, all: false }, {}), "a# b22");
});

test("replace: regex replacements insert numbered and named captures", () => {
  assert.equal(resolve({ $replace: ["John Smith", "(\\w+) (\\w+)", "$2 $1"], regex: true }, {}), "Smith John");
  assert.equal(
    resolve({ $replace: ["2026-09-28", "(?<y>\\d{4})-(?<m>\\d\\d)-(?<d>\\d\\d)", "$<d>/$<m>/$<y>"], regex: true }, {}),
    "28/09/2026",
  );
});

test("a g, y or unknown flag is refused, pointing at all", () => {
  assert.throws(() => resolve({ $replace: ["a", "a", "b"], regex: true, flags: "g" }, {}), /Invalid regex flags "g" in \$replace: .*"all"/);
  assert.throws(() => resolve({ $match: ["a", "a"], flags: "y" }, {}), /Invalid regex flags "y" in \$match/);
  assert.throws(() => resolve({ $match: ["a", "a"], flags: "ii" }, {}), /Invalid regex flags "ii"/);
});

test("an invalid pattern throws with the op name instead of matching literally", () => {
  assert.throws(() => resolve({ $replace: ["a[b", "[", "x"], regex: true }, {}), /Invalid regex "\[" in \$replace: /);
  assert.throws(() => resolve({ $match: ["a", "("] }, {}), /Invalid regex "\(" in \$match: /);
});

// ── match ──

test("match: the first match as a plain object, or null", () => {
  assert.deepEqual(resolve({ $match: ["a1 b22", "[a-z](\\d+)"] }, {}), {
    match: "a1", index: 0, captures: ["1"], groups: {},
  });
  assert.equal(resolve({ $match: ["abc", "\\d"] }, {}), null);
});

test("match: named groups, and groups that took no part come back null", () => {
  assert.deepEqual(resolve({ $match: ["x-2026", "(?<year>\\d{4})(?<month>-\\d\\d)?"] }, {}), {
    match: "2026", index: 2, captures: ["2026", null], groups: { year: "2026", month: null },
  });
});

test("match: all: true returns every match object, [] when none", () => {
  assert.deepEqual(resolve({ $match: ["a1 b22", "\\d+"], all: true }, {}), [
    { match: "1", index: 1, captures: [], groups: {} },
    { match: "22", index: 4, captures: [], groups: {} },
  ]);
  assert.deepEqual(resolve({ $match: ["abc", "\\d"], all: true }, {}), []);
});

test("match: capture picks one group by number or name", () => {
  assert.equal(resolve({ $match: ["/users/42", "^/users/(\\d+)"], capture: 1 }, {}), "42");
  assert.equal(resolve({ $match: ["/users/42", "\\d+"], capture: 0 }, {}), "42");
  assert.equal(resolve({ $match: ["2026-09", "(?<y>\\d{4})"], capture: "y" }, {}), "2026");
  assert.equal(resolve({ $match: ["abc", "(\\d)"], capture: 1 }, {}), null);
  assert.equal(resolve({ $match: ["a", "a(b)?"], capture: 1 }, {}), null);
});

test("match: all with capture yields the group's text from every match", () => {
  assert.deepEqual(resolve({ $match: ["a1 b22", "\\d+"], all: true, capture: 0 }, {}), ["1", "22"]);
  assert.deepEqual(resolve({ $match: ["k=v, x=y", "(\\w)=(\\w)"], all: true, capture: 2 }, {}), ["v", "y"]);
});

test("match: an unknown group name is a template error", () => {
  assert.throws(() => resolve({ $match: ["2026", "(?<y>\\d+)"], capture: "year" }, {}), /no group named "year"/);
});

test("match: flags apply", () => {
  assert.equal(resolve({ $match: ["ABC", "b"], flags: "i", capture: 0 }, {}), "B");
  assert.equal(resolve({ $match: ["a\nb", "^b"], flags: "m", capture: 0 }, {}), "b");
});

// ── cache ──

test("a cached pattern gives the same answer on every call", () => {
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(resolve({ $match: ["a1 b2 c3", "\\d"], all: true, capture: 0 }, {}), ["1", "2", "3"]);
    assert.equal(resolve({ $contains: ["foo", "o"], regex: true }, {}), true);
    assert.equal(resolve({ $contains: ["bar", "o"], regex: true }, {}), false);
    assert.equal(resolve({ $replace: ["a1 b2", "\\d", "#"], regex: true }, {}), "a# b#");
  }
});

test("one resolver filling its regex cache leaves another's results unchanged", () => {
  const a = createResolver(coreNodes());
  const b = createResolver(coreNodes());
  assert.equal(b({ $replace: ["x1", "\\d", "#"], regex: true }, {}), "x#");
  for (let i = 0; i < 300; i++) a({ $contains: ["abc", `a{${i}}`], regex: true }, {});
  assert.equal(b({ $replace: ["x1", "\\d", "#"], regex: true }, {}), "x#");
  assert.equal(a({ $replace: ["x1", "\\d", "#"], regex: true }, {}), "x#");
});

// ── escapeRegex ──

test("escapeRegex: the escaped text matches itself under every flag", () => {
  const specials = "a.b*c+d?e^f$g(h)i[j]k{l}m|n\\o/p-q";
  for (const flags of ["", "u", "v"]) {
    const step = { $contains: [specials, { $escapeRegex: specials }], regex: true, ...(flags ? { flags } : {}) };
    assert.equal(resolve(step, {}), true, `flags "${flags}"`);
  }
  assert.equal(resolve({ $contains: ["axb", { $escapeRegex: "a.b" }], regex: true }, {}), false);
});

test("escapeRegex: builds an anchored pattern from a key", () => {
  assert.equal(
    resolve({ $match: ["a.b=1", { $concat: ["^", { $escapeRegex: "a.b" }, "=(.*)"] }], capture: 1 }, {}),
    "1",
  );
});

// ── splitPath ──

test("splitPath hands out frozen arrays, since callers share them", () => {
  const parts = splitPath("user.profile.name");
  assert.ok(Object.isFrozen(parts));
  assert.throws(() => (parts as string[]).push("x"));
  assert.deepEqual(splitPath("user.profile.name"), ["user", "profile", "name"]);
});
