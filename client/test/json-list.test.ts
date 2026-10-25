import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import { installDom } from "./dom.js";
import { DomNode } from "../src/nodes/Dom.js";

// A list kept in step with its data using only general ops: the array ops change
// the data, the DOM ops place one row at a time, and nothing is re-rendered that
// did not change.

const window = installDom();
const document = window.document;
const resolve = createResolver([...coreNodes(), new DomNode()]);
const settle = () => new Promise(r => setTimeout(r, 10));

const rows = () => Array.from(document.querySelectorAll("#list > li")) as unknown as HTMLLIElement[];
const labels = () => rows().map(li => (li.querySelector("input") as HTMLInputElement).value);
const indexes = () => rows().map(li => JSON.parse(li.getAttribute("data-jexs-params")!).index);

/** The page's state: the data, and the steps it keeps as variables. */
function page(): Record<string, unknown> {
  return {
    items: [{ label: "a" }, { label: "b" }, { label: "c" }],
    // One row. Its handlers find the item by the `index` its params hold.
    row: {
      $tag: "li",
      params: { index: { $var: "index" } },
      content: [
        { $tag: "input", value: { $var: "item.label" }, events: { input: { do: [
          { $as: "it", $index: [{ $var: "items" }, { $var: "index" }] },
          { $setVars: { "it.label": { $var: "value" } } },
        ] } } },
        { $tag: "button", class: "remove", events: { click: { do: { $runVar: "removeRow" } } }, content: ["x"] },
      ],
    },
    // After rows shift, each one's params get its new index.
    renumber: {
      $foreach: { $querySelectorAll: ":scope > li", in: "#list" },
      do: { $setAttr: [{ $var: "item" }, "data-jexs-params", { index: { $var: "index" } }] },
    },
    removeRow: [
      { $remove: [{ $var: "items" }, { $var: "index" }] },
      { $removeElement: { $closest: [{ $var: "target" }, "li"] } },
      { $runVar: "renumber" },
    ],
  };
}

const render = { $setProp: ["#list", "innerHTML", { $join: { $map: { $var: "items" }, do: { $runVar: "row" } }, separator: "" }] };
/** The row element at `i`. */
const rowAt = (i: number) => ({ $index: [{ $querySelectorAll: ":scope > li", in: "#list" }, i] });

beforeEach(() => {
  document.body.innerHTML = '<ul id="list"></ul>';
});

test("insert, remove, reorder and change one item, each touching only its own row", async () => {
  const ctx = page();
  const items = ctx.items as { label: string }[];
  await resolve(render, ctx);
  assert.deepEqual(labels(), ["a", "b", "c"]);
  const [a, b, c] = rows();

  // Insert at index 1: the same index for the data and the row.
  await resolve([
    { $insert: [{ $var: "items" }, 1, { label: "x" }] },
    { $insertHtml: ["#list", { $runVar: "row", params: { item: { $index: [{ $var: "items" }, 1] }, index: 1 } }], index: 1 },
    { $runVar: "renumber" },
  ], ctx);
  assert.deepEqual(labels(), ["a", "x", "b", "c"]);
  assert.deepEqual(indexes(), [0, 1, 2, 3]);
  assert.ok(rows()[0] === a && rows()[2] === b && rows()[3] === c, "the other rows are the same elements");

  // A row's own remove button: its handler reads the index its scope has now.
  (b.querySelector(".remove") as HTMLButtonElement).click();
  await settle();
  assert.deepEqual(items.map(i => i.label), ["a", "x", "c"]);
  assert.deepEqual(labels(), ["a", "x", "c"]);
  assert.deepEqual(indexes(), [0, 1, 2]);

  // Typing writes the data and leaves the DOM alone.
  const input = c.querySelector("input") as HTMLInputElement;
  input.value = "c2";
  input.dispatchEvent(new window.Event("input"));
  await settle();
  assert.equal(items[2].label, "c2");
  assert.equal(rows()[2], c);

  // Reorder: `$move` and `$moveElement` with the same indexes.
  await resolve([
    { $move: [{ $var: "items" }, 0, 2] },
    { $moveElement: [rowAt(0), "#list"], index: 2 },
    { $runVar: "renumber" },
  ], ctx);
  assert.deepEqual(items.map(i => i.label), ["x", "c2", "a"]);
  assert.deepEqual(labels(), ["x", "c2", "a"]);
  assert.equal(rows()[2], a, "the moved row is the same element");

  // Change one item and re-render only its row.
  await resolve([
    { $as: "it", $index: [{ $var: "items" }, 0] },
    { $setVars: { "it.label": "changed" } },
    { $setProp: [rowAt(0), "outerHTML", { $runVar: "row", params: { item: { $var: "it" }, index: 0 } }] },
  ], ctx);
  assert.deepEqual(labels(), ["changed", "c2", "a"]);
  assert.ok(rows()[1] === c && rows()[2] === a, "only the changed row was replaced");

  // The replacement's handlers work.
  (rows()[0].querySelector(".remove") as HTMLButtonElement).click();
  await settle();
  assert.deepEqual(items.map(i => i.label), ["c2", "a"]);
  assert.deepEqual(labels(), ["c2", "a"]);
});

// Instead of keeping indexes in each row's scope, a handler can find its row's
// position among its siblings when it fires.
test("a handler finds its own index with indexOf, so rows need no renumbering", async () => {
  const ctx = {
    items: ["a", "b", "c"],
    row: {
      $tag: "li",
      content: [
        { $var: "item" },
        { $tag: "button", events: { click: { do: [
          { $as: "li", $closest: [{ $var: "target" }, "li"] },
          { $as: "at", $indexOf: [{ $querySelectorAll: ":scope > li", in: "#list" }, { $var: "li" }] },
          { $remove: [{ $var: "items" }, { $var: "at" }] },
          { $removeElement: { $var: "li" } },
        ] } }, content: ["x"] },
      ],
    },
  };
  await resolve(render, ctx);
  await resolve([
    { $insert: [{ $var: "items" }, 0, "z"] },
    { $insertHtml: ["#list", { $runVar: "row", params: { item: "z" } }], index: 0 },
  ], ctx);

  const text = () => rows().map(li => li.firstChild!.textContent);
  assert.deepEqual(text(), ["z", "a", "b", "c"]);
  (rows()[2].querySelector("button") as HTMLButtonElement).click();
  await settle();
  assert.deepEqual(ctx.items, ["z", "a", "c"]);
  assert.deepEqual(text(), ["z", "a", "c"]);
});
