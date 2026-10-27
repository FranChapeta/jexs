import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import type { Resolver } from "@jexs/core";
import { ServerNode } from "../src/nodes/Server.js";

let base = "";
let resolver: Resolver;
const startup: Record<string, unknown> = { visits: 0, title: "startup" };

before(async () => {
  resolver = createResolver([...coreNodes(), new ServerNode()]);
  const port = await resolver({
    $listen: 0,
    do: [
      { $setVars: { visits: { $add: [{ $var: "visits" }, 1] } }, $bubble: true },
      { $setVars: { title: "changed" } },
      // A bubble from a scope inside the request lands in the request's own.
      { $map: [1], do: [{ $setVars: { inner: true }, $bubble: true }] },
      { $concat: [{ $var: "visits" }, " ", { $var: "title" }, " ", { $var: "inner" }] },
    ],
  }, startup);
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  resolver.destroy();
});

test("a request's writes, bubbled or not, stay in the request and never reach the startup context", async () => {
  assert.equal(await (await fetch(base)).text(), "1 changed true");
  assert.equal(await (await fetch(base)).text(), "1 changed true");
  assert.equal(startup.visits, 0);
  assert.equal(startup.title, "startup");
  assert.equal(startup.inner, undefined);
});

test("a request reads the startup context as it is now", async () => {
  startup.title = "renamed";
  startup.visits = 10;
  assert.equal(await (await fetch(base)).text(), "11 changed true");
  startup.visits = 0;
});
