import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import { installDom } from "./dom.js";
import { PushNode } from "../src/nodes/PushNode.js";

const window = installDom();
const resolve = createResolver([...coreNodes(), new PushNode()]);
const run = (step: unknown) => resolve(step, {});

const json = { endpoint: "https://push.example/abc", expirationTime: null, keys: { p256dh: "p", auth: "a" } };

/** A browser with push support: a service worker registration whose push manager
 *  holds `current`, and a permission prompt that answers `permission`. */
function supportPush(permission: string, current: { endpoint: string } | null = null) {
  const subscribed: Array<Record<string, unknown>> = [];
  const pushManager = {
    subscribe: async (options: Record<string, unknown>) => { subscribed.push(options); return { toJSON: () => json }; },
    getSubscription: async () => current && { endpoint: current.endpoint, unsubscribe: async () => true },
  };
  Object.defineProperty(navigator, "serviceWorker", { value: { ready: Promise.resolve({ pushManager }) }, configurable: true });
  Object.defineProperty(window, "PushManager", { value: class {}, configurable: true });
  Object.defineProperty(globalThis, "Notification", { value: { requestPermission: async () => permission }, configurable: true });
  return subscribed;
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "serviceWorker");
  Reflect.deleteProperty(window, "PushManager");
  Reflect.deleteProperty(globalThis, "Notification");
});

test("subscribe asks for permission and returns the subscription's JSON", async () => {
  const subscribed = supportPush("granted");
  assert.deepEqual(await run({ "$push-subscribe": "BAAA" }), json);
  assert.equal(subscribed[0].userVisibleOnly, true);
  assert.ok(subscribed[0].applicationServerKey instanceof Uint8Array);
});

test("unsubscribe drops the subscription whose endpoint matches", async () => {
  supportPush("granted", { endpoint: json.endpoint });
  assert.equal(await run({ "$push-unsubscribe": json }), true);
});

// What these return today; each is a candidate to throw instead (see the v2
// plan), so these pin the behaviour that changes.
test("without support, permission, a key or a matching subscription, the ops return null or false", async () => {
  assert.equal(await run({ "$push-subscribe": "BAAA" }), null, "no service worker");
  assert.equal(await run({ "$push-unsubscribe": json }), false, "no service worker");

  supportPush("denied");
  assert.equal(await run({ "$push-subscribe": "BAAA" }), null, "permission denied");

  supportPush("granted");
  assert.equal(await run({ "$push-subscribe": "" }), null, "empty key");
  assert.equal(await run({ "$push-unsubscribe": json }), false, "no subscription");

  supportPush("granted", { endpoint: "https://push.example/other" });
  assert.equal(await run({ "$push-unsubscribe": json }), false, "another endpoint");
});
