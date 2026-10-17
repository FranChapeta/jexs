import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import { installDom } from "./dom.js";
import { DomNode } from "../src/nodes/Dom.js";

const window = installDom();
const document = window.document;
const resolve = createResolver([...coreNodes(), new DomNode()]);
const run = (step: unknown, context: Record<string, unknown> = {}) => resolve(step, context);
const $ = (selector: string) => document.querySelector(selector) as unknown as HTMLElement;

beforeEach(() => {
  document.body.innerHTML = `
    <form id="f"><input id="name" value="Ada"><button id="go">Go</button></form>
    <div id="box" class="card"><span class="item">a</span><span class="item">b</span></div>
    <textarea id="note">hello world</textarea>`;
});

test("show, hide and toggle set inline display, by selector or element, and return the element", async () => {
  assert.equal(await run({ $hide: "#box" }), $("#box"));
  assert.equal($("#box").style.display, "none");
  await run({ $show: $("#box") });
  assert.equal($("#box").style.display, "");
  await run({ $toggle: "#box" });
  assert.equal($("#box").style.display, "none");
});

test("showAll and hideAll return how many elements matched", async () => {
  assert.equal(await run({ $hideAll: ".item" }), 2);
  assert.equal($(".item").style.display, "none");
  assert.equal(await run({ $showAll: ".item" }), 2);
  assert.equal(await run({ $hideAll: ".missing" }), 0);
});

test("class ops add, remove and toggle a class", async () => {
  assert.equal(await run({ $addClass: ["#box", "open"] }), $("#box"));
  assert.ok($("#box").classList.contains("open"));
  await run({ $removeClass: ["#box", "card"] });
  assert.ok(!$("#box").classList.contains("card"));
  await run({ $toggleClass: ["#box", "open"] });
  assert.ok(!$("#box").classList.contains("open"));
});

test("attributes and properties, dot-paths included", async () => {
  await run({ $setAttr: ["#box", "data-x", 5] });
  assert.equal(await run({ $getAttr: ["#box", "data-x"] }), "5");
  await run({ $setProp: ["#box", "style.color", "red"] });
  assert.equal(await run({ $getProp: ["#box", "style.color"] }), "red");
  assert.equal(await run({ $getProp: ["#box", "nope.deeper"] }), undefined);
});

test("values, text, html and disabled through the props", async () => {
  assert.equal(await run({ $getProp: ["#name", "value"] }), "Ada");
  await run({ $setProp: ["#name", "value", "Grace"] });
  assert.equal(($("#name") as HTMLInputElement).value, "Grace");
  await run({ $setProp: ["#name", "disabled", true] });
  assert.equal(($("#name") as HTMLInputElement).disabled, true);

  await run({ $setProp: ["#box", "textContent", "<b>plain</b>"] });
  assert.equal($("#box").textContent, "<b>plain</b>");
  await run({ $setProp: ["#box", "innerHTML", "<b>bold</b>"] });
  assert.equal($("#box").innerHTML, "<b>bold</b>");
  await run({ $append: ["#box", "<i>more</i>"] });
  assert.equal($("#box").innerHTML, "<b>bold</b><i>more</i>");
});

/** Markup holding a button that counts its clicks into `context.clicks`. */
const counter = (id: string) =>
  `<button id="${id}" data-jexs-events='${JSON.stringify([{ type: "click", do: [{ $setVars: { clicks: { $add: [{ $var: "clicks" }, 1] } }, $bubble: true }] }])}'>+</button>`;
const settle = () => new Promise(r => setTimeout(r, 10));

test("every op that writes markup wires up its events", async () => {
  const context: Record<string, unknown> = { clicks: 0 };
  await run({ $setProp: ["#box", "innerHTML", counter("a")] }, context);
  await run({ $append: ["#box", counter("b")] }, context);
  await run({ $insertHtml: ["#box", counter("c")], index: 0 }, context);
  await run({ $setProp: ["#c", "outerHTML", counter("d")] }, context);
  for (const id of ["a", "b", "d"]) $(`#${id}`).click();
  await settle();
  assert.equal(context.clicks, 3);
});

/** A dragstart carrying `data`, which happy-dom's DragEvent does not keep from its init. */
function dragStart(data: DataTransfer): Event {
  const e = new window.DragEvent("dragstart", { bubbles: true });
  Object.defineProperty(e, "dataTransfer", { value: data });
  return e as unknown as Event;
}

