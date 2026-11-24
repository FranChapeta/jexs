import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import { hydrate, bridgeEvent, type BridgeSend, type BridgeStart } from "../src/events.js";
import { registerBridges } from "../src/registerNodes.js";

// Just enough DOM for hydrate: elements are EventTargets with attributes, and the
// document finds the connected ones by attribute.

class FakeElement extends EventTarget {
  attrs = new Map<string, string>();
  value?: string;
  parent?: FakeElement;
  isConnected = true;
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
  /** `[name]`, or `[name~="word"]` for an attribute listing the word. */
  querySelectorAll(selector: string): FakeElement[] {
    const m = /^\[([\w-]+)(?:~="([\w-]+)")?\]$/.exec(selector);
    assert.ok(m, `unsupported selector ${selector}`);
    const [, name, word] = m;
    return connected.filter(el => el.hasAttribute(name) && (word === undefined || el.getAttribute(name)!.split(" ").includes(word)));
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

  registerBridges();
  const a = element("a");
  const b = element("b");
  connected = [a, b];
  hydrate(fakeDocument as unknown as Document, context);
  await settle();

  container.dispatchEvent(new MessageEvent("message", { data: { type: "updated" } }));
  await settle();
  assert.deepEqual(context.a, { type: "updated" });
  assert.deepEqual(context.b, { type: "updated" });

  // A removed element keeps no listener alive and hears nothing more.
  b.isConnected = false;
  container.dispatchEvent(new MessageEvent("message", { data: "second" }));
  await settle();
  assert.equal(context.a, "second");
  assert.deepEqual(context.b, { type: "updated" });

  // Put back and hydrated, as the client's insertions are, it hears them again.
  b.isConnected = true;
  const c = element("c");
  connected = [a, b, c];
  hydrate(fakeDocument as unknown as Document, context);
  container.dispatchEvent(new MessageEvent("message", { data: "third" }));
  await settle();
  assert.equal(context.b, "third");
  assert.equal(context.c, "third");
  assert.equal(container.listeners, 1);
  connected = [];
});

test("a package's bridged event reaches the elements handling it, its detail as value", async () => {
  const context: Record<string, unknown> = {};
  createResolver(coreNodes(), { context });
  const started: string[] = [];
  let send: BridgeSend | undefined;
  const start: BridgeStart = (s, type) => { send = s; started.push(type); };
  bridgeEvent("screenorientation", start);
  bridgeEvent("screenorientation", start);

  const turned = handling("screenorientation", [
    { $setVars: { turned: { $var: "value" } }, $bubble: true },
    { $setVars: { turns: { $add: [{ $var: "turns" }, 1] } }, $bubble: true },
  ]);
  // A second handler for it on the same element: one send runs both, once.
  turned.setAttribute("data-jexs-events", JSON.stringify([
    ...JSON.parse(turned.getAttribute("data-jexs-events")!),
    { type: "screenorientation", do: [{ $setVars: { again: { $add: [{ $var: "again" }, 1] } }, $bubble: true }] },
  ]));
  const bad = handling("screenorientation", []);
  bad.setAttribute("data-jexs-events", JSON.stringify([{ type: "screenorientation", target: "[", do: [] }]));
  const errors = mock.method(console, "error", () => {});
  connected = [turned, bad];
  context.turns = 0;
  context.again = 0;
  hydrate(fakeDocument as unknown as Document, context);
  mock.restoreAll();
  assert.deepEqual(started, [], "not until the hydrate is done");
  await settle();

  assert.deepEqual(started, ["screenorientation"], "started once, by the element bound");
  assert.equal(errors.mock.callCount(), 1);

  assert.equal(send!({ type: "landscape-primary" }), 1, "reached the one element handling it");
  await settle();
  assert.deepEqual(context.turned, { type: "landscape-primary" });
  assert.equal(context.turns, 1);
  assert.equal(context.again, 1);

  turned.isConnected = false;
  assert.equal(send!({ type: "portrait-primary" }), 0, "none on the page");

  // None left, so the next element to handle it starts the source again.
  const another = handling("screenorientation", []);
  connected = [another];
  hydrate(fakeDocument as unknown as Document, context);
  await settle();
  assert.deepEqual(started, ["screenorientation", "screenorientation"]);
  const more = handling("screenorientation", []);
  connected = [more];
  hydrate(fakeDocument as unknown as Document, context);
  await settle();
  assert.equal(started.length, 2, "one joining another that receives it starts nothing");
  connected = [];
});

