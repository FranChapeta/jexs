import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import { hydrate } from "../src/events.js";

// Just enough DOM for hydrate: elements are EventTargets with attributes, and the
// document finds the connected ones by attribute.

class FakeElement extends EventTarget {
  attrs = new Map<string, string>();
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }
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
    { type: "sw-message", do: [{ $setVars: { [varName]: { $var: "value" } } }] },
  ]));
  return el;
}

const settle = () => new Promise(r => setImmediate(r));

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
