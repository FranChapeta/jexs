import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import { installDom } from "./dom.js";
import { DomNode } from "../src/nodes/DomNode.js";

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

test("enable and disable set disabled on a form control", async () => {
  await run({ $disable: "#name" });
  assert.equal(($("#name") as HTMLInputElement).disabled, true);
  await run({ $enable: "#name" });
  assert.equal(($("#name") as HTMLInputElement).disabled, false);
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

test("values, text and html", async () => {
  assert.equal(await run({ $getValue: "#name" }), "Ada");
  await run({ $setValue: ["#name", "Grace"] });
  assert.equal(($("#name") as HTMLInputElement).value, "Grace");
  assert.equal(await run({ $getValue: "#box" }), "", "an element without a value reads as empty");

  await run({ $setText: ["#box", "<b>plain</b>"] });
  assert.equal($("#box").textContent, "<b>plain</b>");
  await run({ $setHtml: ["#box", "<b>bold</b>"] });
  assert.equal($("#box").innerHTML, "<b>bold</b>");
  await run({ $append: ["#box", "<i>more</i>"] });
  assert.equal($("#box").innerHTML, "<b>bold</b><i>more</i>");
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
  assert.equal(await run({ $removeEl: ".item" }), null);
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

// What these return today when there is nothing to act on. Each is a candidate
// to throw instead (see the v2 plan), so these pin the behaviour that changes.
test("a missing element or a short tuple returns null, and a missing clipboard is quiet", async () => {
  assert.equal(await run({ $hide: "#missing" }), null);
  assert.equal(await run({ $addClass: ["#box"] }), null);
  assert.equal(await run({ $getAttr: ["#missing", "id"] }), null);
  assert.equal(await run({ $setValue: "#name" }), null);
  assert.equal(await run({ $getValue: "#missing" }), null);
  assert.equal(await run({ $caretFromPoint: [1] }), null);
  assert.equal(await run({ $copy: "text" }), null);
  assert.equal(await run({ $getClipboard: true }), "");
});
