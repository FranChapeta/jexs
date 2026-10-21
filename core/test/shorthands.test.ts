import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes, WorkerNode, type Context } from "../src/index.js";

const resolve = createResolver([...coreNodes(), new WorkerNode(null)]);

test("$dateNow takes its format by name, with ms as the default", () => {
  assert.equal(typeof resolve({ $dateNow: "ms" }, {}), "number");
  assert.equal(typeof resolve({ $dateNow: { $var: "missing" } }, {}), "number");
  assert.throws(() => resolve({ $dateNow: true }, {}), /Invalid date format "true"/);
});

test("$thread takes its name, with its steps in `do`", async () => {
  assert.equal(await resolve({ $thread: "t", do: [{ $concat: ["ok"] }] }, {}), "ok");
  assert.throws(() => resolve({ $thread: [{ $concat: ["ok"] }] }, {}), /\$thread takes the thread's name, with its steps in `do`/);
});

test("$as writes a variable by the name it is read by, a leading $ included", () => {
  const ctx: Context = {};
  resolve([{ $concat: ["a"], $as: "$x" }], ctx);
  assert.equal(ctx.$x, "a");
  assert.equal(ctx.x, undefined);
  assert.equal(resolve({ $var: "$x" }, ctx), "a");
});
