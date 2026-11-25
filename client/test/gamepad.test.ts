import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import { hydrate } from "../src/events.js";
import { registerBridges } from "../src/registerNodes.js";
import { GamepadNode } from "../src/nodes/Gamepad.js";

// Just enough of a browser for the gamepad bridge and node: elements that hold
// attributes, dispatch events and can leave the page, a document that finds them
// by attribute, a window for the connection events, a frame queue run by hand,
// and pads.

class FakeElement extends EventTarget {
  static made: FakeElement[] = [];
  attrs = new Map<string, string>();
  isConnected = true;
  constructor() {
    super();
    FakeElement.made.push(this);
  }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }
  closest(): null { return null; }
}

/** Take every element made so far off the page, as a page moving on would. */
function leavePage(): void {
  for (const el of FakeElement.made) el.isConnected = false;
  connected = [];
}

/** Hydrate the connected elements, and wait for the gamepad bridge they start
 *  to load and announce the pads it finds. */
async function hydrateGamepads(context: Record<string, unknown>): Promise<void> {
  hydrate(fakeDocument as unknown as Document, context);
  await import("../src/nodes/Gamepad.js");
  await settle();
}

let connected: FakeElement[] = [];
const fakeDocument = {
  /** `[name]`, or `[name~="word"]` for an attribute listing the word. */
  querySelectorAll(selector: string): FakeElement[] {
    const m = /^\[([\w-]+)(?:~="([\w-]+)")?\]$/.exec(selector);
    assert.ok(m, `unsupported selector ${selector}`);
    const [, name, word] = m;
    return connected.filter(el => el.hasAttribute(name) && (word === undefined || el.getAttribute(name)!.split(" ").includes(word)));
  },
};

let frames: (() => void)[] = [];
/** Run the frame callbacks queued so far. */
function tick(): void {
  const due = frames;
  frames = [];
  for (const fn of due) fn();
}

interface FakePad {
  index: number;
  id: string;
  mapping: string;
  connected: boolean;
  axes: number[];
  buttons: { pressed: boolean; touched: boolean; value: number }[];
  vibrationActuator?: unknown;
}
const pads: (FakePad | null)[] = [];

function pad(index: number, options: Partial<FakePad> & { count?: number } = {}): FakePad {
  const made: FakePad = {
    index,
    id: `Pad ${index}`,
    mapping: "standard",
    connected: true,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: options.count ?? 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    ...options,
  };
  pads[index] = made;
  return made;
}

function press(p: FakePad, i: number, value = 1): void {
  p.buttons[i] = { pressed: value > 0, touched: value > 0, value };
}

const fakeWindow = new EventTarget();
const g = globalThis as unknown as Record<string, unknown>;
g.document = fakeDocument;
g.window = fakeWindow;
g.requestAnimationFrame = (fn: () => void) => frames.push(fn);
Object.defineProperty(globalThis, "navigator", { value: { getGamepads: () => pads }, configurable: true });

/** Send a connection event the way the browser does, on `window`. */
function announce(type: "gamepadconnected" | "gamepaddisconnected", p: FakePad): void {
  fakeWindow.dispatchEvent(Object.assign(new Event(type), { gamepad: p }));
}

const settle = () => new Promise(r => setImmediate(r));

registerBridges();

const resolver = createResolver([...coreNodes(), new GamepadNode()]);
after(() => resolver.destroy());

/** Resolve a step, a refusal thrown at once included, as a promise. */
async function read(expr: unknown): Promise<unknown> {
  return resolver(expr, {});
}

test("$gamepad gives the browser's pad as it is, read by index", async () => {
  const p = pad(0, { axes: [0.5, 0, 0, -1] });
  press(p, 7, 0.4);
  assert.equal(await read({ $gamepad: 0 }), p);
  assert.equal(await read([{ $gamepad: 0, $as: "pad" }, { $var: "pad.buttons.7.value" }]), 0.4);
  assert.equal(await read([{ $gamepad: 0, $as: "pad" }, { $var: "pad.axes.3" }]), -1);
  pads.length = 0;
});

