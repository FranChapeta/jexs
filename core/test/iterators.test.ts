import { test } from "node:test";
import assert from "node:assert/strict";
import { Node, createResolver, coreNodes, resolve as resolveValue } from "../src/index.js";
import type { Context, JexsNodeSchema } from "../src/index.js";

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

/** A resolver with `$work`, which waits `ms` and gives back `value`, noting how many run at once and which started. */
function workResolver() {
  const seen = { running: 0, peak: 0, started: [] as unknown[] };
  const node = new (class extends Node {
    static schema: JexsNodeSchema = { work: { type: "object" } };
    work(def: Record<string, unknown>, context: Context) {
      return resolveValue(def.$work, context, raw => {
        const { value, ms, fail } = raw as { value: unknown; ms: number; fail?: boolean };
        seen.started.push(value);
        seen.running++;
        seen.peak = Math.max(seen.peak, seen.running);
        return new Promise((ok, no) => setTimeout(() => {
          seen.running--;
          if (fail) no(new Error(`failed ${String(value)}`)); else ok(value);
        }, ms));
      });
    }
  })();
  return { run: createResolver([...coreNodes(), node]), seen };
}

const workOn = { $work: { value: { $var: "item.v" }, ms: { $var: "item.ms" }, fail: { $var: "item.fail" } } };

test("map parallel: the results keep the items' order whatever order they finish in", async () => {
  const { run } = workResolver();
  const items = [{ v: "a", ms: 30 }, { v: "b", ms: 5 }, { v: "c", ms: 15 }];
  assert.deepEqual(await run({ $map: { $var: "items" }, parallel: true, do: workOn }, { items }), ["a", "b", "c"]);
  assert.deepEqual(await run({ $map: { $var: "items" }, parallel: 2, do: workOn }, { items }), ["a", "b", "c"]);
});

test("filter parallel: the kept items keep their order whatever order their tests finish in", async () => {
  const { run } = workResolver();
  const items = [{ v: true, ms: 30, name: "a" }, { v: false, ms: 1, name: "b" }, { v: true, ms: 5, name: "c" }, { v: true, ms: 15, name: "d" }];
  const kept = await run({ $filter: { $var: "items" }, parallel: 2, do: workOn }, { items });
  assert.deepEqual((kept as { name: string }[]).map(k => k.name), ["a", "c", "d"]);
});

test("map, foreach and filter parallel: a number caps how many run at once, true runs them all", async () => {
  const items = Array.from({ length: 7 }, (_, i) => ({ v: i, ms: 5 + (i % 3) * 5 }));
  for (const op of ["$map", "$foreach", "$filter"]) {
    const capped = workResolver();
    await capped.run({ [op]: { $var: "items" }, parallel: 3, do: workOn }, { items });
    assert.equal(capped.seen.peak, 3, `${op} parallel: 3`);
    const all = workResolver();
    await all.run({ [op]: { $var: "items" }, parallel: true, do: workOn }, { items });
    assert.equal(all.seen.peak, 7, `${op} parallel: true`);
    const sequential = workResolver();
    await sequential.run({ [op]: { $var: "items" }, do: workOn }, { items });
    assert.equal(sequential.seen.peak, 1, `${op} without parallel`);
  }
});

test("foreach parallel: the value is the last item's result, not the last to finish", async () => {
  const { run } = workResolver();
  const items = [{ v: "a", ms: 5 }, { v: "b", ms: 5 }, { v: "c", ms: 1 }, { v: "d", ms: 30 }];
  assert.equal(await run({ $foreach: { $var: "items" }, parallel: 2, do: workOn }, { items }), "d");
});

test("map parallel: the first error fails it, and no item starts after it", async () => {
  const { run, seen } = workResolver();
  const items = [{ v: "a", ms: 5, fail: true }, { v: "b", ms: 20 }, { v: "c", ms: 1 }, { v: "d", ms: 1 }];
  await assert.rejects(async () => run({ $map: { $var: "items" }, parallel: 2, do: workOn }, { items }), /failed a/);
  await new Promise(r => setTimeout(r, 40));
  assert.deepEqual(seen.started, ["a", "b"]);
});

