import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes());

const roundTrip = (values: number[], type: string, endian?: string) =>
  resolve({ $fromBytes: { $toBytes: values, type, endian }, type, endian }, {});

const samples: Record<string, number[]> = {
  int8: [-128, -1, 0, 127],
  uint8: [0, 1, 255],
  int16: [-32768, -2, 0, 32767],
  uint16: [0, 513, 65535],
  int32: [-2147483648, -3, 0, 2147483647],
  uint32: [0, 66051, 4294967295],
  float32: [0, -1.5, 2.25, 2 ** 100],
  float64: [0, -0.1, Math.PI, 1e300],
};

test("$toBytes and $fromBytes round-trip every number type, in either byte order", async () => {
  for (const [type, values] of Object.entries(samples)) {
    for (const endian of ["little", "big"]) {
      assert.deepEqual(await roundTrip(values, type, endian), values, `${type} ${endian}`);
    }
  }
});

test("$toBytes writes a number as its type's bytes, little-endian unless told otherwise", async () => {
  assert.deepEqual([...await resolve({ $toBytes: [1], type: "float32" }, {}) as Uint8Array], [0x00, 0x00, 0x80, 0x3f]);
  assert.deepEqual([...await resolve({ $toBytes: [1], type: "float32", endian: "big" }, {}) as Uint8Array], [0x3f, 0x80, 0x00, 0x00]);
  assert.deepEqual([...await resolve({ $toBytes: [258], type: "uint16" }, {}) as Uint8Array], [0x02, 0x01]);
  assert.deepEqual([...await resolve({ $toBytes: [72, 105] }, {}) as Uint8Array], [72, 105]);
});

test("$fromBytes with a type gives a plain array of numbers", async () => {
  const out = await resolve({ $fromBytes: { $var: "bytes" }, type: "uint16" }, { bytes: new Uint8Array([1, 0, 2, 0]) });
  assert.ok(Array.isArray(out));
  assert.deepEqual(out, [1, 2]);
});

test("$toBytes writes text as UTF-8, and gives bytes back as a Uint8Array", async () => {
  const text = await resolve({ $toBytes: "héllo" }, {}) as Uint8Array;
  assert.deepEqual([...text], [...new TextEncoder().encode("héllo")]);
  assert.equal(await resolve({ $fromBytes: { $toBytes: "héllo" } }, {}), "héllo");
  const fromBuffer = await resolve({ $toBytes: { $var: "buffer" } }, { buffer: new Uint8Array([7, 8]).buffer });
  assert.ok(fromBuffer instanceof Uint8Array);
  assert.deepEqual([...fromBuffer], [7, 8]);
});

test("$fromBytes reads a blob's numbers", async () => {
  const blob = new Blob([new Uint8Array([0, 0, 0x80, 0x3f])]);
  assert.deepEqual(await resolve({ $fromBytes: { $var: "blob" }, type: "float32" }, { blob }), [1]);
});

test("float32 bytes go through base64 and back", async () => {
  const encoded = await resolve({ $toBase64: { $toBytes: [0.5, -2], type: "float32" } }, {});
  assert.equal(typeof encoded, "string");
  const decoded = await resolve(
    { $fromBytes: { $fromBase64: { $var: "encoded" }, encoding: "bytes" }, type: "float32" },
    { encoded },
  );
  assert.deepEqual(decoded, [0.5, -2]);
});

test("$toBytes refuses a number its type cannot hold, rather than wrap it", async () => {
  const fails = (step: Record<string, unknown>, pattern: RegExp) =>
    assert.rejects(Promise.resolve().then(() => resolve(step, {})), pattern);
  await fails({ $toBytes: [300] }, /item 0 is 300, outside uint8 \(whole numbers 0 to 255\)/);
  await fails({ $toBytes: [1, 2.5], type: "int16" }, /item 1 is 2.5, outside int16/);
  await fails({ $toBytes: [1, "2"], type: "float32" }, /item 1 is string, not a number/);
  await fails({ $toBytes: "text", type: "float32" }, /writes text as UTF-8/);
  await fails({ $toBytes: [1], type: "float16" }, /Invalid \$toBytes type "float16"/);
  await fails({ $toBytes: [1], endian: "middle" }, /Invalid \$toBytes endian "middle"/);
  await fails({ $toBytes: { a: 1 } }, /takes text, an array of numbers, bytes or a blob, or a stream of them, got object/);
});

test("$fromBytes refuses bytes that are not whole values", async () => {
  await assert.rejects(
    Promise.resolve().then(() => resolve({ $fromBytes: { $var: "bytes" }, type: "float32" }, { bytes: new Uint8Array(6) })),
    /6 bytes are not a whole number of float32 values, 4 bytes each/,
  );
});

/** A stream of the given values, one per read. */
function streamOf(values: unknown[]): ReadableStream<unknown> {
  const left = [...values];
  return new ReadableStream({ pull(c) { if (left.length > 0) c.enqueue(left.shift()); else c.close(); } });
}

async function readAll(stream: unknown): Promise<unknown[]> {
  assert.ok(stream instanceof ReadableStream, "a stream");
  const out: unknown[] = [];
  for await (const value of stream) out.push(value);
  return out;
}

