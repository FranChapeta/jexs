import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes());

// ── normalize — Unicode normalization forms ──

test("normalize: composes to NFC by default", () => {
  // "e" + combining acute accent -> single precomposed "é" (U+00E9).
  const out = resolve({ normalize: "é" }, {});
  assert.equal(out, "é");
  assert.equal(String(out).length, 1);
});

test("normalize: form sibling selects the decomposition", () => {
  // Precomposed "é" -> "e" + combining accent under NFD (two code units).
  const out = resolve({ normalize: "é", form: "NFD" }, {});
  assert.equal(out, "é");
  assert.equal(String(out).length, 2);
});

test("normalize: unknown form falls back to NFC", () => {
  assert.equal(resolve({ normalize: "é", form: "bogus" }, {}), "é");
});

// ── segment — Intl.Segmenter, Unicode-correct unlike split/length ──

test("segment: grapheme keeps emoji whole where length over-counts", () => {
  // "a👍b": the thumbs-up is two UTF-16 units, so length is 4 but there are 3 graphemes.
  assert.equal(resolve({ length: "a\u{1f44d}b" }, {}), 4);
  assert.deepEqual(resolve({ segment: "a\u{1f44d}b" }, {}), ["a", "\u{1f44d}", "b"]);
});

test("segment: word granularity yields locale word boundaries", () => {
  assert.deepEqual(
    resolve({ segment: "hello world", granularity: "word", locale: "en-US" }, {}),
    ["hello", " ", "world"],
  );
});

test("segment: resolves a nested-expression input", () => {
  assert.deepEqual(resolve({ segment: { var: "$s" } }, { s: "hi" }), ["h", "i"]);
});

// base64 wraps the platform's btoa/atob, which are Latin-1 only: `btoa("héllo")`
// throws on its own, so the UTF-8 round trip is the part worth pinning.
test("toBase64: encodes UTF-8, matching what every other language calls base64", () => {
  assert.equal(resolve({ toBase64: "hello" }, {}), "aGVsbG8=");
  assert.equal(resolve({ toBase64: "héllo ✓" }, {}), "aMOpbGxvIOKckw==");
  assert.equal(resolve({ toBase64: "" }, {}), "");
});

test("toBase64: urlSafe swaps the two characters and drops the padding", () => {
  assert.equal(resolve({ toBase64: "a?b>c~ÿ" }, {}), "YT9iPmN+w78=");
  assert.equal(resolve({ toBase64: "a?b>c~ÿ", urlSafe: true }, {}), "YT9iPmN-w78");
});

test("fromBase64: reads either alphabet, padded or not", () => {
  assert.equal(resolve({ fromBase64: "aMOpbGxvIOKckw==" }, {}), "héllo ✓");
  assert.equal(resolve({ fromBase64: "YT9iPmN-w78" }, {}), "a?b>c~ÿ");
  assert.equal(resolve({ fromBase64: "YT9iPmN+w78=" }, {}), "a?b>c~ÿ");
  assert.equal(resolve({ fromBase64: "" }, {}), "");
});

test("base64: round trips text far past the spread limit", () => {
  // `String.fromCharCode(...bytes)` overflows the stack somewhere above 100KB,
  // which is why the encoder chunks; 300KB proves the chunking works.
  const big = "é".repeat(300_000);
  assert.equal(resolve({ fromBase64: { toBase64: { var: "$big" } } }, { big }), big);
});

test("base64: an expression on either side, and urlSafe as one too", () => {
  assert.equal(
    resolve({ toBase64: { concat: [{ var: "$user" }, ":", { var: "$key" }] } }, { user: "ada", key: "s3cret" }),
    "YWRhOnMzY3JldA==",
  );
  assert.equal(resolve({ toBase64: "a?b>c~ÿ", urlSafe: { var: "$safe" } }, { safe: true }), "YT9iPmN-w78");
});