test("bridging a type another way, or mount, is an error", () => {
  bridgeEvent("devicelight");
  assert.throws(() => bridgeEvent("devicelight", () => {}), /"devicelight" is a bridged event already, started another way/);
  assert.throws(() => bridgeEvent("mount"), /cannot be bridged/);
});

test("a type bridged after the page hydrated reaches the elements already handling it", async () => {
  const context: Record<string, unknown> = {};
  createResolver(coreNodes(), { context });
  const early = handling("lateevent", [{ $setVars: { late: { $var: "value" } }, $bubble: true }]);
  const other = handling("click", []);
  connected = [early, other];
  hydrate(fakeDocument as unknown as Document, context);

  const started: string[] = [];
  let send: BridgeSend | undefined;
  bridgeEvent("lateevent", (s, type) => { send = s; started.push(type); });
  await settle();
  assert.deepEqual(started, ["lateevent"], "started by the element already handling it");

  assert.equal(send!({ level: 2 }), 1);
  await settle();
  assert.deepEqual(context.late, { level: 2 }, "its handler, bound before, reads the detail as value");
  connected = [];
});

/** A page context for the bridge tests below, whose handlers' steps do nothing but must run. */
const page: Record<string, unknown> = {};
createResolver(coreNodes(), { context: page });

test("a target selector on a bridged event's handler is an error, bridged before or after", () => {
  const started: string[] = [];
  let send: BridgeSend | undefined;
  bridgeEvent("remotebuzz", (s, type) => { send = s; started.push(type); });
  const errors = mock.method(console, "error", () => {});
  try {
    const delegated = new FakeElement();
    delegated.setAttribute("data-jexs-events", JSON.stringify([{ type: "remotebuzz", target: "li", do: [] }]));
    Object.assign(delegated, { matches: () => false });
    connected = [delegated];
    hydrate(fakeDocument as unknown as Document, page);
    assert.equal(errors.mock.callCount(), 1);
    assert.match(String(errors.mock.calls[0].arguments[0]), /"remotebuzz" is a bridged event, .* takes no target selector/);
    assert.deepEqual(started, []);

    const late = new FakeElement();
    late.setAttribute("data-jexs-events", JSON.stringify([{ type: "laterbuzz", target: "li", do: [] }]));
    Object.assign(late, { matches: () => false });
    connected = [late];
    hydrate(fakeDocument as unknown as Document, page);
    let lateSend: BridgeSend | undefined;
    bridgeEvent("laterbuzz", (s, type) => { lateSend = s; started.push(type); });
    assert.equal(errors.mock.callCount(), 2);
    assert.match(String(errors.mock.calls[1].arguments[0]), /"laterbuzz" is a bridged event/);
    assert.deepEqual(started, [], "neither started, so nothing was given a send");
    assert.equal(send, undefined);
    assert.equal(lateSend, undefined);
  } finally {
    mock.restoreAll();
    connected = [];
  }
});

test("an element hydrated while a send is under way waits for the next one", async () => {
  let send: BridgeSend | undefined;
  bridgeEvent("chainreply", (s) => { send = s; });
  const first = handling("chainreply", []);
  connected = [first];
  hydrate(fakeDocument as unknown as Document, page);
  await settle();
  // Each one reached adds another handling it, as a handler rendering a row would.
  const hydrateAnother = () => {
    const next = handling("chainreply", []);
    next.addEventListener("chainreply", hydrateAnother);
    connected = [next];
    hydrate(fakeDocument as unknown as Document, page);
  };
  first.addEventListener("chainreply", hydrateAnother);
  assert.equal(send!(null), 1, "the one there when it began, not the one it added");
  assert.equal(send!(null), 2);
  connected = [];
});

