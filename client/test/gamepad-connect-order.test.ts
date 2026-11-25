import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import { hydrate } from "../src/events.js";
import { registerBridges } from "../src/registerNodes.js";

// Its own file, so the gamepad bridge starts fresh: which of its events starts
// first is the whole point, and gamepad.test.ts has started them all already.

class FakeElement extends EventTarget {
  attrs = new Map<string, string>();
  isConnected = true;
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }
  closest(): null { return null; }
}

let connected: FakeElement[] = [];
const fakeDocument = {
  querySelectorAll(selector: string): FakeElement[] {
    const m = /^\[([\w-]+)\]$/.exec(selector);
    assert.ok(m, `unsupported selector ${selector}`);
    return connected.filter(el => el.hasAttribute(m[1]));
  },
};
const pads: unknown[] = [];
const g = globalThis as unknown as Record<string, unknown>;
g.document = fakeDocument;
g.window = new EventTarget();
g.requestAnimationFrame = () => 0;
Object.defineProperty(globalThis, "navigator", { value: { getGamepads: () => pads }, configurable: true });

registerBridges();

test("a pad the browser already shows is announced however the gamepad events start", async () => {
  const context: Record<string, unknown> = { joined: [] as unknown[] };
  createResolver(coreNodes(), { context });
  // Already exposed, as after a reload once a button was pressed on the page.
  pads[0] = { index: 0, id: "Pad 0", mapping: "standard", connected: true, axes: [0, 0], buttons: [{ pressed: false, touched: false, value: 0 }] };
  const el = new FakeElement();
  // A button's bridge starts before the connection's, as a browser can load them.
  el.setAttribute("data-jexs-events", JSON.stringify([
    { type: "gamepadbuttondown", do: [] },
    { type: "gamepadconnected", do: [{ $push: [{ $var: "joined" }, { $var: "value" }] }] },
  ]));
  connected = [el];
  hydrate(fakeDocument as unknown as Document, context);
  await import("../src/nodes/Gamepad.js");
  await new Promise(r => setImmediate(r));
  assert.deepEqual(context.joined, [{ gamepad: 0, id: "Pad 0", mapping: "standard" }], "announced once");
});
