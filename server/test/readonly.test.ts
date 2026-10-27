import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import type { Resolver } from "@jexs/core";
import { ServerNode } from "../src/nodes/Server.js";

let base = "";
let resolver: Resolver;
const startup: Record<string, unknown> = {};

before(async () => {
  resolver = createResolver([...coreNodes(), new ServerNode()]);
  const port = await resolver([
    { $setVars: { settings: { theme: "dark" }, names: ["Ada"] }, readonly: true },
    {
      $listen: 0,
      do: [
        { $if: { $eq: [{ $var: "request.path" }, "/edit"] }, then: { $setVars: { "settings.theme": "light" } } },
        { $if: { $eq: [{ $var: "request.path" }, "/push"] }, then: { $push: [{ $var: "names" }, "Eve"] } },
        { $if: { $eq: [{ $var: "request.path" }, "/rebind"] }, then: { $setVars: { settings: { theme: "own" } } } },
        { $concat: [{ $var: "settings.theme" }, " ", { $count: { $var: "names" } }] },
      ],
    },
  ], startup);
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  resolver.destroy();
});

test("a request cannot change startup data written readonly, by a path or an array op", async () => {
  assert.equal((await fetch(`${base}/edit`)).status, 500);
  assert.equal((await fetch(`${base}/push`)).status, 500);
  assert.equal(await (await fetch(`${base}/`)).text(), "dark 1");
});

test("a request can still bind the name to a value of its own, and other requests keep the original", async () => {
  assert.equal(await (await fetch(`${base}/rebind`)).text(), "own 1");
  assert.equal(await (await fetch(`${base}/`)).text(), "dark 1");
});
