import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes, boundaryContext, childContext } from "../src/index.js";

const resolve = createResolver(coreNodes());

// A request body a template writes as variables, which is data choosing names.
const writeBody = (body: unknown, context: Record<string, unknown>) =>
  resolve([{ $setVars: { $var: "body" } }], childContext(context, { body }));

test("a write through `__proto__` cannot reach the scope above a boundary", async () => {
  const startup: Record<string, unknown> = { appName: "site" };
  const request = boundaryContext(startup);
  await assert.rejects(async () => writeBody({ "__proto__.appName": "evil" }, request), /"__proto__" names the prototype/);
  assert.equal(startup.appName, "site");
});

test("a write cannot re-parent a scope, or reach the prototype every object shares", async () => {
  const ctx: Record<string, unknown> = {};
  await assert.rejects(async () => writeBody(JSON.parse('{"__proto__": {"x": 1}}'), ctx), /names the prototype/);
  await assert.rejects(async () => writeBody({ "__proto__.__proto__.polluted": true }, ctx), /names the prototype/);
  await assert.rejects(async () => writeBody({ "constructor.prototype.polluted": true }, ctx), /names the prototype/);
  assert.throws(() => resolve({ $concat: ["x"], $as: "prototype" }, {}), /names the prototype/);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("a read through a prototype key finds nothing", () => {
  const ctx: Record<string, unknown> = { user: { name: "Ada" } };
  assert.equal(resolve({ $var: "__proto__" }, ctx), undefined);
  assert.equal(resolve({ $var: "user.constructor" }, ctx), undefined);
});

test("groupBy and pick take keys an object already has, such as constructor and toString, as data", () => {
  const rows = [{ t: "constructor" }, { t: "toString" }, { t: "__proto__" }, { t: "toString" }];
  const groups = resolve({ $groupBy: [{ $var: "rows" }, "t"] }, { rows }) as Record<string, unknown[]>;
  assert.deepEqual(Object.keys(groups), ["constructor", "toString", "__proto__"]);
  assert.equal(groups.toString.length, 2);
  assert.equal(Object.getPrototypeOf(groups), Object.prototype);
  assert.deepEqual(resolve({ $pick: [{ $var: "o" }, ["constructor", "toString", "a"]] }, { o: { a: 1 } }), { a: 1 });
});

test("data's own __proto__ key stays a key of what an op builds, and never its prototype", () => {
  const body = JSON.parse('{"__proto__": {"isAdmin": true}, "name": "x"}');
  const ctx = { defaults: { theme: "light" }, body };
  const built = {
    merge: { $merge: [{ $var: "defaults" }, { $var: "body" }] },
    deepMerge: { $deepMerge: [{ $var: "defaults" }, { $var: "body" }] },
    omit: { $omit: [{ $var: "body" }, ["name"]] },
    mapValues: { $mapValues: { $var: "body" }, do: { $var: "item" } },
    fromEntries: { $fromEntries: { $entries: { $var: "body" } } },
  };
  for (const [op, expr] of Object.entries(built)) {
    const result = resolve([{ $as: "result", ...expr }, { $var: "result.isAdmin" }], ctx);
    assert.equal(result, undefined, `${op}: the injected value reads as the result's own`);
    const obj = resolve(expr, ctx) as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(obj), Object.prototype, `${op}: prototype replaced`);
    assert.ok(Object.hasOwn(obj, "__proto__"), `${op}: the key was dropped`);
  }
});

test("a scope cannot bind a prototype key, which params parsed from JSON can hold", () => {
  assert.throws(() => childContext({}, JSON.parse('{"__proto__": {"x": 1}}')), /Cannot bind "__proto__"/);
  assert.throws(() => resolve({ $runVar: "steps", params: { $var: "params" } }, { steps: [{ $concat: ["x"] }], params: JSON.parse('{"constructor": 1}') }), /Cannot bind "constructor"/);
});
