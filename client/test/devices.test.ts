import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import { hydrate } from "../src/events.js";
import { registerBridges, registerDomLazy } from "../src/registerNodes.js";

// Just enough of a browser for the devices node and `devicechange`: elements
// that hold attributes and dispatch events, a document that finds them by
// attribute, and media devices whose list and permissions are set by hand.

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

/** A device as the browser gives it, its fields on the prototype as there. */
class FakeDeviceInfo {
  #fields: { kind: string; deviceId: string; groupId: string; label: string };
  constructor(fields: { kind: string; deviceId: string; groupId: string; label: string }) { this.#fields = fields; }
  get kind() { return this.#fields.kind; }
  get deviceId() { return this.#fields.deviceId; }
  get groupId() { return this.#fields.groupId; }
  get label() { return this.#fields.label; }
}

const HARDWARE = [
  { kind: "audioinput", deviceId: "mic1", groupId: "g1", label: "Headset Microphone" },
  { kind: "audioinput", deviceId: "mic2", groupId: "g2", label: "USB Microphone" },
  { kind: "audiooutput", deviceId: "out1", groupId: "g1", label: "Headset Earphones" },
  { kind: "videoinput", deviceId: "cam1", groupId: "g3", label: "Webcam" },
];

/** What the page may use, as the browser would have it; the rest list as placeholders. */
const allowed = { audio: false, video: false };
/** What the next prompt answers: an error's name to refuse with, or nothing to allow. */
let refuseWith: string | undefined;
const asked: MediaStreamConstraints[] = [];
let stopped = 0;
let hardware = HARDWARE;

function isAllowed(kind: string): boolean {
  return kind === "videoinput" ? allowed.video : allowed.audio;
}

class FakeMediaDevices extends EventTarget {
  listeners = 0;
  override addEventListener(...args: Parameters<EventTarget["addEventListener"]>): void {
    this.listeners++;
    super.addEventListener(...args);
  }
  /** Make the next listing come back after the one after it. */
  slowNext = false;
  async enumerateDevices(): Promise<FakeDeviceInfo[]> {
    const slow = this.slowNext;
    this.slowNext = false;
    const out: FakeDeviceInfo[] = [];
    const placed = new Set<string>();
    for (const d of hardware) {
      if (isAllowed(d.kind)) out.push(new FakeDeviceInfo(d));
      else if (!placed.has(d.kind)) {
        // One placeholder per kind; Chrome hides outputs with the mic.
        placed.add(d.kind);
        out.push(new FakeDeviceInfo({ kind: d.kind, deviceId: "", groupId: "", label: "" }));
      }
    }
    if (slow) await settle();
    return out;
  }
  async getUserMedia(constraints: MediaStreamConstraints): Promise<unknown> {
    asked.push(constraints);
    if (refuseWith) {
      const err = new Error("Permission denied");
      err.name = refuseWith;
      throw err;
    }
    if (constraints.audio) allowed.audio = true;
    if (constraints.video) allowed.video = true;
    const tracks = [constraints.audio, constraints.video].filter(Boolean).map(() => ({ stop: () => { stopped++; } }));
    return { getTracks: () => tracks };
  }
}

const mediaDevices = new FakeMediaDevices();
const g = globalThis as unknown as Record<string, unknown>;
g.document = fakeDocument;
Object.defineProperty(globalThis, "navigator", { value: { mediaDevices, userAgent: "Mozilla/5.0 Chrome/131.0" }, configurable: true });

const settle = () => new Promise(r => setImmediate(r));

const context: Record<string, unknown> = {};
const resolver = createResolver(coreNodes(), { context });
registerDomLazy(resolver);
registerBridges();
after(() => resolver.destroy());

/** Resolve a step, a refusal thrown at once included, as a promise. */
async function read(expr: unknown): Promise<unknown> {
  return resolver(expr, context);
}

function reset(): void {
  allowed.audio = false;
  allowed.video = false;
  refuseWith = undefined;
  asked.length = 0;
  stopped = 0;
  hardware = HARDWARE;
}

test("devicechange listens at nothing until an element handles it, then sends the list as value, without asking", async () => {
  reset();
  hydrate(fakeDocument as unknown as Document, context);
  await settle();
  assert.equal(mediaDevices.listeners, 0, "no element handles it yet");

  const watcher = new FakeElement();
  watcher.setAttribute("data-jexs-events", JSON.stringify([
    { type: "devicechange", do: [{ $setVars: { changed: { $var: "value" } }, $bubble: true }] },
  ]));
  connected = [watcher];
  hydrate(fakeDocument as unknown as Document, context);
  await settle();
  await import("../src/nodes/Devices.js");
  await settle();
  assert.equal(mediaDevices.listeners, 1);

  allowed.audio = true;
  mediaDevices.dispatchEvent(new Event("devicechange"));
  await settle();
  assert.deepEqual(context.changed, [
    { kind: "audioinput", deviceId: "mic1", groupId: "g1", label: "Headset Microphone" },
    { kind: "audioinput", deviceId: "mic2", groupId: "g2", label: "USB Microphone" },
    { kind: "audiooutput", deviceId: "out1", groupId: "g1", label: "Headset Earphones" },
    { kind: "videoinput", deviceId: "", groupId: "", label: "" },
  ]);
  assert.equal(asked.length, 0, "a change never asks");

  // Two changes close together send only the list the last one read, even
  // when the first listing comes back after it.
  hardware = HARDWARE.slice(0, 1);
  mediaDevices.slowNext = true;
  mediaDevices.dispatchEvent(new Event("devicechange"));
  hardware = HARDWARE.slice(0, 2);
  mediaDevices.dispatchEvent(new Event("devicechange"));
  context.changed = undefined;
  await settle();
  await settle();
  assert.deepEqual((context.changed as { deviceId: string }[]).map(d => d.deviceId), ["mic1", "mic2"]);
  connected = [];
});

test("a kind hidden behind placeholders is asked for alone, its tracks stopped, then listed as plain data", async () => {
  reset();
  const mics = await read({ $devices: "audioinput" });
  assert.deepEqual(asked, [{ audio: true, video: false }]);
  assert.equal(stopped, 1);
  assert.deepEqual(mics, [
    { kind: "audioinput", deviceId: "mic1", groupId: "g1", label: "Headset Microphone" },
    { kind: "audioinput", deviceId: "mic2", groupId: "g2", label: "USB Microphone" },
  ]);
  assert.equal(Object.getPrototypeOf((mics as object[])[0]), Object.prototype);

  await read({ $devices: "audioinput" });
  assert.equal(asked.length, 1, "once allowed, it lists without asking");
});

test("speakers are asked for with the mic, cameras with the camera, and true asks for both", async () => {
  reset();
  const outputs = await read({ $devices: "audiooutput" });
  assert.deepEqual(asked, [{ audio: true, video: false }]);
  assert.deepEqual(outputs, [{ kind: "audiooutput", deviceId: "out1", groupId: "g1", label: "Headset Earphones" }]);

  reset();
  await read({ $devices: "videoinput" });
  assert.deepEqual(asked, [{ audio: false, video: true }]);

  reset();
  allowed.audio = true;
  const all = await read({ $devices: true });
  assert.deepEqual(asked, [{ audio: false, video: true }], "only what is still hidden");
  assert.equal((all as unknown[]).length, 4);
});

test("speakers hidden with the mic allowed are left hidden, without asking", async () => {
  reset();
  allowed.audio = true;
  hardware = HARDWARE.filter(d => d.kind !== "audiooutput").concat({ kind: "audiooutput", deviceId: "", groupId: "", label: "" });
  const outputs = await read({ $devices: "audiooutput" });
  assert.equal(asked.length, 0);
  assert.deepEqual(outputs, [{ kind: "audiooutput", deviceId: "", groupId: "", label: "" }]);
});

test("a refusal throws, saying where to allow it, in a browser and in Electron", async () => {
  reset();
  refuseWith = "NotAllowedError";
  await assert.rejects(read({ $devices: "audioinput" }), /\$devices: access to the microphone was refused\. Allow it in the site's settings/);
  await assert.rejects(read({ $devices: true }), /access to the microphone and camera was refused/);

  const agent = (navigator as unknown as { userAgent: string });
  try {
    agent.userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Electron/33.0.0";
    await assert.rejects(read({ $devices: "videoinput" }), /System Settings > Privacy & Security > Camera/);
    agent.userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/33.0.0";
    await assert.rejects(read({ $devices: "audioinput" }), /Settings > Privacy > Microphone, with access for desktop apps/);
  } finally {
    agent.userAgent = "Mozilla/5.0 Chrome/131.0";
  }

  refuseWith = "NotReadableError";
  await assert.rejects(read({ $devices: "audioinput" }), /the microphone couldn't be opened: another app may be using it/);
});

test("a kind it doesn't know, and a page without media devices, throw", async () => {
  reset();
  await assert.rejects(read({ $devices: "speakers" }), /\$devices takes true or a kind of device, "audioinput", "audiooutput" or "videoinput", not "speakers"/);
  await assert.rejects(read({ $devices: false }), /not false/);

  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
  Object.defineProperty(globalThis, "isSecureContext", { value: false, configurable: true });
  try {
    await assert.rejects(read({ $devices: "audioinput" }), /only from a secure page, served over https or from localhost/);
    Object.defineProperty(globalThis, "isSecureContext", { value: true, configurable: true });
    await assert.rejects(read({ $devices: "audioinput" }), /this browser has no media devices API/);
  } finally {
    Object.defineProperty(globalThis, "navigator", { value: { mediaDevices, userAgent: "Mozilla/5.0 Chrome/131.0" }, configurable: true });
    Reflect.deleteProperty(globalThis, "isSecureContext");
  }
});
