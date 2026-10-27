import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes());

test("readonly freezes the objects and arrays a value holds, however deep, but not a Map", () => {
  const map = new Map([["a", 1]]);
  const ctx: Record<string, unknown> = { map };
  resolve({ $setVars: { settings: { theme: "dark", tags: ["a"], nested: { list: [{ x: 1 }] }, map: { $var: "map" } } }, readonly: true }, ctx);
  const settings = ctx.settings as { tags: unknown[]; nested: { list: Array<{ x: number }> }; map: Map<string, number> };
  assert.ok(Object.isFrozen(settings));
  assert.ok(Object.isFrozen(settings.tags));
  assert.ok(Object.isFrozen(settings.nested.list[0]));
  settings.map.set("b", 2);
  assert.equal(map.get("b"), 2);
});

test("a dot-path write into readonly data throws, through an alias too", () => {
  const ctx: Record<string, unknown> = {};
  resolve({ $setVars: { settings: { theme: "dark", nested: {} } }, readonly: true }, ctx);
  assert.throws(() => resolve({ $setVars: { "settings.theme": "light" } }, ctx), /Cannot write "settings\.theme": "settings" is read-only data/);
  assert.throws(() => resolve({ $setVars: { "settings.nested.added": 1 } }, ctx), /"settings\.nested" is read-only data/);
  resolve({ $setVars: { alias: { $var: "settings" } } }, ctx);
  assert.throws(() => resolve({ $setVars: { "alias.theme": "light" } }, ctx), /"alias" is read-only data/);
  assert.equal((ctx.settings as { theme: string }).theme, "dark");
});

test("an in-place array op on readonly data throws, and clone: true changes a copy", () => {
  const ctx: Record<string, unknown> = {};
  resolve({ $setVars: { list: [3, 1, 2] }, readonly: true }, ctx);
  for (const op of [{ $push: [{ $var: "list" }, 4] }, { $sort: { $var: "list" } }, { $pop: { $var: "list" } }, { $remove: [{ $var: "list" }, 0] }, { $unique: { $var: "list" } }]) {
    assert.throws(() => resolve(op, ctx), /the array is read-only data; pass `clone: true`/);
  }
  assert.deepEqual(resolve({ $push: [{ $var: "list" }, 4], clone: true }, ctx), [3, 1, 2, 4]);
  assert.deepEqual(resolve({ $sort: { $var: "list" }, clone: true }, ctx), [1, 2, 3]);
  assert.deepEqual(ctx.list, [3, 1, 2]);
});

test("the variable itself can still be set to a new value, which is not frozen unless written readonly", () => {
  const ctx: Record<string, unknown> = {};
  resolve({ $setVars: { list: [1] }, readonly: true }, ctx);
  resolve({ $setVars: { list: [2] } }, ctx);
  assert.equal(Object.isFrozen(ctx.list), false);
});

test("readonly applies to a step-built map, to $bubble writes, and may be an expression", () => {
  const ctx: Record<string, unknown> = { on: true, source: { built: { a: 1 } } };
  resolve({ $setVars: { $var: "source" }, readonly: true }, ctx);
  assert.ok(Object.isFrozen(ctx.built));
  resolve({ $map: [1], do: { $setVars: { up: { a: 1 } }, readonly: { $var: "on" }, $bubble: true } }, ctx);
  assert.ok(Object.isFrozen(ctx.up));
  resolve({ $setVars: { off: { a: 1 } }, readonly: false }, ctx);
  assert.equal(Object.isFrozen(ctx.off), false);
});

test("steps stored readonly still run", () => {
  const ctx: Record<string, unknown> = {};
  resolve({ $setVars: { greet: [{ $concat: ["Hello, ", { $var: "name" }], $as: "line" }, { $var: "line" }] }, data: true, readonly: true }, ctx);
  assert.equal(resolve({ $runVar: "greet", params: { name: "Ada" } }, ctx), "Hello, Ada");
});
