import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes());

test("`$as` stores under a literal name", () => {
  const ctx: Record<string, unknown> = {};
  resolve([{ $add: [1, 2], $as: "sum" }], ctx);
  assert.equal(ctx.sum, 3);
});

test("`$as` resolves an expression to the name it stores under", () => {
  const ctx: Record<string, unknown> = { key: "picked" };
  resolve([{ $add: [1, 2], $as: { $var: "key" } }], ctx);
  assert.equal(ctx.picked, 3);
  assert.equal(ctx["[object Object]"], undefined);
});

test("`$as` resolves to a dot-path", () => {
  const ctx: Record<string, unknown> = { field: "total" };
  resolve([{ $add: [1, 2], $as: { $concat: ["stats.", { $var: "field" }] } }], ctx);
  assert.deepEqual(ctx.stats, { total: 3 });
});

test("`$as` and `$bubble` both resolve, and the write reaches the outer scope", () => {
  const ctx: Record<string, unknown> = { key: "picked", flag: true };
  resolve({ $foreach: [1, 2], item: "n", do: [{ $var: "n", $as: { $var: "key" }, $bubble: { $var: "flag" } }] }, ctx);
  assert.equal(ctx.picked, 2);
});

test("`$as` that resolves to anything but a non-empty string throws", () => {
  for (const name of [null, 3, "", { $var: "missing" }]) {
    assert.throws(() => resolve([{ $add: [1, 2], $as: name }], {}), /`\$as` needs a variable name/);
  }
});
