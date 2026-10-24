import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import webpush from "web-push";
import { createResolver, coreNodes } from "@jexs/core";
import { CryptoNode } from "../src/nodes/Crypto.js";
import { WebPushNode } from "../src/nodes/WebPush.js";

const resolver = createResolver([...coreNodes(), new WebPushNode()]);

/** A resolver that derives its keys from the app secret: APP_SECRET, else the `secret.key` under `root`. */
const deriving = (root = ".") => createResolver([...coreNodes(), new CryptoNode(root), new WebPushNode()]);

/** Run `fn` with APP_SECRET set to `secret` (or unset), restoring it after. */
async function underSecret<T>(secret: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env.APP_SECRET;
  if (secret === undefined) delete process.env.APP_SECRET;
  else process.env.APP_SECRET = secret;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.APP_SECRET;
    else process.env.APP_SECRET = before;
  }
}

const keys = { subject: "mailto:admin@app.test", publicKey: "pub", privateKey: "priv" };
const to = { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } };
const send = (extra: Record<string, unknown> = {}) =>
  resolver({ $webpush: to, ...keys, title: "Hi", ...extra }, {});

test("a send carries its own keys and returns null", async t => {
  const sent = t.mock.method(webpush, "sendNotification", async () => ({ statusCode: 201, body: "", headers: {} }));
  const global = t.mock.method(webpush, "setVapidDetails", () => {});
  assert.equal(await send({ urgency: "high", badge: "/badge.png", data: { url: "/inbox" } }), null);

  const [subscription, payload, options] = sent.mock.calls[0].arguments as [unknown, string, webpush.RequestOptions];
  assert.deepEqual(subscription, to);
  assert.deepEqual(JSON.parse(payload), { title: "Hi", badge: "/badge.png", data: { url: "/inbox" } });
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

test("a missing subject, half a key pair, a malformed subscription or an unknown urgency throw before sending", async t => {
  const sent = t.mock.method(webpush, "sendNotification", async () => ({ statusCode: 201, body: "", headers: {} }));
  await assert.rejects(async () => send({ subject: "" }), /needs a `subject`/);
  await assert.rejects(async () => send({ privateKey: undefined }), /takes `publicKey` and `privateKey` together, or neither/);
  // The app's own mistake, not the request's, so it carries no HTTP status.
  await assert.rejects(
    async () => send({ $webpush: { endpoint: "https://push.example/abc" } }),
    (e: Error & { status?: number }) => e.status === undefined && /takes a push subscription/.test(e.message),
  );
  await assert.rejects(async () => send({ urgency: "urgent" }), /`urgency` is one of very-low, low, normal, high, not "urgent"/);
  assert.equal(sent.mock.callCount(), 0);
});

test("without keys, a send signs with the pair the app secret derives, whose public half $webpushKey gives", t => underSecret("test secret", async () => {
  const sent = t.mock.method(webpush, "sendNotification", async () => ({ statusCode: 201, body: "", headers: {} }));
  const r = deriving();
  try {
    const publicKey = await r({ $webpushKey: true }, {});
    assert.equal(await r({ $webpush: to, subject: keys.subject, title: "Hi" }, {}), null);
    const { vapidDetails } = sent.mock.calls[0].arguments[2] as webpush.RequestOptions;
    assert.equal(vapidDetails?.publicKey, publicKey);

    // A real P-256 pair, as web-push itself checks before signing.
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(vapidDetails!.privateKey, "base64url"));
    assert.equal(ecdh.getPublicKey("base64url"), publicKey);
    assert.ok(webpush.getVapidHeaders("https://push.example", keys.subject, vapidDetails!.publicKey, vapidDetails!.privateKey, "aes128gcm").Authorization);
  } finally {
    r.destroy();
  }
}));

test("the same secret derives the same pair, and another secret another", async () => {
  const keyUnder = (secret: string) => underSecret(secret, async () => {
    const r = deriving();
    try {
      return await r({ $webpushKey: true }, {});
    } finally {
      r.destroy();
    }
  });
  assert.equal(await keyUnder("one"), await keyUnder("one"));
  assert.notEqual(await keyUnder("one"), await keyUnder("two"));
});

test("without APP_SECRET outside production, the pair comes from the secret.key $encrypt writes", () => underSecret(undefined, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jexs-webpush-"));
  const [a, b] = [deriving(root), deriving(root)];
  try {
    const key = await a({ $webpushKey: true }, {});
    assert.equal(await b({ $webpushKey: true }, {}), key, "a second resolver at the root reads the same file");
    await fs.access(path.join(root, "secret.key"));
  } finally {
    a.destroy();
    b.destroy();
    await fs.rm(root, { recursive: true, force: true });
  }
}));
