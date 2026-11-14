import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes());
const encoder = new TextEncoder();

/** A stream of the given values, one per read. */
function streamOf(values: unknown[]): ReadableStream<unknown> {
  const left = [...values];
  return new ReadableStream({ pull(c) { if (left.length > 0) c.enqueue(left.shift()); else c.close(); } });
}
const gather = { $reduce: { $fromBytes: { $var: "source" } }, initial: "", do: { $concat: [{ $var: "accumulator" }, { $var: "item" }] } };

test("$fromBytes reads bytes as the UTF-8 text they are", async () => {
  const bytes = encoder.encode("Señor café");
  assert.equal(await resolve({ $fromBytes: { $var: "bytes" } }, { bytes }), "Señor café");
  assert.equal(await resolve({ $fromBytes: { $var: "bytes" } }, { bytes: bytes.buffer }), "Señor café");
  assert.equal(await resolve({ $fromBytes: { $var: "bytes" } }, { bytes: Buffer.from("plain") }), "plain");
});

test("$fromBytes reads a stream of bytes as a stream of text, a character split across two values kept whole", async () => {
  const bytes = encoder.encode("Señor café");
  const cut = bytes.indexOf(0xc3) + 1;
  assert.equal(await resolve(gather, { source: streamOf([bytes.subarray(0, cut), bytes.subarray(cut)]) }), "Señor café");
  assert.equal(await resolve(gather, { source: streamOf([]) }), "");
});

test("$fromBytes takes nothing but bytes: any other value, or a stream that holds one, is an error", async () => {
  await assert.rejects(Promise.resolve().then(() => resolve({ $fromBytes: "text" }, {})), /takes bytes/);
  await assert.rejects(Promise.resolve(resolve(gather, { source: streamOf([encoder.encode("a"), "b"]) })), /stream of bytes held string/);
});
