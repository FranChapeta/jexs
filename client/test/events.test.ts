import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import { hydrate } from "../src/events.js";

// Just enough DOM for hydrate: elements are EventTargets with attributes, and the
// document finds the connected ones by attribute.

class FakeElement extends EventTarget {
  attrs = new Map<string, string>();
  value?: string;
  parent?: FakeElement;
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }
  closest(selector: string): FakeElement | null {
    const name = /^\[([\w-]+)\]$/.exec(selector)![1];
    return this.hasAttribute(name) ? this : this.parent?.closest(selector) ?? null;
  }
}

let connected: FakeElement[] = [];
const fakeDocument = {
  querySelectorAll(selector: string): FakeElement[] {
    const m = /^\[([\w-]+)\]$/.exec(selector);
    assert.ok(m, `unsupported selector ${selector}`);
    return connected.filter(el => el.hasAttribute(m[1]));
  },
};

class FakeContainer extends EventTarget {
  listeners = 0;
  override addEventListener(...args: Parameters<EventTarget["addEventListener"]>): void {
    this.listeners++;
    super.addEventListener(...args);
  }
}
const container = new FakeContainer();

const g = globalThis as unknown as Record<string, unknown>;
g.document = fakeDocument;
Object.defineProperty(globalThis, "navigator", { value: { serviceWorker: container }, configurable: true });

function element(varName: string): FakeElement {
  const el = new FakeElement();
  el.setAttribute("data-jexs-events", JSON.stringify([
    { type: "sw-message", do: [{ $setVars: { [varName]: { $var: "value" } }, $bubble: true }] },
  ]));
  return el;
}

/** An element whose `type` handler runs `steps`. */
function handling(type: string, steps: unknown[]): FakeElement {
  const el = new FakeElement();
  el.setAttribute("data-jexs-events", JSON.stringify([{ type, do: steps }]));
  return el;
}

const settle = () => new Promise(r => setImmediate(r));

test("a handler runs in a scope of its own, and only a $bubble write reaches the page", async () => {
  const context: Record<string, unknown> = { count: 1 };
  createResolver(coreNodes(), { context });
  const el = handling("click", [
    { $setVars: { local: true } },
    { $setVars: { count: { $add: [{ $var: "count" }, 1] } }, $bubble: true },
  ]);
  connected = [el];
  hydrate(fakeDocument as unknown as Document, context);

  el.dispatchEvent(new Event("click"));
  el.dispatchEvent(new Event("click"));
  await settle();
  assert.equal(context.count, 3, "each firing reads the page state the last one wrote");
  assert.equal(context.local, undefined);
  for (const name of ["event", "target", "value"]) assert.equal(name in context, false, `${name} stays in the handler's scope`);
});

test("a firing sees its own value, never one an earlier event left behind", async () => {
  const context: Record<string, unknown> = { seen: [] as unknown[] };
  createResolver(coreNodes(), { context });
  const input = handling("input", [{ $push: [{ $var: "seen" }, { $var: "value" }] }]);
  input.value = "typed";
  const div = handling("click", [{ $push: [{ $var: "seen" }, { $var: "value" }] }]);
  connected = [input, div];
  hydrate(fakeDocument as unknown as Document, context);

  input.dispatchEvent(new Event("input"));
  div.dispatchEvent(new Event("click"));
  await settle();
  assert.deepEqual(context.seen, ["typed", null]);
});

test("a handler reads the params of the element around it, and `mount` runs in a scope too", async () => {
  const context: Record<string, unknown> = {};
  createResolver(coreNodes(), { context });
  const row = new FakeElement();
  row.setAttribute("data-jexs-params",JSON.stringify({ path: "0.children.1", type: "div", depth: 1 }));
  const button = handling("mount", [{ $setVars: { picked: { $var: "path" } }, $bubble: true }]);
  button.parent = row;
  connected = [button];
  hydrate(fakeDocument as unknown as Document, context);
  // `mount` runs during hydrate, and what it bubbles is there when hydrate returns.
  assert.equal(context.picked, "0.children.1");
  assert.equal("path" in context, false);
});

// The handler list is markup, so anything can be in it: a malformed one is logged
// and skipped, and the element's well-formed handlers still bind.
test("a handler list that is not a list, or an entry without steps, is logged and skipped", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const context: Record<string, unknown> = {};
  createResolver(coreNodes(), { context });
  const notList = new FakeElement();
  notList.setAttribute("data-jexs-events", JSON.stringify({ type: "click", do: [] }));
  const mixed = new FakeElement();
  mixed.setAttribute("data-jexs-events", JSON.stringify([{ type: "click" }, { type: "click", do: [{ $setVars: { ran: true }, $bubble: true }] }]));
  connected = [notList, mixed];
  hydrate(fakeDocument as unknown as Document, context);
  mixed.dispatchEvent(new Event("click"));
  await settle();
  assert.equal(context.ran, true);
  assert.equal(logged.mock.callCount(), 2);
});