test("$fromBytes reads a stream whole: its numbers, or its text in the encoding given", async () => {
  const bytes = new Uint8Array(new Float32Array([1, -2, 0.5]).buffer);
  const source = streamOf([bytes.subarray(0, 6), bytes.subarray(6, 7), bytes.subarray(7)]);
  assert.deepEqual(await resolve({ $fromBytes: { $var: "source" }, type: "float32" }, { source }), [1, -2, 0.5]);
  const utf16 = new Uint8Array([0x68, 0x00, 0xe9, 0x00]);
  assert.equal(await resolve({ $fromBytes: { $var: "source" }, encoding: "utf-16le" }, { source: streamOf([utf16.subarray(0, 3), utf16.subarray(3)]) }), "hé");
  await assert.rejects(
    Promise.resolve(resolve({ $fromBytes: { $var: "source" }, type: "float32" }, { source: streamOf([new Uint8Array(6)]) })),
    /6 bytes are not a whole number of float32 values/,
  );
});

test("$fromBytes reads text in the encoding given", async () => {
  const cafe = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
  assert.equal(await resolve({ $fromBytes: { $var: "cafe" }, encoding: "windows-1252" }, { cafe }), "café");
  await assert.rejects(Promise.resolve().then(() => resolve({ $fromBytes: { $var: "cafe" }, encoding: "klingon" }, { cafe })), /encoding "klingon" is not a text encoding/);
  await assert.rejects(Promise.resolve().then(() => resolve({ $fromBytes: { $var: "cafe" }, encoding: "utf-8", type: "uint8" }, { cafe })), /not both/);
});

test("$toBytes reads a stream whole, joining the bytes of all its values", async () => {
  const mixed = await resolve({ $toBytes: { $var: "source" } }, { source: streamOf(["hé", [1, 2], new Uint8Array([9]), new Blob(["!"])]) });
  assert.ok(mixed instanceof Uint8Array);
  assert.deepEqual([...mixed], [0x68, 0xc3, 0xa9, 1, 2, 9, 0x21]);
  const numbers = await resolve({ $toBytes: { $var: "source" }, type: "uint16" }, { source: streamOf([[1, 2], [258]]) });
  assert.deepEqual([...numbers as Uint8Array], [1, 0, 2, 0, 2, 1]);
  await assert.rejects(Promise.resolve(resolve({ $toBytes: { $var: "source" }, type: "uint16" }, { source: streamOf([[1], "text"]) })), /writes text as UTF-8/);
});

test("$map over a stream with $toBytes keeps it a stream of each value's bytes", async () => {
  const out = await readAll(await resolve(
    { $map: { $var: "source" }, do: { $toBytes: { $var: "item" }, type: "uint16" } },
    { source: streamOf([[1], [258]]) },
  ));
  assert.deepEqual(out.map(b => [...(b as Uint8Array)]), [[1, 0], [2, 1]]);
});

test("$streamSplit reads a stream's numbers as they arrive, a number split across two values kept whole", async () => {
  const bytes = new Uint8Array(new Float32Array([1, -2, 0.5, 4]).buffer);
  const pieces = () => streamOf([bytes.subarray(0, 6), bytes.subarray(6, 7), bytes.subarray(7)]);
  const split = (extra: Record<string, unknown>) => resolve({ $streamSplit: { $var: "source" }, kind: "numbers", type: "float32", ...extra }, { source: pieces() });
  assert.deepEqual(await readAll(await split({})), [[1], [-2, 0.5, 4]]);
  assert.deepEqual(await readAll(await split({ count: 2 })), [[1, -2], [0.5, 4]]);
  const big = new Uint8Array([0x01, 0x02]);
  assert.deepEqual(await readAll(await resolve({ $streamSplit: { $var: "source" }, kind: "numbers", type: "uint16", endian: "big" }, { source: streamOf([big]) })), [[258]]);
});

test("$streamSplit numbers fails a stream that ends partway through a number or a record, and wants a type", async () => {
  const split = (source: ReadableStream<unknown>, extra: Record<string, unknown>) =>
    resolve({ $streamSplit: { $var: "source" }, kind: "numbers", ...extra }, { source });
  await assert.rejects(readAll(await split(streamOf([new Uint8Array(6)]), { type: "float32" })), /ended 2 bytes into a float32 value of 4/);
  await assert.rejects(readAll(await split(streamOf([new Uint8Array(12)]), { type: "float32", count: 2 })), /ended 1 numbers into a record of 2/);
  await assert.rejects(Promise.resolve().then(() => split(streamOf([]), {})), /needs a type/);
  await assert.rejects(Promise.resolve().then(() => split(streamOf([]), { type: "float32", count: 0 })), /count takes how many numbers make a record/);
});

test("$toBytes reads a blob's bytes", async () => {
  const blob = new Blob(["hi"]);
  assert.deepEqual([...await resolve({ $toBytes: { $var: "blob" } }, { blob }) as Uint8Array], [104, 105]);
});

test("$blob gathers a stream of bytes or text into one blob", async () => {
  const source = streamOf([new TextEncoder().encode("id,"), "name\n", new Uint8Array([0x31]).buffer]);
  const blob = await resolve({ $blob: { $var: "source" }, type: "text/csv" }, { source });
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, "text/csv");
  assert.equal(await blob.text(), "id,name\n1");
  await assert.rejects(Promise.resolve(resolve({ $blob: { $var: "source" } }, { source: streamOf(["a", 1]) })), /takes bytes or text, or a stream of them, got number/);
});
