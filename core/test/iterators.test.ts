import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

// The resolver the steps below run in; contexts are adopted at its entry points.
const resolve = createResolver(coreNodes());

test("map: exposes the index as `index`, like filter/find/reduce", () => {
  const out = resolve({ $map: ["a", "b", "c"], do: { $concat: [{ $var: "index" }, ":", { $var: "item" }] } }, {});
  assert.deepEqual(out, ["0:a", "1:b", "2:c"]);
});

test("map: renames the index via the `index` sibling", () => {
  const out = resolve({ $map: ["a", "b"], item: "x", index: "i", do: { $concat: [{ $var: "i" }, "=", { $var: "x" }] } }, {});
  assert.deepEqual(out, ["0=a", "1=b"]);
});

test("map: item/index names may be expressions, resolved before use", () => {
  const out = resolve(
    { $map: ["a", "b"], item: { $var: "itemVar" }, index: { $var: "indexVar" }, do: { $concat: [{ $var: "i" }, "=", { $var: "n" }] } },
    { itemVar: "n", indexVar: "i" },
  );
  assert.deepEqual(out, ["0=a", "1=b"]);
});

test("an iteration binds only its item and index", () => {
  const out = resolve({ $map: ["a"], do: { $var: "loop" } }, {});
  assert.deepEqual(out, [undefined]);
});

test("foreach: exposes the index as `index`, rename-able like the array ops'", () => {
  const ctx: Record<string, unknown> = { out: [] };
  resolve({ $foreach: ["a", "b"], do: { $push: [{ $var: "out" }, { $concat: [{ $var: "index" }, ":", { $var: "item" }] }] } }, ctx);
  resolve({ $foreach: ["c"], item: "x", index: { $var: "indexVar" }, do: { $push: [{ $var: "out" }, { $concat: [{ $var: "i" }, "=", { $var: "x" }] }] } }, { ...ctx, indexVar: "i" });
  assert.deepEqual(ctx.out, ["0:a", "1:b", "0=c"]);
});

test("filter: renames the item via the `item` sibling", () => {
  const out = resolve({ $filter: [1, 2, 3], do: { $gt: [{ $var: "n" }, 1] }, item: "n" }, {});
  assert.deepEqual(out, [2, 3]);
});

test("filter: default item is `item`", () => {
  const out = resolve({ $filter: [1, 2, 3], do: { $gt: [{ $var: "item" }, 1] } }, {});
  assert.deepEqual(out, [2, 3]);
});

test("filter: renames the index via the `index` sibling", () => {
  const out = resolve({ $filter: ["a", "b", "c"], do: { $gt: [{ $var: "i" }, 0] }, index: "i" }, {});
  assert.deepEqual(out, ["b", "c"]);
});

test("filter: item/index names may be expressions, resolved before use", () => {
  const out = resolve(
    { $filter: [1, 2, 3], do: { $gt: [{ $var: "n" }, 1] }, item: { $var: "itemVar" } },
    { itemVar: "n" },
  );
  assert.deepEqual(out, [2, 3]);
});

test("find: renames the item via the `item` sibling", () => {
  const out = resolve(
    { $find: [{ id: 1 }, { id: 2 }], do: { $eq: [{ $var: "x.id" }, 2] }, item: "x" },
    {},
  );
  assert.deepEqual(out, { id: 2 });
});

test("reduce: renames the item while accumulator stays available", () => {
  const out = resolve(
    { $reduce: [1, 2, 3], do: { $add: [{ $var: "accumulator" }, { $var: "n" }] }, initial: 0, item: "n" },
    {},
  );
  assert.equal(out, 6);
});

test("reduce: renames the accumulator via the `accumulator` sibling", () => {
  const out = resolve(
    { $reduce: [1, 2, 3], do: { $add: [{ $var: "total" }, { $var: "item" }] }, initial: 10, accumulator: "total" },
    {},
  );
  assert.equal(out, 16);
});

test("reduce: without `initial`, the first accumulator is undefined", () => {
  const out = resolve({ $reduce: ["a", "b"], do: { $concat: [{ $coalesce: [{ $var: "accumulator" }, ">"] }, { $var: "item" }] } }, {});
  assert.equal(out, ">ab");
});

// The array is the op's whole value, so it can come from an expression, as `map`'s can.
test("filter, find and reduce take their array from an expression", () => {
  const ctx = { nums: [1, 2, 3] };
  assert.deepEqual(resolve({ $filter: { $var: "nums" }, do: { $gt: [{ $var: "item" }, 1] } }, { ...ctx }), [2, 3]);
  assert.equal(resolve({ $find: { $var: "nums" }, do: { $gt: [{ $var: "item" }, 1] } }, { ...ctx }), 2);
  assert.equal(resolve({ $reduce: { $var: "nums" }, do: { $add: [{ $var: "accumulator" }, { $var: "item" }] }, initial: 0 }, { ...ctx }), 6);
});

