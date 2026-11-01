import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes());

test("allow runs the ops it lists", async () => {
  const ctx: Record<string, unknown> = { page: [{ $tag: "p", content: [{ $upper: { $var: "name" } }] }], name: "ada" };
  assert.equal(String(await resolve({ $runVar: "page", allow: ["tag", "upper", "var"] }, ctx)), "<p>ADA</p>");
});

test("an op allow leaves out throws, however deep the step sits", async () => {
  const ctx: Record<string, unknown> = { page: { $tag: "div", content: [{ $if: true, then: { $setVars: { x: 1 } } }] } };
  await assert.rejects(async () => resolve({ $runVar: "page", allow: ["tag", "if"] }, ctx), /"\$setVars" is not allowed here/);
});

test("a $runVar inside can narrow the list but never widen it", async () => {
  const ctx: Record<string, unknown> = { inner: { $upper: "x" }, outer: { $runVar: "inner", allow: ["upper", "lower"] } };
  await assert.rejects(async () => resolve({ $runVar: "outer", allow: ["runVar", "lower"] }, ctx), /"\$upper" is not allowed here/);
  ctx.inner = { $lower: "X" };
  assert.equal(await resolve({ $runVar: "outer", allow: ["runVar", "lower"] }, ctx), "x");
});

test("the restriction ends with the $runVar, and its steps can't write the caller's variables", async () => {
  const ctx: Record<string, unknown> = { page: [{ $setVars: { x: 2 }, $bubble: true }, { $var: "x" }], x: 1 };
  assert.equal(await resolve({ $runVar: "page", allow: ["setVars", "var"] }, ctx), 2);
  assert.equal(ctx.x, 1);
  assert.equal(await resolve({ $upper: "after" }, ctx), "AFTER");
});

test("allow takes op names, with or without the $", async () => {
  const ctx: Record<string, unknown> = { page: { $upper: "a" } };
  assert.equal(await resolve({ $runVar: "page", allow: ["$upper"] }, ctx), "A");
  await assert.rejects(async () => resolve({ $runVar: "page", allow: "upper" }, ctx), /`allow` takes a list of op names/);
});
