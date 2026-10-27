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
  assert.equal(resolve({ $tag: "p", content: "$constructor" }, ctx), "<p></p>");
});

test("a scope cannot bind a prototype key, which params parsed from JSON can hold", () => {
  assert.throws(() => childContext({}, JSON.parse('{"__proto__": {"x": 1}}')), /Cannot bind "__proto__"/);
  assert.throws(() => resolve({ $runVar: "steps", params: { $var: "params" } }, { steps: [{ $concat: ["x"] }], params: JSON.parse('{"constructor": 1}') }), /Cannot bind "constructor"/);
});