test("a send of the event from one of its own handlers reaches each element there once", async () => {
  let send: BridgeSend | undefined;
  bridgeEvent("echoed", (s) => { send = s; });
  const [a, gone, c] = [handling("echoed", []), handling("echoed", []), handling("echoed", [])];
  connected = [a, gone, c];
  hydrate(fakeDocument as unknown as Document, page);
  await settle();
  gone.isConnected = false;
  const heard: string[] = [];
  let inner = -1;
  a.addEventListener("echoed", (e) => {
    heard.push(`a:${(e as CustomEvent).detail}`);
    if ((e as CustomEvent).detail === "outer") inner = send!("inner");
  });
  c.addEventListener("echoed", (e) => heard.push(`c:${(e as CustomEvent).detail}`));
  assert.equal(send!("outer"), 2);
  assert.equal(inner, 2);
  assert.deepEqual(heard, ["a:outer", "a:inner", "c:inner", "c:outer"]);
  assert.equal(send!("again"), 2, "the one off the page was dropped, once");
  connected = [];
});

test("an element put back on the page receives again once it is hydrated", async () => {
  let send: BridgeSend | undefined;
  bridgeEvent("comeback", (s) => { send = s; });
  const el = handling("comeback", []);
  connected = [el];
  hydrate(fakeDocument as unknown as Document, page);
  await settle();
  el.isConnected = false;
  assert.equal(send!(null), 0, "dropped off the page");
  el.isConnected = true;
  assert.equal(send!(null), 0, "not until it is hydrated again");
  hydrate(fakeDocument as unknown as Document, page);
  assert.equal(send!(null), 1);
  hydrate(fakeDocument as unknown as Document, page);
  assert.equal(send!(null), 1, "hydrated twice, still once");
  connected = [];
});

test("a start that sends at once reaches every element the hydrate that called for it bound", async () => {
  const heard: string[] = [];
  bridgeEvent("currentstate", (send) => { send("now"); });
  const [a, b] = [handling("currentstate", []), handling("currentstate", [])];
  a.addEventListener("currentstate", () => heard.push("a"));
  b.addEventListener("currentstate", () => heard.push("b"));
  connected = [a, b];
  hydrate(fakeDocument as unknown as Document, page);
  await settle();
  assert.deepEqual(heard, ["a", "b"]);
  connected = [];
});

test("a send that throws leaves the bridge sending, and dropping, as before", async () => {
  let send: BridgeSend | undefined;
  bridgeEvent("brittle", (s) => { send = s; });
  const breaks = handling("brittle", []);
  const leaves = handling("brittle", []);
  connected = [breaks, leaves];
  hydrate(fakeDocument as unknown as Document, page);
  await settle();
  Object.assign(breaks, { dispatchEvent: () => { throw new Error("broken element"); } });
  assert.throws(() => send!(null), /broken element/);
  Object.assign(breaks, { dispatchEvent: () => true });
  leaves.isConnected = false;
  assert.equal(send!(null), 1, "the next send is the outermost, so the one off the page is dropped");
  leaves.isConnected = true;
  assert.equal(send!(null), 1, "dropped, until it is hydrated again");
  connected = [];
});

test("a send passes over the elements collected since, and drops them", async () => {
  let send: BridgeSend | undefined;
  bridgeEvent("pilethem", (s) => { send = s; });
  // A WeakRef to an element gone reads nothing: so does one made here to stand for it.
  const real = globalThis.WeakRef;
  let gone = false;
  class FadingRef<T extends object> {
    constructor(private target: T) {}
    deref(): T | undefined { return gone ? undefined : this.target; }
  }
  (globalThis as unknown as { WeakRef: unknown }).WeakRef = FadingRef;
  try {
    for (let i = 0; i < 20; i++) {
      connected = [handling("pilethem", [])];
      hydrate(fakeDocument as unknown as Document, page);
    }
    await settle();
    assert.equal(send!(null), 20);
    gone = true;
    assert.equal(send!(null), 0, "a send passes over those collected and drops them");
  } finally {
    (globalThis as unknown as { WeakRef: unknown }).WeakRef = real;
    connected = [];
  }
});

test("hydrating an element twice binds its handlers once", async () => {
  const context: Record<string, unknown> = { clicks: 0 };
  createResolver(coreNodes(), { context });
  const el = handling("click", [{ $setVars: { clicks: { $add: [{ $var: "clicks" }, 1] } }, $bubble: true }]);
  connected = [el];
  hydrate(fakeDocument as unknown as Document, context);
  hydrate(fakeDocument as unknown as Document, context);
  el.dispatchEvent(new Event("click"));
  await settle();
  assert.equal(context.clicks, 1);
  connected = [];
});

