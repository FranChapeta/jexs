import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes());

// ── keys / values / entries — relocated from ArrayNode, behavior unchanged ──

test("keys/values: object introspection", () => {
  assert.deepEqual(resolve({ keys: { var: "$o" } }, { o: { a: 1, b: 2 } }), ["a", "b"]);
  assert.deepEqual(resolve({ values: { var: "$o" } }, { o: { a: 1, b: 2 } }), [1, 2]);
});

test("keys/values: still accept arrays (indices / elements)", () => {
  assert.deepEqual(resolve({ keys: ["x", "y"] }, {}), ["0", "1"]);
  assert.deepEqual(resolve({ values: ["x", "y"] }, {}), ["x", "y"]);
});

test("entries: object to [{key,value}] pairs", () => {
  assert.deepEqual(
    resolve({ entries: { var: "$o" } }, { o: { a: 1, b: 2 } }),
    [{ key: "a", value: 1 }, { key: "b", value: 2 }],
  );
});

// ── pick / omit ──

test("pick: keeps only the listed keys; absent keys are skipped", () => {
  assert.deepEqual(
    resolve({ pick: [{ var: "$u" }, ["id", "name", "missing"]] }, { u: { id: 1, name: "a", secret: "x" } }),
    { id: 1, name: "a" },
  );
});

test("omit: drops the listed keys", () => {
  assert.deepEqual(
    resolve({ omit: [{ var: "$u" }, ["secret"]] }, { u: { id: 1, name: "a", secret: "x" } }),
    { id: 1, name: "a" },
  );
});

test("pick/omit: non-object source yields an empty object", () => {
  assert.deepEqual(resolve({ pick: [null, ["a"]] }, {}), {});
  assert.deepEqual(resolve({ omit: ["nope", ["a"]] }, {}), {});
});

// ── mapValues ──

test("mapValues: transforms values, keeps keys", () => {
  assert.deepEqual(
    resolve({ mapValues: { var: "$s" }, do: { multiply: [{ var: "item" }, 2] } }, { s: { a: 1, b: 3 } }),
    { a: 2, b: 6 },
  );
});

test("mapValues: exposes the current key and a rename-able item", () => {
  assert.deepEqual(
    resolve(
      { mapValues: { var: "$o" }, item: "v", do: { concat: [{ var: "key" }, "=", { var: "v" }] } },
      { o: { a: 1, b: 2 } },
    ),
    { a: "a=1", b: "b=2" },
  );
});

test("mapValues: non-object input yields an empty object", () => {
  assert.deepEqual(resolve({ mapValues: 5, do: { var: "item" } }, {}), {});
});

// ── deepMerge ──

test("deepMerge: recursively merges nested objects, later keys win", () => {
  assert.deepEqual(
    resolve({ deepMerge: [{ a: { x: 1, y: 2 } }, { a: { y: 3, z: 4 }, b: 5 }] }, {}),
    { a: { x: 1, y: 3, z: 4 }, b: 5 },
  );
});

test("deepMerge: arrays and primitives are replaced, not merged", () => {
  assert.deepEqual(resolve({ deepMerge: [{ list: [1, 2] }, { list: [3] }] }, {}), { list: [3] });
  assert.deepEqual(resolve({ deepMerge: [{ a: 1 }, { a: { nested: true } }] }, {}), { a: { nested: true } });
});

test("deepMerge: does not mutate the input objects", () => {
  const defaults = { a: { x: 1 } };
  const overrides = { a: { y: 2 } };
  resolve({ deepMerge: [{ var: "$d" }, { var: "$o" }] }, { d: defaults, o: overrides });
  assert.deepEqual(defaults, { a: { x: 1 } });
  assert.deepEqual(overrides, { a: { y: 2 } });
});