test("map, foreach and filter parallel: an empty array, and a value that is not true or a whole number", async () => {
  assert.deepEqual(await resolve({ $map: [], parallel: 2, do: { $var: "item" } }, {}), []);
  assert.deepEqual(await resolve({ $filter: [], parallel: 2, do: { $var: "item" } }, {}), []);
  for (const parallel of [0, -1, 1.5, "2"]) {
    for (const op of ["$map", "$foreach", "$filter"]) {
      await assert.rejects(async () => resolve({ [op]: [1], parallel, do: { $var: "item" } }, {}), /parallel takes true or a whole number/);
    }
  }
  assert.deepEqual(resolve({ $map: [1, 2], parallel: false, do: { $var: "item" } }, {}), [1, 2]);
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

test("foreach, map and filter over a stream: parallel takes a number, as true would read it without limit", async () => {
  for (const op of ["$foreach", "$map", "$filter"]) {
    await assert.rejects(async () => resolve({ [op]: { $var: "src" }, parallel: true, do: { $var: "item" } }, { src: source([1]).stream }), /takes a number in parallel over a stream/);
  }
});

test("map over a stream with parallel: results in the source's order, at most n at once, read at most n ahead", async () => {
  const { run, seen } = workResolver();
  const src = source(Array.from({ length: 6 }, (_, i) => ({ v: i, ms: (6 - i) * 5 })));
  const out = await run({ $map: { $var: "src" }, parallel: 3, do: workOn }, { src: src.stream });
  assert.ok(out instanceof ReadableStream);
  const reader = out.getReader();
  assert.deepEqual(await reader.read(), { done: false, value: 0 });
  assert.equal(src.reads(), 3, "three read ahead, and no more until the next is asked for");
  const rest: unknown[] = [];
  for (let r = await reader.read(); !r.done; r = await reader.read()) rest.push(r.value);
  assert.deepEqual(rest, [1, 2, 3, 4, 5]);
  assert.equal(seen.peak, 3);
});

test("filter over a stream with parallel: the kept values in the source's order", async () => {
  const { run } = workResolver();
  const items = [{ v: true, ms: 30, name: "a" }, { v: false, ms: 1, name: "b" }, { v: true, ms: 5, name: "c" }, { v: true, ms: 15, name: "d" }];
  const out = await run({ $filter: { $var: "src" }, parallel: 2, do: workOn }, { src: source(items).stream });
  assert.deepEqual((await readAll(out) as { name: string }[]).map(k => k.name), ["a", "c", "d"]);
});

test("foreach over a stream with parallel: at most n at once, and the value is the last value's result", async () => {
  const { run, seen } = workResolver();
  const items = [{ v: "a", ms: 1 }, { v: "b", ms: 1 }, { v: "c", ms: 1 }, { v: "d", ms: 5 }, { v: "e", ms: 30 }, { v: "f", ms: 1 }];
  const src = source(items);
  assert.equal(await run({ $foreach: { $var: "src" }, parallel: 3, do: workOn }, { src: src.stream }), "f");
  assert.equal(seen.peak, 3);
  assert.equal(src.cancelled(), false);
});

test("an error in a parallel run over a stream fails the op and cancels the source", async () => {
  const values = () => [{ v: "a", ms: 20 }, { v: "b", ms: 1, fail: true }, { v: "c", ms: 1 }, { v: "d", ms: 1 }, { v: "e", ms: 1 }];

  const each = workResolver();
  const eachSrc = source(values());
  await assert.rejects(async () => each.run({ $foreach: { $var: "src" }, parallel: 2, do: workOn }, { src: eachSrc.stream }), /failed b/);
  assert.equal(eachSrc.cancelled(), true, "foreach");

  const mapped = workResolver();
  const mapSrc = source(values());
  const out = await mapped.run({ $map: { $var: "src" }, parallel: 2, do: workOn }, { src: mapSrc.stream });
  await assert.rejects(async () => readAll(out), /failed b/);
  assert.equal(mapSrc.cancelled(), true, "map");
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
