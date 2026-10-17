import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes, childContext } from "@jexs/core";
import { installDom } from "./dom.js";
import { TreeNode } from "../src/nodes/Tree.js";

const window = installDom();
const settle = () => new Promise(r => setTimeout(r, 10));

test("on-select hands over `selected`, and on-change `delta`, each in a scope of its own", async () => {
  window.document.body.innerHTML = '<div id="t"></div>';
  const resolve = createResolver([...coreNodes(), new TreeNode()]);
  const ctx: Record<string, unknown> = { seen: [], doc: [{ $tag: "p", content: ["a"] }] };
  await resolve({
    "$tree-init": "editor",
    target: "#t",
    data: { $var: "doc" },
    row: { $tag: "div", content: [{ $var: "path" }] },
    "on-select": { $push: [{ $var: "seen" }, { $var: "selected" }] },
    "on-change": { $push: [{ $var: "seen" }, { $var: "delta.action" }] },
  }, ctx);

  await resolve({ "$tree-select": "editor", path: "0" }, ctx);
  await resolve({ "$tree-update": "editor", key: "class", value: "x" }, ctx);
  await resolve({ "$tree-select": "editor", path: null }, ctx);
  await settle();

  const [picked, action, cleared] = ctx.seen as [{ path: string; node: { $tag?: string } }, string, unknown];
  assert.equal(picked.path, "0");
  assert.equal(picked.node.$tag, "p");
  assert.equal(action, "set");
  assert.equal(cleared, null);
  for (const name of ["selected", "delta", "editorData"]) assert.equal(name in ctx, false, `${name} stays in the hook's scope`);
});

// A row's event handler runs in a child scope of the context the tree was set
// up in, and must still find the tree.
test("a tree op from a child scope finds the tree, and one with no tree is an error", async () => {
  window.document.body.innerHTML = '<div id="t"></div>';
  const resolve = createResolver([...coreNodes(), new TreeNode()]);
  const ctx: Record<string, unknown> = { doc: [{ $tag: "p" }] };
  await resolve({ "$tree-init": "editor", target: "#t", data: { $var: "doc" }, row: { $tag: "div" } }, ctx);

  const handlerScope = childContext(childContext(ctx, { event: null }));
  assert.equal(((await resolve({ "$tree-select": "editor", path: "0" }, handlerScope)) as { $tag: string }).$tag, "p");

  await assert.rejects(async () => resolve({ "$tree-select": "other" }, ctx), /\$tree-select: no tree at "other"/);
  await assert.rejects(async () => resolve({ "$tree-init": "x", target: "#nope", row: {} }, {}), /\$tree-init: no element matches "#nope"/);
  await resolve({ "$tree-select": "editor", path: null }, ctx);
  await assert.rejects(async () => resolve({ "$tree-update": "editor", key: "class", value: "x" }, ctx), /nothing is selected/);
});
