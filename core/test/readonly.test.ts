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

// What a server does to a request's scope: a name no step may bind anew, one
// read through a getter, and a field of an object held read-only.
test("a name a scope holds read-only can't be bound anew, in it or any scope under it", () => {
  const root: Record<string, unknown> = {};
  const request = { method: "POST", body: { a: 1 } };
  Object.defineProperty(request, "method", { writable: false });
  Object.defineProperty(root, "request", { value: request, writable: false, enumerable: true });
  Object.defineProperty(root, "session", { get: () => ({ user: "ada" }), enumerable: true });

  for (const name of ["request", "session"]) {
    assert.throws(() => resolve({ $setVars: { [name]: {} } }, root), new RegExp(`Cannot write "${name}": "${name}" is read-only`));
    assert.throws(() => resolve({ $foreach: [1], do: [{ $concat: ["x"], $as: name }] }, root), new RegExp(`"${name}" is read-only`));
    assert.throws(() => resolve({ $map: [1], item: name, do: { $var: name } }, root), new RegExp(`Cannot bind "${name}" in a scope: it is read-only here`));
    assert.throws(() => resolve({ $setVars: { [name]: {} }, $bubble: true }, root), /is read-only/);
  }
  assert.throws(() => resolve({ $setVars: { "request.method": "GET" } }, root), /Cannot write "request\.method": "request\.method" is read-only/);
  assert.equal(request.method, "POST");

  // The rest of the object is the steps' to change and add to.
  resolve({ $setVars: { "request.body.a": 2, "request.locale": "en" } }, root);
  assert.deepEqual(request, { method: "POST", body: { a: 2 }, locale: "en" });
});