test("a dragstart handler gives a plain element's drag some data, and leaves data already there alone", async () => {
  const context: Record<string, unknown> = { started: 0 };
  const handler = JSON.stringify([{ type: "dragstart", do: [{ $setVars: { started: { $add: [{ $var: "started" }, 1] } }, $bubble: true }] }]);
  await run({ $setProp: ["#box", "innerHTML", `<div id="row" draggable="true" data-jexs-events='${handler}'>row</div>`] }, context);

  const plain = new window.DataTransfer() as unknown as DataTransfer;
  $("#row").dispatchEvent(dragStart(plain));
  assert.deepEqual(Array.from(plain.types), ["text/plain"]);

  const link = new window.DataTransfer() as unknown as DataTransfer;
  link.setData("text/uri-list", "https://example.com/");
  $("#row").dispatchEvent(dragStart(link));
  assert.deepEqual(Array.from(link.types), ["text/uri-list"]);
  await settle();
  assert.equal(context.started, 2, "the handler ran both times");
});

test("outerHTML replaces the element and returns the one now in its place", async () => {
  const old = $(".item");
  const replaced = await run({ $setProp: [old, "outerHTML", "<em class=\"item\">new</em>"] });
  assert.equal(replaced, document.querySelector("em"));
  assert.equal(old.isConnected, false);
  assert.equal($("#box").innerHTML, "<em class=\"item\">new</em><span class=\"item\">b</span>");
  assert.equal(await run({ $setProp: ["#note", "outerHTML", ""] }), null, "markup that makes no element returns null");
  assert.equal($("#note"), null);
});

const order = () => Array.from($("#box").children).map(c => c.textContent).join("");

test("insertHtml puts markup at a child index or a position, and returns the first new element", async () => {
  document.body.innerHTML = '<ul id="box"><li>a</li><li>b</li></ul>';
  const made = await run({ $insertHtml: ["#box", "<li>x</li>"], index: 1 });
  assert.equal((made as HTMLElement).textContent, "x");
  assert.equal(order(), "axb");
  await run({ $insertHtml: ["#box", "<li>0</li>"], index: 0 });
  await run({ $insertHtml: ["#box", "<li>z</li>"], index: 4 });
  await run({ $insertHtml: ["#box", "<li>!</li>"], index: 99 });
  assert.equal(order(), "0axbz!", "the length or past it appends");
  await run({ $insertHtml: ["#box", "<li>p</li>"], position: "prepend" });
  await run({ $insertHtml: ["#box", "<li>e</li>"] });
  assert.equal(order(), "p0axbz!e", "append is the default");
  await run({ $insertHtml: [$("#box").children[1], "<li>&lt;</li>"], position: "before" });
  await run({ $insertHtml: [$("#box").children[1], "<li>&gt;</li>"], position: "after" });
  assert.equal(order(), "p<>0axbz!e");
});

