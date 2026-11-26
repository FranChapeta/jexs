import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import { hydrate } from "../src/events.js";
import { registerDomLazy } from "../src/registerNodes.js";

// Just enough of a browser for the permission node and its bridged event:
// elements that hold attributes and dispatch events, a document that finds them
// by attribute, and a Permissions API whose statuses change by hand.

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
  /** `[name]`, or `[name~="word"]` for an attribute listing the word. */
  querySelectorAll(selector: string): FakeElement[] {
    const m = /^\[([\w-]+)(?:~="([\w-]+)")?\]$/.exec(selector);
    assert.ok(m, `unsupported selector ${selector}`);
    const [, name, word] = m;
    return connected.filter(el => el.hasAttribute(name) && (word === undefined || el.getAttribute(name)!.split(" ").includes(word)));
  },
};

class FakeStatus extends EventTarget {
  listeners = 0;
  constructor(public name: string, public state: string) { super(); }
  override addEventListener(...args: Parameters<EventTarget["addEventListener"]>): void {
    this.listeners++;
    super.addEventListener(...args);
  }
  /** The state changing, as a grant or a revocation in the site's settings does. */
  change(state: string): void {
    this.state = state;
    this.dispatchEvent(new Event("change"));
  }
}

/** Each name's state as the browser has it; a name left out is unknown to it. */
const states: Record<string, string> = { microphone: "prompt", camera: "denied", push: "granted" };
const queried: { name: string; userVisibleOnly?: boolean }[] = [];
const made: FakeStatus[] = [];
const permissions = {
  async query(descriptor: { name: string; userVisibleOnly?: boolean }): Promise<FakeStatus> {
    queried.push(descriptor);
    const state = states[descriptor.name];
    if (state === undefined) throw new TypeError(`'${descriptor.name}' is not a valid enum value of type PermissionName.`);
    const status = new FakeStatus(descriptor.name, state);
    made.push(status);
    return status;
  },
};

const g = globalThis as unknown as Record<string, unknown>;
g.document = fakeDocument;
Object.defineProperty(globalThis, "navigator", { value: { permissions }, configurable: true });

const settle = () => new Promise(r => setImmediate(r));

// The node loads on the first `$permission`, as on a page, after the page is
// hydrated: the handler below is bound for an event nothing bridges yet.
const context: Record<string, unknown> = {};
const resolver = createResolver(coreNodes(), { context });
registerDomLazy(resolver);
after(() => resolver.destroy());

const watcher = new FakeElement();
watcher.setAttribute("data-jexs-events", JSON.stringify([
  { type: "permissionchange", do: [{ $setVars: { changed: { $var: "value" } }, $bubble: true }] },
]));
connected = [watcher];
hydrate(fakeDocument as unknown as Document, context);

/** Resolve a step, a refusal thrown at once included, as a promise. */
async function read(expr: unknown): Promise<unknown> {
  return resolver(expr, context);
}

function statusOf(name: string): FakeStatus {
  const status = made.find(s => s.name === name);
  assert.ok(status, `no status was made for ${name}`);
  return status;
}

test("permissionchange reaches an element hydrated before the node loaded, with { name, state }", async () => {
  await read({ $permission: "microphone" });
  await settle();
  statusOf("microphone").change("granted");
  await settle();
  assert.deepEqual(context.changed, { name: "microphone", state: "granted" });
  statusOf("microphone").change("prompt");
});

test("a name gives the same status every time, its state live by path", async () => {
  const first = await read({ $permission: "camera" });
  const [again, together] = await Promise.all([read({ $permission: "camera" }), read({ $permission: "camera" })]);
  assert.equal(again, first);
  assert.equal(together, first);
  assert.equal(queried.filter(d => d.name === "camera").length, 1, "queried once");

  assert.equal(await read([{ $permission: "camera", $as: "cam" }, { $var: "cam.state" }]), "denied");
  statusOf("camera").change("granted");
  assert.equal(await read([{ $permission: "camera", $as: "cam" }, { $var: "cam.state" }]), "granted");
});

test("push is queried with userVisibleOnly, as Chrome needs and $pushSubscribe subscribes", async () => {
  await read({ $permission: "push" });
  assert.deepEqual(queried.find(d => d.name === "push"), { name: "push", userVisibleOnly: true });
});

test("a name the browser doesn't know throws, and is asked again next time", async () => {
  await assert.rejects(read({ $permission: "telepathy" }), /\$permission: this browser doesn't know the permission "telepathy": 'telepathy' is not a valid enum value/);
  await assert.rejects(read({ $permission: "telepathy" }), /doesn't know the permission/);
  assert.equal(queried.filter(d => d.name === "telepathy").length, 2);
  await assert.rejects(read({ $permission: 3 }), /\$permission takes a permission's name, such as "microphone", not 3/);
});

test("a browser without the Permissions API throws, saying so", async () => {
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
  try {
    await assert.rejects(read({ $permission: "geolocation" }), /this browser has no Permissions API/);
  } finally {
    Object.defineProperty(globalThis, "navigator", { value: { permissions }, configurable: true });
  }
});

test("each status gets one change listener, which dispose stops", async () => {
  states.notifications = "prompt";
  for (let i = 0; i < 3; i++) await read({ $permission: "notifications" });
  const status = statusOf("notifications");
  assert.equal(status.listeners, 1);

  const { PermissionNode } = await import("../src/nodes/Permission.js");
  const own = new PermissionNode();
  const other = createResolver([...coreNodes(), own], { context: {} });
  await other({ $permission: "notifications" }, {});
  const second = made.filter(s => s.name === "notifications")[1];
  assert.equal(second.listeners, 1);
  other.destroy();
  assert.equal(own.statuses.size, 0);

  context.changed = undefined;
  second.change("granted");
  await settle();
  assert.equal(context.changed, undefined, "a destroyed resolver's status reports nothing");
  status.change("granted");
  await settle();
  assert.deepEqual(context.changed, { name: "notifications", state: "granted" }, "another resolver's status still reports");
});