// An image, a frame or a script fires a `load` of its own, which a handler waits for.
test("a `load` handler waits for the element's own load event", async () => {
  const context: Record<string, unknown> = {};
  createResolver(coreNodes(), { context });
  const img = handling("load", [{ $setVars: { loaded: true }, $bubble: true }]);
  connected = [img];
  hydrate(fakeDocument as unknown as Document, context);
  await settle();
  assert.equal(context.loaded, undefined, "hydrating is not the image loading");
  img.dispatchEvent(new Event("load"));
  await settle();
  assert.equal(context.loaded, true);
});

// A row that moved has its scope rewritten in place; its handlers, bound when
// it was first rendered, must hand over the new path rather than the old one.
test("a handler reads the scope around it when it fires, so a rewritten scope reaches it", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const context: Record<string, unknown> = { seen: [] as unknown[] };
  createResolver(coreNodes(), { context });
  const row = new FakeElement();
  row.setAttribute("data-jexs-params",JSON.stringify({ path: "2" }));
  const button = handling("click", [{ $push: [{ $var: "seen" }, { $var: "path" }] }]);
  button.parent = row;
  connected = [button];
  hydrate(fakeDocument as unknown as Document, context);

  button.dispatchEvent(new Event("click"));
  row.setAttribute("data-jexs-params",JSON.stringify({ path: "0" }));
  button.dispatchEvent(new Event("click"));
  row.setAttribute("data-jexs-params","{not json");
  button.dispatchEvent(new Event("click"));
  await settle();
  assert.deepEqual(context.seen, ["2", "0", undefined], "malformed params add no variables");
  assert.equal(logged.mock.callCount(), 1, "and is logged");
});

// A drag or pointer handler fires every frame; the params around it are parsed
// once per change, not once per firing.
test("a handler firing many times parses its params only when they change", async (t) => {
  const context: Record<string, unknown> = { seen: [] as unknown[] };
  createResolver(coreNodes(), { context });
  const row = new FakeElement();
  row.setAttribute("data-jexs-params",JSON.stringify({ path: "1" }));
  const handle = handling("dragover", [{ $push: [{ $var: "seen" }, { $var: "path" }] }]);
  handle.parent = row;
  connected = [handle];
  hydrate(fakeDocument as unknown as Document, context);

  const parse = t.mock.method(JSON, "parse");
  for (let i = 0; i < 50; i++) handle.dispatchEvent(new Event("dragover"));
  row.setAttribute("data-jexs-params",JSON.stringify({ path: "2" }));
  for (let i = 0; i < 50; i++) handle.dispatchEvent(new Event("dragover"));
  await settle();
  const scopeParses = parse.mock.calls.filter(c => String(c.arguments[0]).includes("path")).length;
  assert.equal(scopeParses, 2);
  const seen = context.seen as string[];
  assert.equal(seen.length, 100);
  assert.deepEqual([seen[0], seen[49], seen[50], seen[99]], ["1", "1", "2", "2"]);
});

test("hydrating an element binds its own handlers too, not only those inside it", async () => {
  const context: Record<string, unknown> = { clicks: 0 };
  createResolver(coreNodes(), { context });
  const row = handling("click", [{ $setVars: { clicks: { $add: [{ $var: "clicks" }, 1] } }, $bubble: true }]);
  Object.assign(row, { querySelectorAll: () => [] });
  hydrate(row as unknown as Element, context);
  row.dispatchEvent(new Event("click"));
  await settle();
  assert.equal(context.clicks, 1);
});

test("sw-message reaches connected elements through one container listener", async () => {
  const context: Record<string, unknown> = {};
  createResolver(coreNodes(), { context });

  const a = element("a");
  const b = element("b");
  connected = [a, b];
  hydrate(fakeDocument as unknown as Document, context);

  container.dispatchEvent(new MessageEvent("message", { data: { type: "updated" } }));
  await settle();
  assert.deepEqual(context.a, { type: "updated" });
  assert.deepEqual(context.b, { type: "updated" });

  // A removed element keeps no listener alive and hears nothing more.
  connected = [a];
  container.dispatchEvent(new MessageEvent("message", { data: "second" }));
  await settle();
  assert.equal(context.a, "second");
  assert.deepEqual(context.b, { type: "updated" });

  const c = element("c");
  connected = [a, c];
  hydrate(fakeDocument as unknown as Document, context);
  container.dispatchEvent(new MessageEvent("message", { data: "third" }));
  await settle();
  assert.equal(context.c, "third");
  assert.equal(container.listeners, 1);
});