test("filter, find and reduce need a `do`", () => {
  assert.throws(() => resolve({ $filter: [1] }, {}), /filter needs a `do` condition/);
  assert.throws(() => resolve({ $find: [1] }, {}), /find needs a `do` condition/);
  assert.throws(() => resolve({ $reduce: [1] }, {}), /reduce needs a `do` reducer/);
});

test("return: short-circuits a step array", () => {
  const out = resolve(
    [
      { $setVars: { x: 1 } },
      { $if: { $eq: [{ $var: "x" }, 1] }, then: { $return: "early" } },
      "last",
    ],
    {},
  );
  assert.equal(out, "early");
});

test("return: absent, the last step's value wins", () => {
  const out = resolve([{ $setVars: { x: 1 } }, { $var: "x" }], {});
  assert.equal(out, 1);
});

test("a literal step is rejected, not silently run as a value", () => {
  // `["Hello"]` is a value dressed up as a sequence: every literal step resolves
  // to itself, so it can only ever be a no-op or the array's return value.
  assert.throws(() => resolve(["Hello"], {}), /step must be an expression object/);
  assert.throws(() => resolve([{ $setVars: { x: 1 } }, 42], {}), /step must be an expression object/);
});

// `do` runs as steps on every iterator: an array is a sequence, its `$as`
// writes are seen by the steps after it, and its last value is the item's.
const twoSteps = [{ $multiply: [{ $var: "item" }, 10], $as: "big" }, { $add: [{ $var: "big" }, 1] }];

test("do as steps: map, filter, find, reduce and mapValues run an array as a sequence", () => {
  assert.deepEqual(resolve({ $map: [1, 2], do: twoSteps }, {}), [11, 21]);
  assert.deepEqual(resolve({ $filter: [1, 2, 3], do: [{ $gt: [{ $var: "item" }, 1], $as: "keep" }, { $var: "keep" }] }, {}), [2, 3]);
  assert.equal(resolve({ $find: [1, 2, 3], do: [{ $multiply: [{ $var: "item" }, 2], $as: "d" }, { $eq: [{ $var: "d" }, 4] }] }, {}), 2);
  assert.equal(resolve({ $reduce: [1, 2], initial: 0, do: [{ $add: [{ $var: "accumulator" }, { $var: "item" }], $as: "s" }, { $multiply: [{ $var: "s" }, 2] }] }, {}), 8);
  assert.deepEqual(resolve({ $mapValues: { a: 1, b: 2 }, do: twoSteps }, {}), { a: 11, b: 21 });
});

test("do as steps: a step's `$as` stays in its iteration", () => {
  const ctx: Record<string, unknown> = {};
  resolve({ $map: [1, 2], do: twoSteps }, ctx);
  assert.equal(ctx.big, undefined);
});

test("do as steps: `$return` ends an item's sequence with its value, and the op goes on", () => {
  const early = { $if: { $gt: [{ $var: "item" }, 1] }, then: { $return: "big" } };
  assert.deepEqual(resolve({ $map: [1, 2], do: [early, { $concat: ["small"] }] }, {}), ["small", "big"]);
});

test("do as steps: a one-step `$return` sequence builds the array a literal `do` used to", () => {
  assert.deepEqual(resolve({ $map: [1, 2], do: [{ $return: [{ $var: "item" }, { $var: "index" }] }] }, {}), [[1, 0], [2, 1]]);
});

test("do as steps: a data template still builds one object per item", () => {
  assert.deepEqual(resolve({ $map: [1, 2], do: { n: { $var: "item" }, i: { $var: "index" } } }, {}), [{ n: 1, i: 0 }, { n: 2, i: 1 }]);
});

test("do as steps: async steps run in order within an item", async () => {
  const out = await resolve({ $map: [1, 2], do: [{ $sleep: 1 }, { $multiply: [{ $var: "item" }, 3] }] }, {});
  assert.deepEqual(out, [3, 6]);
});

