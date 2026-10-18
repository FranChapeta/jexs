import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import { installDom } from "./dom.js";
import { DomNode } from "../src/nodes/Dom.js";

// A handler with a `target` selector serves the matching elements inside the
// one it is on: one handler on a list for every row, with the row, its index
// and where the pointer is in it.

const window = installDom();
const document = window.document;
const resolve = createResolver([...coreNodes(), new DomNode()]);
const settle = () => new Promise(r => setTimeout(r, 10));
const $ = (selector: string) => document.querySelector(selector) as unknown as HTMLElement;

/** Record what a handler's scope holds, for the test to read. */
const record = { $push: [{ $var: "seen" }, { tag: { $getProp: [{ $var: "target" }, "tagName"] }, index: { $var: "index" }, side: { $var: "side" } }] };

/** Render a list whose `ul` has the given handlers, into a fresh page. */
async function list(events: Record<string, unknown>, ctx: Record<string, unknown>) {
  document.body.innerHTML = '<div id="root"></div>';
  const row = (text: string) => ({ $tag: "li", content: [{ $tag: "span", content: [text] }] });
  await resolve({ $setProp: ["#root", "innerHTML", { $tag: "ul", events, content: [row("a"), row("b"), row("c")] }] }, ctx);
}

/** Give `el` a layout box, which the test DOM does not compute. */
function box(el: HTMLElement, top: number, height: number, left = 0, width = 100) {
  el.getBoundingClientRect = () => ({ top, height, bottom: top + height, left, width, right: left + width, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
}

/**
 * Lay a list's rows out at `boxes` ([top, height, left, width] each), drag over
 * row `hover` at each [x, y], and return the sides its handler saw. A browser's
 * DragEvent is a MouseEvent, with its pointer position; the test DOM's is not,
 * so a MouseEvent stands in for it.
 */
async function sidesOver(boxes: number[][], hover: number, points: number[][], style?: string): Promise<string[]> {
  const ctx: Record<string, unknown> = { seen: [] };
  document.body.innerHTML = '<div id="root"></div>';
  const rows = boxes.map(() => ({ $tag: "li", content: ["x"] }));
  await resolve({ $setProp: ["#root", "innerHTML", { $tag: "ul", ...(style ? { style } : {}), events: { dragover: { target: "li", do: record } }, content: rows }] }, ctx);
  const lis = Array.from(document.querySelectorAll("li")) as unknown as HTMLElement[];
  boxes.forEach(([top, height, left, width], i) => box(lis[i], top, height, left, width));
  for (const [x, y] of points) lis[hover].dispatchEvent(new window.MouseEvent("dragover", { bubbles: true, clientX: x, clientY: y }));
  await settle();
  return (ctx.seen as { side: string }[]).map(s => s.side);
}

beforeEach(() => {
  document.body.innerHTML = "";
});

test("Element keeps a handler's target selector", async () => {
  const html = await resolve({ $tag: "ul", events: { click: { target: "li", do: [] } } }, {});
  assert.match(String(html), /&quot;target&quot;:&quot;li&quot;/);
});

test("one handler serves every matching row, rows added later included, with the row as target and its index", async () => {
  const ctx: Record<string, unknown> = { seen: [] };
  await list({ click: { target: "li", do: record } }, ctx);

  $("li:nth-child(2) span").click();
  $("ul").click();
  await resolve({ $insertHtml: ["ul", "<li><span>new</span></li>"], index: 0 }, ctx);
  $("li:nth-child(1) span").click();
  $("li:nth-child(4)").click();
  await settle();

  const seen = ctx.seen as { tag: string; index: number }[];
  assert.deepEqual(seen.map(s => [s.tag, s.index]), [["LI", 1], ["LI", 0], ["LI", 3]], "a click on the list itself matches no row and runs nothing");
});

test("a pointer event over something inside the target says which half of the target it is in", async () => {
  const ctx: Record<string, unknown> = { seen: [] };
  await list({ dragover: { target: "li", do: record } }, ctx);
  const li = $("li:nth-child(1)");
  box(li, 100, 40);
  // A browser's DragEvent is a MouseEvent, with its pointer position; the test
  // DOM's is not, so a MouseEvent stands in for it.
  for (const y of [102, 118, 122, 138]) {
    li.querySelector("span")!.dispatchEvent(new window.MouseEvent("dragover", { bubbles: true, clientY: y }));
  }
  await settle();
  assert.deepEqual((ctx.seen as { side: string }[]).map(s => s.side), ["before", "before", "after", "after"]);
});

test("side follows the list's direction, in DOM order, read from where the neighbors sit", async () => {
  assert.deepEqual(await sidesOver([[0, 20, 0, 100], [20, 20, 0, 100]], 0, [[50, 5], [50, 15]]), ["before", "after"], "a column");
  assert.deepEqual(await sidesOver([[0, 20, 0, 100], [0, 20, 100, 100]], 0, [[10, 10], [90, 10]]), ["before", "after"], "a row");
  assert.deepEqual(await sidesOver([[0, 20, 100, 100], [0, 20, 0, 100]], 0, [[110, 10], [190, 10]]), ["after", "before"], "a row running right to left");
  assert.deepEqual(await sidesOver([[20, 20, 0, 100], [0, 20, 0, 100]], 0, [[50, 25], [50, 35]]), ["after", "before"], "a column running upward");
  // The second item ends the first row of a wrapping grid: the next one is on
  // the row below, but the previous one beside it says the list runs across.
  assert.deepEqual(await sidesOver([[0, 20, 0, 100], [0, 20, 100, 100], [20, 20, 0, 100]], 1, [[110, 10], [190, 10]]), ["before", "after"], "the end of a wrapped row");
});

test("a lone item goes by its list's flex direction and text direction", async () => {
  assert.deepEqual(await sidesOver([[0, 20, 0, 100]], 0, [[10, 10], [90, 10]], "display: flex"), ["before", "after"]);
  assert.deepEqual(await sidesOver([[0, 20, 0, 100]], 0, [[10, 10], [90, 10]], "display: flex; flex-direction: row-reverse"), ["after", "before"]);
  assert.deepEqual(await sidesOver([[0, 20, 0, 100]], 0, [[10, 10], [90, 10]], "display: flex; direction: rtl"), ["after", "before"]);
  assert.deepEqual(await sidesOver([[0, 20, 0, 100]], 0, [[50, 5], [50, 15]]), ["before", "after"], "a block list is a column");
});

test("an event without a pointer position gets the index alone", async () => {
  const ctx: Record<string, unknown> = { seen: [] };
  await list({ "row-ping": { target: "li", do: record } }, ctx);
  $("li:nth-child(3) span").dispatchEvent(new window.Event("row-ping", { bubbles: true }));
  await settle();
  assert.deepEqual(ctx.seen, [{ tag: "LI", index: 2, side: undefined }]);
});

test("without a match the handler's preventDefault is skipped too", async () => {
  await list({ dragover: { target: "li", preventDefault: true, do: [] } }, {});
  const onRow = new window.DragEvent("dragover", { bubbles: true, cancelable: true });
  const onList = new window.DragEvent("dragover", { bubbles: true, cancelable: true });
  $("li span").dispatchEvent(onRow);
  $("ul").dispatchEvent(onList);
  assert.equal(onRow.defaultPrevented, true);
  assert.equal(onList.defaultPrevented, false, "a drop is allowed only over a row");
});

test("a match must be inside the handler's element, not around it", async () => {
  const ctx: Record<string, unknown> = { seen: [] };
  document.body.innerHTML = '<ul><li id="outer"><div id="inner"></div></li></ul>';
  await resolve({ $setProp: ["#inner", "innerHTML", { $tag: "p", events: { click: { target: "li", do: record } }, content: ["x"] }] }, ctx);
  $("#inner p").click();
  await settle();
  assert.deepEqual(ctx.seen, [], "the li around the handler's element is not one of its targets");
});

test("a target that is not a CSS selector is logged and leaves that handler unbound", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const ctx: Record<string, unknown> = { seen: [] };
  await list({ click: { target: "li[", do: record }, dblclick: { do: record } }, ctx);
  $("li span").click();
  $("ul").dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
  await settle();
  assert.equal(logged.mock.callCount(), 1);
  assert.deepEqual((ctx.seen as { tag: string }[]).map(s => s.tag), ["UL"], "the element's other handlers still bind");
});
