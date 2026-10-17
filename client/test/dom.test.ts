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
  assert.equal(await run({ $removeEl: ".item" }), true);
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
  for (const read of [{ $getAttr: ["#missing", "id"] }, { $getProp: ["#missing", "id"] }, { $getValue: "#missing" },
    { $getBoundingClientRect: "#missing" }, { $closest: ["#missing", "div"] }, { $querySelector: "#missing" }]) {
    assert.equal(await run(read), null, JSON.stringify(read));
  }
  await assert.rejects(async () => run({ $setValue: ["#box", "x"] }), /\$setValue: "#box" has no value/);
  await assert.rejects(async () => run({ $caretFromPoint: [1] }), /\$caretFromPoint takes 2 operands, got 1/);
  await assert.rejects(async () => run({ $showModal: "#box" }), /\$showModal: <div> has no showModal\(\)/);
  await assert.rejects(async () => run({ $setProp: ["#box", "nope.deeper", 1] }), /\$setProp: "nope" is not an object to set "deeper" on/);
  await assert.rejects(async () => run({ $preventDefault: true }), /\$preventDefault runs in an event handler/);
  await assert.rejects(async () => run({ $copy: "text" }), /\$copy: no clipboard here/);
  assert.equal(await run({ $removeEl: "#missing" }), false);
});