/** A stream of `values`, each read only when asked for, counting the reads and noting a cancel. */
function source(values: unknown[]): { stream: ReadableStream<unknown>; reads: () => number; cancelled: () => boolean } {
  let reads = 0;
  let cancelled = false;
  const stream = new ReadableStream<unknown>({
    pull(controller) {
      if (reads >= values.length) return controller.close();
      controller.enqueue(values[reads++]);
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, reads: () => reads, cancelled: () => cancelled };
}

/** Every value a stream yields, read to its end. */
async function readAll(stream: unknown): Promise<unknown[]> {
  assert.ok(stream instanceof ReadableStream, "expected a ReadableStream");
  const reader = stream.getReader();
  const out: unknown[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

test("foreach over a stream: each value's steps finish before the next is read, and the last result is the value", async () => {
  const ctx = { src: source([1, 2]).stream, out: [] as unknown[] };
  const last = await resolve({
    $foreach: { $var: "src" },
    do: [
      { $push: [{ $var: "out" }, { $concat: ["start ", { $var: "item" }, "@", { $var: "index" }] }] },
      { $sleep: 5 },
      { $push: [{ $var: "out" }, { $concat: ["end ", { $var: "item" }] }] },
      { $var: "item" },
    ],
  }, ctx);
  assert.deepEqual(ctx.out, ["start 1@0", "end 1", "start 2@1", "end 2"]);
  assert.equal(last, 2);
  assert.equal(await resolve({ $foreach: { $var: "empty" }, do: { $var: "item" } }, { empty: source([]).stream }), null);
});

test("foreach over a stream: parallel does not apply", async () => {
  await assert.rejects(async () => resolve({ $foreach: { $var: "src" }, parallel: true, do: { $var: "item" } }, { src: source([1]).stream }), /parallel/);
});

test("map and filter over a stream are lazy: a stream back, the source read as it is read", async () => {
  const mapped = source([1, 2, 3]);
  const doubled = await resolve({ $map: { $var: "src" }, do: { $multiply: [{ $var: "item" }, 2] } }, { src: mapped.stream });
  assert.equal(mapped.reads(), 0);
  assert.deepEqual(await readAll(doubled), [2, 4, 6]);

  const filtered = source([1, 2, 3, 4]);
  const kept = await resolve({ $filter: { $var: "src" }, do: { $gt: [{ $var: "n" }, 2] }, item: "n" }, { src: filtered.stream });
  assert.equal(filtered.reads(), 0);
  assert.deepEqual(await readAll(kept), [3, 4]);
});

test("find over a stream reads until the first match and cancels the rest", async () => {
  const src = source([1, 2, 3, 4]);
  assert.equal(await resolve({ $find: { $var: "src" }, do: { $gt: [{ $var: "item" }, 1] } }, { src: src.stream }), 2);
  assert.equal(src.reads(), 2);
  assert.equal(src.cancelled(), true);
  assert.equal(await resolve({ $find: { $var: "src" }, do: false }, { src: source([1]).stream }), undefined);
});

test("reduce over a stream reads it to its end, and collects one with initial [] and push", async () => {
  const sum = await resolve({ $reduce: { $var: "src" }, do: { $add: [{ $var: "accumulator" }, { $var: "item" }] }, initial: 0 }, { src: source([1, 2, 3]).stream });
  assert.equal(sum, 6);
  const list = await resolve({ $reduce: { $var: "src" }, do: { $push: [{ $var: "accumulator" }, { $var: "item" }] }, initial: [] }, { src: source(["a", "b"]).stream });
  assert.deepEqual(list, ["a", "b"]);
});

test("an error in do cancels the stream it reads", async () => {
  const read = source([1, 2, 3]);
  const fail = { $if: { $eq: [{ $var: "item" }, 2] }, then: { $error: 500, message: "stop" } };
  await assert.rejects(async () => resolve({ $foreach: { $var: "src" }, do: fail }, { src: read.stream }), /stop/);
  assert.equal(read.cancelled(), true);

  const mapped = source([1, 2, 3]);
  const out = await resolve({ $map: { $var: "src" }, do: fail }, { src: mapped.stream });
  await assert.rejects(readAll(out), /stop/);
  assert.equal(mapped.cancelled(), true);
});

test("a stream is read once, and the other array ops refuse one", async () => {
  const ctx = { src: source([1]).stream };
  await resolve({ $map: { $var: "src" }, do: { $var: "item" } }, ctx);
  await assert.rejects(async () => resolve({ $foreach: { $var: "src" }, do: { $var: "item" } }, ctx), /already being read/);
  const other = { src: source([1]).stream };
  await assert.rejects(async () => resolve({ $first: { $var: "src" } }, other), /A stream is read with/);
});

test("a stream from $stream feeds the iteration ops", async () => {
  const sum = await resolve([
    { $stream: [1, 2], $as: "out" },
    { $streamWrite: [{ $var: "out" }, 3], $then: { $streamClose: { $var: "out" } } },
    { $reduce: { $var: "out" }, do: { $add: [{ $var: "accumulator" }, { $var: "item" }] }, initial: 0 },
  ], {});
  assert.equal(sum, 6);
});
