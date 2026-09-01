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