test("$gamepad reads undefined for an index with no pad, and refuses one that is not an index", async () => {
  assert.equal(await read({ $gamepad: 3 }), undefined);
  assert.equal(await read({ $gamepad: 3, changes: true }), undefined);
  await assert.rejects(read({ $gamepad: "first" }), /pad's index/);
});

test("changes gives everything first, then only what changed, as plain data", async () => {
  const p = pad(0, { count: 2, axes: [0, 0] });
  const first = await read({ $gamepad: 0, changes: true });
  assert.deepEqual(first, {
    buttons: { 0: { pressed: false, touched: false, value: 0 }, 1: { pressed: false, touched: false, value: 0 } },
    axes: { 0: 0, 1: 0 },
  });

  assert.deepEqual(await read({ $gamepad: 0, changes: true }), {}, "nothing changed");
  assert.equal(await read({ $if: { $gamepad: 0, changes: true }, then: "sent", else: "quiet" }), "quiet");

  press(p, 1, 0.5);
  p.axes = [0.25, 0];
  const changed = await read({ $gamepad: 0, changes: true });
  assert.deepEqual(changed, { buttons: { 1: { pressed: true, touched: true, value: 0.5 } }, axes: { 0: 0.25 } });
  assert.equal(JSON.parse(JSON.stringify(changed)).axes[0], 0.25, "plain data that serializes");

  // A plain read leaves what `changes` compares with alone.
  p.axes = [0.5, 0];
  await read({ $gamepad: 0 });
  assert.deepEqual(await read({ $gamepad: 0, changes: true }), { axes: { 0: 0.5 } });
  pads.length = 0;
});

test("a button a browser gives no touched reads as touched above 0, as the spec has it", async () => {
  const p = pad(0, { count: 2, axes: [] });
  await read({ $gamepad: 0, changes: true });
  // A light squeeze on a trigger, short of pressed, from a browser without `touched`.
  (p.buttons as unknown[])[1] = { pressed: false, value: 0.2 };
  assert.deepEqual(await read({ $gamepad: 0, changes: true }), { buttons: { 1: { pressed: false, touched: true, value: 0.2 } } });
  (p.buttons as unknown[])[1] = { pressed: false, value: 0 };
  assert.deepEqual(await read({ $gamepad: 0, changes: true }), { buttons: { 1: { pressed: false, touched: false, value: 0 } } });
  pads.length = 0;
});

test("throttle paces changes reads, building up what changed until the next report", async () => {
  let clock = 1000;
  mock.method(performance, "now", () => clock);
  try {
    const p = pad(0, { count: 1, axes: [0] });
    await read({ $gamepad: 0, changes: true, throttle: 50 });
    p.axes = [0.1];
    clock += 20;
    assert.deepEqual(await read({ $gamepad: 0, changes: true, throttle: 50 }), {}, "too soon");
    p.axes = [0.2];
    press(p, 0);
    clock += 10;
    assert.deepEqual(await read({ $gamepad: 0, changes: true, throttle: 50 }), {});
    clock += 20;
    assert.deepEqual(await read({ $gamepad: 0, changes: true, throttle: 50 }), {
      buttons: { 0: { pressed: true, touched: true, value: 1 } }, axes: { 0: 0.2 },
    }, "everything since the last report, merged");
    clock += 100;
    assert.deepEqual(await read({ $gamepad: 0, changes: true, throttle: 50 }), {}, "nothing changed");
    p.axes = [0.3];
    clock += 1;
    assert.deepEqual(await read({ $gamepad: 0, changes: true, throttle: 50 }), { axes: { 0: 0.3 } }, "a change after a quiet spell reports at once");
    await assert.rejects(read({ $gamepad: 0, throttle: 50 }), /needs `changes: true`/);
    pads.length = 0;
  } finally {
    mock.restoreAll();
  }
});

test("changes starts over when the pad goes, or another device takes its index", async () => {
  pad(0, { count: 1, axes: [] });
  await read({ $gamepad: 0, changes: true });
  pad(0, { count: 1, axes: [], id: "Other pad" });
  assert.deepEqual(await read({ $gamepad: 0, changes: true }), { buttons: { 0: { pressed: false, touched: false, value: 0 } } });
  pads.length = 0;
  assert.equal(await read({ $gamepad: 0, changes: true }), undefined);
  pad(0, { count: 1, axes: [] });
  assert.deepEqual(await read({ $gamepad: 0, changes: true }), { buttons: { 0: { pressed: false, touched: false, value: 0 } } });
  pads.length = 0;
});

test("$gamepadRumble starts a dual rumble and does not wait for it", async () => {
  const calls: unknown[][] = [];
  pad(0, { vibrationActuator: { effects: ["dual-rumble"], playEffect: (...args: unknown[]) => { calls.push(args); return new Promise(() => {}); } } });
  assert.equal(await read({ $gamepadRumble: 0, duration: 300, weak: 0.5 }), true);
  assert.deepEqual(calls, [["dual-rumble", { duration: 300, strongMagnitude: 1, weakMagnitude: 0.5 }]]);
  await assert.rejects(read({ $gamepadRumble: 0, strong: 2 }), /strong/);
  await assert.rejects(read({ $gamepadRumble: 0, duration: -1 }), /duration/);
  pads.length = 0;
});

test("$gamepadRumble reports false for a pad that cannot vibrate, or none", async () => {
  pad(0);
  pad(1, { vibrationActuator: { effects: ["trigger-rumble"], playEffect: () => Promise.resolve("complete") } });
  assert.equal(await read({ $gamepadRumble: 0 }), false);
  assert.equal(await read({ $gamepadRumble: 1 }), false);
  assert.equal(await read({ $gamepadRumble: 2 }), false);
  pads.length = 0;
});

// Runs before any button handler is bound: the bridge's state is the page's.
test("a page handling only connections never reads the pads each frame", async () => {
  const context: Record<string, unknown> = {};
  createResolver(coreNodes(), { context });
  const el = new FakeElement();
  el.setAttribute("data-jexs-events", JSON.stringify([
    { type: "gamepadconnected", do: [{ $setVars: { joined: { $var: "value.gamepad" } }, $bubble: true }] },
  ]));
  // A pad the page already saw is announced once the bridge exists.
  const p = pad(2);
  connected = [el];
  await hydrateGamepads(context);
  assert.equal(context.joined, 2);
  assert.equal(frames.length, 0);
  pads.length = 0;
  announce("gamepaddisconnected", p);
  leavePage();
});

test("button and connection events reach the elements handling them while a pad is connected", async () => {
  const context: Record<string, unknown> = { log: [] as unknown[] };
  createResolver(coreNodes(), { context });
  const record = (type: string) => ({ type, do: [{ $push: [{ $var: "log" }, { type, value: { $var: "value" } }] }] });
  const el = new FakeElement();
  el.setAttribute("data-jexs-events", JSON.stringify(
    ["gamepadconnected", "gamepaddisconnected", "gamepadbuttondown", "gamepadbuttonup"].map(record),
  ));

  connected = [el];
  await hydrateGamepads(context);
  const p = pad(0);
  announce("gamepadconnected", p);
  await settle();
  assert.deepEqual(context.log, [{ type: "gamepadconnected", value: { gamepad: 0, id: "Pad 0", mapping: "standard" } }]);
  // Announced again by the browser, it is still one pad.
  announce("gamepadconnected", p);
  assert.equal(frames.length, 1, "one poll a frame");

  press(p, 0);
  press(p, 6, 0.7);
  tick();
  await settle();
  press(p, 0, 0);
  tick();
  tick();
  await settle();
  assert.deepEqual((context.log as unknown[]).slice(1), [
    { type: "gamepadbuttondown", value: { gamepad: 0, button: 0, value: 1 } },
    { type: "gamepadbuttondown", value: { gamepad: 0, button: 6, value: 0.7 } },
    { type: "gamepadbuttonup", value: { gamepad: 0, button: 0, value: 0 } },
  ]);

  pads.length = 0;
  announce("gamepaddisconnected", p);
  tick();
  await settle();
  assert.deepEqual((context.log as unknown[]).at(-1), { type: "gamepaddisconnected", value: { gamepad: 0, id: "Pad 0", mapping: "standard" } });
  assert.equal(frames.length, 0, "polling stops with no pad connected");

  // A pad connecting starts it again; its buttons start released.
  const q = pad(1, { mapping: "" });
  press(q, 2);
  announce("gamepadconnected", q);
  tick();
  await settle();
  assert.deepEqual((context.log as unknown[]).at(-1), { type: "gamepadbuttondown", value: { gamepad: 1, button: 2, value: 1 } });
  pads.length = 0;
  announce("gamepaddisconnected", q);
  tick();
  leavePage();
});

test("an element gets only the gamepad events it handles", async () => {
  const context: Record<string, unknown> = { downs: 0, connects: 0 };
  createResolver(coreNodes(), { context });
  const presses = new FakeElement();
  presses.setAttribute("data-jexs-events", JSON.stringify([
    { type: "gamepadbuttondown", do: [{ $setVars: { downs: { $add: [{ $var: "downs" }, 1] } }, $bubble: true }] },
  ]));
  const joins = new FakeElement();
  joins.setAttribute("data-jexs-events", JSON.stringify([
    { type: "gamepadconnected", do: [{ $setVars: { connects: { $add: [{ $var: "connects" }, 1] } }, $bubble: true }] },
  ]));
  let wrong = 0;
  joins.addEventListener("gamepadbuttondown", () => wrong++);
  presses.addEventListener("gamepadconnected", () => wrong++);
  connected = [presses, joins];
  await hydrateGamepads(context);

  const p = pad(0);
  announce("gamepadconnected", p);
  press(p, 0);
  tick();
  await settle();
  assert.equal(context.connects, 1);
  assert.equal(context.downs, 1);
  assert.equal(wrong, 0, "neither got the other's event");

  pads.length = 0;
  announce("gamepaddisconnected", p);
  tick();
  leavePage();
});

test("reading stops once no element on the page handles a button, and starts again when one is hydrated", async () => {
  const context: Record<string, unknown> = { ups: 0, downs: 0 };
  createResolver(coreNodes(), { context });
  // The page moved on: the elements that handled buttons are gone.
  leavePage();
  const p = pad(0);
  announce("gamepadconnected", p);
  assert.equal(frames.length, 1, "buttons were handled before, so it reads");
  press(p, 0);
  tick();
  assert.equal(frames.length, 1, "a press nothing heard, but a release might still be");
  press(p, 0, 0);
  tick();
  assert.equal(frames.length, 0, "neither a press nor a release is heard, so it stops");

  const el = new FakeElement();
  el.setAttribute("data-jexs-events", JSON.stringify([
    { type: "gamepadbuttonup", do: [{ $setVars: { ups: { $add: [{ $var: "ups" }, 1] } }, $bubble: true }] },
  ]));
  connected = [el];
  await hydrateGamepads(context);
  assert.equal(frames.length, 1, "a button handler starts it again");
  press(p, 0);
  tick();
  assert.equal(frames.length, 1, "only releases are heard now, and the press reached none, but it keeps reading");
  press(p, 0, 0);
  tick();
  await settle();
  assert.equal(context.ups, 1, "the release arrives");

  pads.length = 0;
  announce("gamepaddisconnected", p);
  tick();
  leavePage();
});