test("moveElement moves the element itself, to the index $move would put the item at", async () => {
  document.body.innerHTML = '<ul id="box"><li>a</li><li>b</li><li>c</li><li><input value="typed">d</li></ul>';
  const items = ["a", "b", "c", "d"];
  const resolveWith = (step: unknown) => run(step, { items });
  const d = $("#box").children[3];

  await resolveWith({ $move: [{ $var: "items" }, 3, 0] });
  assert.equal(await resolveWith({ $moveElement: [d, "#box"], index: 0 }), d);
  assert.equal(order(), items.join(""));
  assert.equal((d.querySelector("input") as HTMLInputElement).value, "typed", "the same element, so its input keeps its value");

  const b = $("#box").children[2];
  await resolveWith({ $move: [{ $var: "items" }, 2, 3] });
  await resolveWith({ $moveElement: [b, "#box"], index: 3 });
  assert.equal(order(), items.join(""), "moving later in the same parent lands at the index, not one short");

  await run({ $moveElement: [$("#box").children[0], $("#box").children[2]], position: "after" });
  assert.equal(order(), "acdb");
  await assert.rejects(async () => run({ $moveElement: ["#box", d] }), /\$moveElement: an element can't be moved into itself/);
});

test("index and position are alternatives, and position is one of four", async () => {
  await assert.rejects(async () => run({ $insertHtml: ["#box", "<i></i>"], index: 0, position: "append" }), /\$insertHtml takes `index` or `position`, not both/);
  await assert.rejects(async () => run({ $insertHtml: ["#box", "<i></i>"], position: "inside" }), /\$insertHtml: `position` "inside" is not one of before, after, prepend, append/);
  await assert.rejects(async () => run({ $moveElement: [".item", "#box"], index: "first" }), /\$moveElement: `index` "first" is not a number/);
});

test("a query searches inside `in`, and an `in` that matches nothing finds nothing", async () => {
  assert.equal(await run({ $querySelector: ".item", in: "#box" }), $(".item"));
  assert.equal(await run({ $querySelector: "input", in: "#box" }), null);
  assert.equal((await run({ $querySelectorAll: ":scope > span", in: $("#box") }) as unknown[]).length, 2);
  assert.equal(await run({ $querySelector: ".item", in: "#missing" }), null);
  assert.deepEqual(await run({ $querySelectorAll: ".item", in: "#missing" }), []);
  assert.equal(await run({ $querySelector: ".item", in: { $var: "nothing" } }), null, "an `in` that resolves to null is not the whole page");
});

test("setRangeText replaces a range of a textarea", async () => {
  await run({ $setRangeText: ["#note", "there", 6, 11, "end"] });
  assert.equal(($("#note") as HTMLTextAreaElement).value, "hello there");
});

test("finding elements", async () => {
  assert.equal(await run({ $querySelector: "#box" }), $("#box"));
  assert.equal((await run({ $querySelectorAll: ".item" }) as unknown[]).length, 2);
  assert.equal(await run({ $getElementById: "name" }), $("#name"));
  assert.equal(await run({ $closest: [$(".item"), "#box"] }), $("#box"));
  assert.equal(await run({ $removeElement: ".item" }), true);
  assert.equal(document.querySelectorAll(".item").length, 1);
});

test("focus moves the active element", async () => {
  await run({ $focus: "#name" });
  assert.equal(document.activeElement, $("#name"));
});

test("preventDefault and stopPropagation act on the event in context", async (t) => {
  const event = new window.Event("click", { cancelable: true });
  const stop = t.mock.method(event, "stopPropagation");
  await run({ $preventDefault: true }, { event });
  await run({ $stopPropagation: true }, { event });
  assert.equal(event.defaultPrevented, true);
  assert.equal(stop.mock.callCount(), 1);
});

test("submit \"form\" submits the event target's form", async (t) => {
  const form = $("#f") as HTMLFormElement;
  const submit = t.mock.method(form, "submit", () => {});
  await run({ $submit: "form" }, { target: $("#go") });
  assert.equal(submit.mock.callCount(), 1);
});

// Acting on nothing is an error that reaches $catch; reading from nothing answers
// null, as the lookups do; removing nothing is reported.
test("acting on a missing element, a short tuple, a missing method or clipboard is an error", async () => {
  await assert.rejects(async () => run({ $hide: "#missing" }), /\$hide: no element matches "#missing"/);
  await assert.rejects(async () => run({ $addClass: ["#box"] }), /\$addClass takes 2 operands, got 1/);
  for (const read of [{ $getAttr: ["#missing", "id"] }, { $getProp: ["#missing", "id"] },
    { $getBoundingClientRect: "#missing" }, { $closest: ["#missing", "div"] }, { $querySelector: "#missing" }]) {
    assert.equal(await run(read), null, JSON.stringify(read));
  }
  await assert.rejects(async () => run({ $insertHtml: ["#missing", "<i></i>"] }), /\$insertHtml: no element matches "#missing"/);
  await assert.rejects(async () => run({ $caretFromPoint: [1] }), /\$caretFromPoint takes 2 operands, got 1/);
  await assert.rejects(async () => run({ $showModal: "#box" }), /\$showModal: <div> has no showModal\(\)/);
  await assert.rejects(async () => run({ $setProp: ["#box", "nope.deeper", 1] }), /\$setProp: "nope" is not an object to set "deeper" on/);
  await assert.rejects(async () => run({ $preventDefault: true }), /\$preventDefault runs in an event handler/);
  await assert.rejects(async () => run({ $copy: "text" }), /\$copy: no clipboard here/);
  assert.equal(await run({ $removeElement: "#missing" }), false);
});