// Pacing: a clock and timers moved by hand.

let clock = 0;
function useClock(): void {
  clock = 0;
  mock.method(performance, "now", () => clock);
  mock.timers.enable({ apis: ["setTimeout"] });
}
function advance(ms: number): void {
  clock += ms;
  mock.timers.tick(ms);
}
function stopClock(): void {
  mock.timers.reset();
  mock.restoreAll();
}

/** An element whose `type` handler, with `options`, logs each run's event detail and target. */
function paced(options: Record<string, unknown>): { el: FakeElement; context: Record<string, unknown>; fire: (detail: unknown) => Event } {
  const context: Record<string, unknown> = { log: [] as unknown[] };
  createResolver(coreNodes(), { context });
  const el = new FakeElement();
  el.setAttribute("data-jexs-events", JSON.stringify([{
    type: "drag", ...options,
    do: [{ $push: [{ $var: "log" }, { detail: { $var: "event.detail" }, target: { $var: "target" } }] }],
  }]));
  Object.assign(el, { querySelectorAll: () => [] });
  hydrate(el as unknown as Element, context);
  return {
    el, context,
    fire: (detail) => {
      const e = new CustomEvent("drag", { detail, cancelable: true });
      el.dispatchEvent(e);
      return e;
    },
  };
}
const details = (context: Record<string, unknown>) => (context.log as { detail: unknown }[]).map(r => r.detail);

test("throttle runs the first event at once and the last of those it held when the time is up", async () => {
  useClock();
  try {
    const { el, context, fire } = paced({ throttle: 100, preventDefault: true });
    fire(1);
    await settle();
    assert.deepEqual(details(context), [1]);

    advance(40);
    const held = [fire(2), fire(3)];
    await settle();
    assert.deepEqual(details(context), [1], "held within the time");
    assert.ok(held.every(e => e.defaultPrevented), "preventDefault acts on a held event too");

    advance(60);
    await settle();
    assert.deepEqual(details(context), [1, 3], "the last held one runs when the time is up");
    assert.equal((context.log as { target: unknown }[])[1].target, el, "with the element it fired on");

    advance(200);
    fire(4);
    await settle();
    assert.deepEqual(details(context), [1, 3, 4], "after a quiet spell an event runs at once again");
  } finally {
    stopClock();
  }
});

test("debounce runs once, after the events stop, with the last of them", async () => {
  useClock();
  try {
    const { context, fire } = paced({ debounce: 100 });
    fire(1);
    advance(50);
    fire(2);
    advance(80);
    fire(3);
    advance(99);
    await settle();
    assert.deepEqual(details(context), [], "each event pushes the run back");
    advance(1);
    await settle();
    assert.deepEqual(details(context), [3]);
  } finally {
    stopClock();
  }
});

test("a held run is skipped once its element has left the page", async () => {
  useClock();
  try {
    const { el, context, fire } = paced({ debounce: 100 });
    fire(1);
    el.isConnected = false;
    advance(100);
    await settle();
    assert.deepEqual(details(context), []);

    const trailing = paced({ throttle: 100 });
    trailing.fire(1);
    trailing.fire(2);
    trailing.el.isConnected = false;
    advance(100);
    await settle();
    assert.deepEqual(details(trailing.context), [1], "the run at once happened, the held one is skipped");
  } finally {
    stopClock();
  }
});

test("throttle frame runs once per animation frame, with its last event", async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const queued: (() => void)[] = [];
  g.requestAnimationFrame = (fn: () => void) => queued.push(fn);
  try {
    const { context, fire } = paced({ throttle: "frame" });
    fire(1);
    fire(2);
    fire(3);
    assert.equal(queued.length, 1, "one frame asked for");
    queued.shift()!();
    await settle();
    assert.deepEqual(details(context), [3]);
  } finally {
    delete g.requestAnimationFrame;
  }
});

test("a handler with a throttle or debounce it cannot pace by is skipped", () => {
  const errors = mock.method(console, "error", () => {});
  try {
    for (const options of [{ throttle: "fast" }, { debounce: -1 }, { throttle: 10, debounce: 10 }]) paced(options);
    assert.equal(errors.mock.callCount(), 3);
  } finally {
    mock.restoreAll();
  }
});
