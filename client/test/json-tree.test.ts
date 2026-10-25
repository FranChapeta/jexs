import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import { installDom } from "./dom.js";
import { DomNode } from "../src/nodes/Dom.js";

// A nested tree kept in step with its data using only general ops, driven by
// change messages as they would arrive from a socket. One applier, stored as
// steps, changes the data and places, moves or replaces just the rows involved.

const window = installDom();
const document = window.document;
const resolve = createResolver([...coreNodes(), new DomNode()]);

const rowAt = (path: string) => document.querySelector(`#tree [data-path="${path}"]`) as unknown as HTMLLIElement;
const label = (li: Element) => li.querySelector(":scope > span")!.textContent;
/** The tree as nested labels, read from the DOM. */
function shape(container: Element = document.querySelector("#tree") as unknown as Element): unknown[] {
  return Array.from(container.querySelectorAll(":scope > li")).map(li => {
    const kids = shape(li.querySelector(":scope > ul")!);
    return kids.length ? [label(li), kids] : label(li);
  });
}
/** Every row's path, from its data-path and from the params its handlers read. */
function paths(): string[] {
  return Array.from(document.querySelectorAll("#tree li")).map(li => {
    const scoped = JSON.parse(li.getAttribute("data-jexs-params")!).path;
    assert.equal(scoped, li.getAttribute("data-path"));
    return scoped;
  });
}

function page(): Record<string, unknown> {
  return {
    doc: [
      { label: "a", children: [{ label: "a1", children: [] }, { label: "a2", children: [] }] },
      { label: "b", children: [] },
    ],
    // A row and, inside its `ul`, its children's rows.
    node: {
      $tag: "li",
      "data-path": { $var: "path" },
      params: { path: { $var: "path" } },
      content: [
        { $tag: "span", content: [{ $var: "item.label" }] },
        { $tag: "ul", content: { $map: { $var: "item.children" }, item: "child", do: {
          $runVar: "node",
          params: { item: { $var: "child" }, path: { $concat: [{ $var: "path" }, ".children.", { $var: "index" }] } },
        } } },
      ],
    },
    // Where the children of `parent` live: in the data, in the DOM, and the path
    // prefix of their rows. `""` is the root. (Compared to `""` rather than read
    // as a condition: the path `"0"` counts as false.)
    locate: [
      { $as: "nested", $neq: [{ $var: "parent" }, ""] },
      {
        list: { $var: { $if: { $var: "nested" }, then: { $concat: ["doc.", { $var: "parent" }, ".children"] }, else: "doc" } },
        container: { $if: { $var: "nested" },
          then: { $querySelector: ":scope > ul", in: { $querySelector: { $concat: ["[data-path='", { $var: "parent" }, "']"] }, in: "#tree" } },
          else: { $querySelector: "#tree" } },
        prefix: { $if: { $var: "nested" }, then: { $concat: [{ $var: "parent" }, ".children."] }, else: "" },
      },
    ],
    // Rewrite the paths of the rows in `container`, and below them.
    renumber: {
      $foreach: { $querySelectorAll: ":scope > li", in: { $var: "container" } }, item: "li", do: [
        { $as: "p", $concat: [{ $var: "prefix" }, { $var: "index" }] },
        { $setAttr: [{ $var: "li" }, "data-path", { $var: "p" }] },
        { $setAttr: [{ $var: "li" }, "data-jexs-params", { path: { $var: "p" } }] },
        { $runVar: "renumber", params: {
          container: { $querySelector: ":scope > ul", in: { $var: "li" } },
          prefix: { $concat: [{ $var: "p" }, ".children."] },
        } },
      ],
    },
    // Apply one change message to the data and the DOM.
    apply: [
      { $as: "at", $runVar: "locate", params: { parent: { $var: "change.parent" } } },
      { $switch: { $var: "change.type" }, cases: {
        insert: [
          { $insert: [{ $var: "at.list" }, { $var: "change.index" }, { $var: "change.value" }] },
          { $insertHtml: [{ $var: "at.container" }, { $runVar: "node", params: {
            item: { $var: "change.value" }, path: { $concat: [{ $var: "at.prefix" }, { $var: "change.index" }] },
          } }], index: { $var: "change.index" } },
          { $runVar: "renumber", params: { container: { $var: "at.container" }, prefix: { $var: "at.prefix" } } },
        ],
        remove: [
          { $remove: [{ $var: "at.list" }, { $var: "change.index" }] },
          { $removeElement: { $index: [{ $querySelectorAll: ":scope > li", in: { $var: "at.container" } }, { $var: "change.index" }] } },
          { $runVar: "renumber", params: { container: { $var: "at.container" }, prefix: { $var: "at.prefix" } } },
        ],
        // `toParent` and `to` name the place after the node is taken out.
        move: [
          { $as: "moved", $remove: [{ $var: "at.list" }, { $var: "change.index" }] },
          { $as: "row", $index: [{ $querySelectorAll: ":scope > li", in: { $var: "at.container" } }, { $var: "change.index" }] },
          { $as: "to", $runVar: "locate", params: { parent: { $var: "change.toParent" } } },
          { $insert: [{ $var: "to.list" }, { $var: "change.to" }, { $var: "moved" }] },
          { $moveElement: [{ $var: "row" }, { $var: "to.container" }], index: { $var: "change.to" } },
          { $runVar: "renumber", params: { container: { $var: "at.container" }, prefix: { $var: "at.prefix" } } },
          { $runVar: "renumber", params: { container: { $var: "to.container" }, prefix: { $var: "to.prefix" } } },
        ],
        set: [
          { $as: "target", $var: { $concat: ["doc.", { $var: "change.node" }] } },
          { $setVars: { $fromEntries: [[{ $concat: ["target.", { $var: "change.key" }] }, { $var: "change.value" }]] } },
          { $setProp: [{ $querySelector: { $concat: ["[data-path='", { $var: "change.node" }, "']"] }, in: "#tree" }, "outerHTML",
            { $runVar: "node", params: { item: { $var: "target" }, path: { $var: "change.node" } } }] },
        ],
      } },
    ],
  };
}

