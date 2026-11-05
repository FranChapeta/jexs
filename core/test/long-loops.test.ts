import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes());

// A loop over many items goes round one loop rather than a call per item, so
// none of these grows the stack with the count.
const n = 100000;
const xs = Array.from({ length: n }, (_, i) => i);
const obj = Object.fromEntries(xs.map(i => [`k${i}`, i]));

test("long loops: foreach, map, filter, find and reduce over 100000 items", () => {
  assert.equal(resolve({ $foreach: { $var: "xs" }, do: { $var: "item" } }, { xs }), n - 1);
  assert.equal((resolve({ $map: { $var: "xs" }, do: { $var: "index" } }, { xs }) as unknown[])[n - 1], n - 1);
  assert.equal((resolve({ $filter: { $var: "xs" }, do: { $gte: [{ $var: "item" }, n - 2] } }, { xs }) as unknown[]).length, 2);
  assert.equal(resolve({ $find: { $var: "xs" }, do: { $eq: [{ $var: "item" }, n - 1] } }, { xs }), n - 1);
  assert.equal(resolve({ $reduce: { $var: "xs" }, do: { $add: [{ $var: "accumulator" }, 1] }, initial: 0 }, { xs }), n);
});

test("long loops: mapValues and setVars over 100000 keys", () => {
  const mapped = resolve({ $mapValues: { $var: "obj" }, do: { $var: "key" } }, { obj }) as Record<string, unknown>;
  assert.equal(mapped[`k${n - 1}`], `k${n - 1}`);
  const context: Record<string, unknown> = {};
  resolve({ $setVars: obj }, context);
  assert.equal(context[`k${n - 1}`], n - 1);
});

test("long loops: and, or and coalesce over 100000 operands", () => {
  assert.equal(resolve({ $and: xs.map(() => true) }, {}), true);
  assert.equal(resolve({ $or: xs.map(() => false) }, {}), false);
  assert.equal(resolve({ $coalesce: [...xs.map(() => null), "last"] }, {}), "last");
});

test("long loops: items that wait keep their order, the rest running in between", async () => {
  const out = resolve({
    $map: [1, 2, 3, 4],
    do: { $if: { $eq: [{ $var: "item" }, 2] }, then: [{ $sleep: 1 }, { $var: "item" }], else: { $var: "item" } },
  }, {});
  assert.ok(out instanceof Promise);
  assert.deepEqual(await out, [1, 2, 3, 4]);
});

test("long loops: find stops at a match after an item that waited", async () => {
  const context = { seen: 0 };
  const found = await resolve({
    $find: [1, 2, 3, 4],
    do: [{ $sleep: 1 }, { $add: [{ $var: "seen" }, 1], $as: "seen", $bubble: true }, { $eq: [{ $var: "item" }, 2] }],
  }, context);
  assert.equal(found, 2);
  assert.equal(context.seen, 2);
});

test("long loops: and stops at the first falsy operand, even after one that waited", async () => {
  const context = { ran: false };
  const out = await resolve({ $and: [[{ $sleep: 1 }, true], false, { $setVars: { ran: true }, $bubble: true }] }, context);
  assert.equal(out, false);
  assert.equal(context.ran, false);
});
