import { test } from "node:test";
import assert from "node:assert/strict";
import webpush from "web-push";
import { createResolver, coreNodes } from "@jexs/core";
import { WebPushNode } from "../src/nodes/PushNode.js";

const resolver = createResolver([...coreNodes(), new WebPushNode()]);

const keys = { subject: "mailto:admin@app.test", publicKey: "pub", privateKey: "priv" };
const to = { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } };
const send = (extra: Record<string, unknown> = {}) =>
  resolver({ $webpush: true, ...keys, to, title: "Hi", ...extra }, {});

test("a send carries its own keys and returns null", async t => {
  const sent = t.mock.method(webpush, "sendNotification", async () => ({ statusCode: 201, body: "", headers: {} }));
  const global = t.mock.method(webpush, "setVapidDetails", () => {});
  assert.equal(await send({ urgency: "high" }), null);

  const [subscription, payload, options] = sent.mock.calls[0].arguments as [unknown, string, webpush.RequestOptions];
  assert.deepEqual(subscription, to);
  assert.deepEqual(JSON.parse(payload), { title: "Hi" });
  assert.deepEqual(options.vapidDetails, keys);
  assert.equal(options.urgency, "high");
  assert.equal(global.mock.callCount(), 0, "no process-wide keys");
});

// A dead subscription keeps its own status, so a `$catch` can prune it.
test("a failed send throws with the push service's status", async t => {
  t.mock.method(webpush, "sendNotification", async () => {
    throw new webpush.WebPushError("Gone", 410, {}, "", to.endpoint);
  });
  await assert.rejects(async () => send(), (e: Error & { status?: number }) => e.status === 410 && /Gone/.test(e.message));
});

test("missing keys or a malformed subscription throw before sending", async t => {
  const sent = t.mock.method(webpush, "sendNotification", async () => ({ statusCode: 201, body: "", headers: {} }));
  await assert.rejects(async () => send({ privateKey: "" }), /needs `subject`, `publicKey` and `privateKey`/);
  await assert.rejects(
    async () => send({ to: { endpoint: "https://push.example/abc" } }),
    (e: Error & { status?: number }) => e.status === 400,
  );
  assert.equal(sent.mock.callCount(), 0);
});