const render = { $setProp: ["#tree", "innerHTML", { $join: { $map: { $var: "doc" }, do: {
  $runVar: "node", params: { path: { $concat: [{ $var: "index" }] } },
} }, separator: "" }] };
/** Apply `message` the way a socket handler would: it arrives as data, through `$var`. */
const receive = { $runVar: "apply", params: { change: { $var: "message" } } };

test("change messages at any depth touch only the rows involved", async () => {
  document.body.innerHTML = '<ul id="tree"></ul>';
  const ctx = page();
  await resolve(render, ctx);
  assert.deepEqual(shape(), [["a", ["a1", "a2"]], "b"]);
  assert.deepEqual(paths(), ["0", "0.children.0", "0.children.1", "1"]);
  const [a, a1, a2, b] = ["0", "0.children.0", "0.children.1", "1"].map(rowAt);

  const send = async (message: Record<string, unknown>) => {
    ctx.message = message;
    await resolve(receive, ctx);
  };

  // Insert at depth, before a1: the rows around it stay.
  await send({ type: "insert", parent: "0", index: 0, value: { label: "a0", children: [] } });
  assert.deepEqual(shape(), [["a", ["a0", "a1", "a2"]], "b"]);
  assert.deepEqual(paths(), ["0", "0.children.0", "0.children.1", "0.children.2", "1"]);
  assert.ok(rowAt("0.children.1") === a1 && rowAt("0.children.2") === a2 && rowAt("0") === a, "untouched rows are the same elements");

  // Insert at the root, before a: every path under a shifts, without a re-render.
  await send({ type: "insert", parent: "", index: 0, value: { label: "z", children: [] } });
  assert.deepEqual(shape(), ["z", ["a", ["a0", "a1", "a2"]], "b"]);
  assert.deepEqual(paths(), ["0", "1", "1.children.0", "1.children.1", "1.children.2", "2"]);
  assert.ok(rowAt("1") === a && rowAt("1.children.1") === a1 && rowAt("2") === b);

  // Move a1 out of a and into b.
  await send({ type: "move", parent: "1", index: 1, toParent: "2", to: 0 });
  assert.deepEqual(shape(), ["z", ["a", ["a0", "a2"]], ["b", ["a1"]]]);
  assert.deepEqual(paths(), ["0", "1", "1.children.0", "1.children.1", "2", "2.children.0"]);
  assert.equal(rowAt("2.children.0"), a1, "the moved row is the same element");

  // Change a node's label: only its row is rebuilt.
  await send({ type: "set", node: "2.children.0", key: "label", value: "big" });
  assert.deepEqual(shape(), ["z", ["a", ["a0", "a2"]], ["b", ["big"]]]);
  assert.notEqual(rowAt("2.children.0"), a1);
  assert.ok(rowAt("2") === b && rowAt("1.children.1") === a2);

  // Remove a0.
  await send({ type: "remove", parent: "1", index: 0 });
  assert.deepEqual(shape(), ["z", ["a", ["a2"]], ["b", ["big"]]]);
  assert.deepEqual(paths(), ["0", "1", "1.children.0", "2", "2.children.0"]);
  assert.equal(rowAt("1.children.0"), a2);

  // The data followed along.
  const labels = (nodes: { label: string; children: unknown[] }[]): unknown[] =>
    nodes.map(n => n.children.length ? [n.label, labels(n.children as typeof nodes)] : n.label);
  assert.deepEqual(labels(ctx.doc as { label: string; children: unknown[] }[]), ["z", ["a", ["a2"]], ["b", ["big"]]]);
});
