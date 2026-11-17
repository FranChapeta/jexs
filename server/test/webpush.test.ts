import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify, type ECDH } from "node:crypto";
import fs from "node:fs/promises";
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import os from "node:os";
import path from "node:path";
import { createResolver, coreNodes } from "@jexs/core";
import { CryptoNode } from "../src/nodes/Crypto.js";
import { WebPushNode } from "../src/nodes/WebPush.js";

// A self-signed pair for localhost and 127.0.0.1, good until 2126, which the
// process trusts so a send can reach the push service below over HTTPS.
const TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgAF6SdQCGsQgG1O+0
NGgjDnSXmcNODK1r5fwdUM+KSumhRANCAAQQ8c0tLaeDAFnRxc0sF/gePUkaIp4T
F3rBf5vChvpJZFrqwYy0TQL7mdQLxlWvtxb4PHvrABRhdOS3cAbon5jo
-----END PRIVATE KEY-----
`;
const TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIBmzCCAUGgAwIBAgIUTkx1B7Q3qfa8aoRB5H9DHlhms28wCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTExNzE1MTgwOVoYDzIxMjYxMDI0
MTUxODA5WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAQQ8c0tLaeDAFnRxc0sF/gePUkaIp4TF3rBf5vChvpJZFrqwYy0TQL7
mdQLxlWvtxb4PHvrABRhdOS3cAbon5joo28wbTAdBgNVHQ4EFgQUCXTz3NpwJbqg
pxs0cOT3ypntVhgwHwYDVR0jBBgwFoAUCXTz3NpwJbqgpxs0cOT3ypntVhgwDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDSAAwRQIhAMw4yAooNLVH1oNG9l/XLMlbotir28+m2TDfBM+TsornAiBw
8rb1lzeYyhhF7DKqutEhWmFhh9CE0Ob/NwAlWrKMbg==
-----END CERTIFICATE-----
`;
https.globalAgent.options.ca = TLS_CERT;

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

interface Push {
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** A push service on 127.0.0.1 that answers every request with `status`, and the requests it got. */
async function pushService(t: TestContext, status = 201): Promise<{ endpoint: string; received: Push[] }> {
  const received: Push[] = [];
  const server = https.createServer({ key: TLS_KEY, cert: TLS_CERT }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(status).end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the push service has no port");
  return { endpoint: `https://127.0.0.1:${address.port}/push/abc`, received };
}

/** A browser's side of a subscription: its key pair and auth secret, and the JSON `$pushSubscribe` gives. */
function browser(endpoint: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, subscription: { endpoint, keys: { p256dh: ecdh.getPublicKey("base64url"), auth: auth.toString("base64url") } } };
}

/** A VAPID key pair, base64url as web-push takes it. */
function vapidPair() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: ecdh.getPublicKey("base64url"), privateKey: ecdh.getPrivateKey("base64url") };
}

/** The payload as the browser decrypts it (RFC 8291, aes128gcm). */
function decrypt(body: Buffer, ecdh: ECDH, auth: Buffer): unknown {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const serverKey = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), serverKey]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdh.computeSecret(serverKey), auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(record.subarray(-16));
  const padded = Buffer.concat([decipher.update(record.subarray(0, -16)), decipher.final()]);
  return JSON.parse(padded.subarray(0, padded.lastIndexOf(2)).toString());
}

/** The public key a request's VAPID header names, and its claims once their signature checks out against that key. */
function vapid(headers: IncomingHttpHeaders): { publicKey: string; claims: Record<string, unknown> } {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(headers.authorization ?? "");
  if (!match) throw new Error(`not a VAPID header: ${headers.authorization}`);
  const [, jwt, publicKey] = match;
  const point = Buffer.from(publicKey, "base64url");
  const key = createPublicKey({
    key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") },
    format: "jwk",
  });
  const [header, claims, signature] = jwt.split(".");
  assert.ok(
    verify("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")),
    "the JWT is signed by the key the header names",
  );
  return { publicKey, claims: JSON.parse(Buffer.from(claims, "base64url").toString()) };
}

const subject = "mailto:admin@app.test";

test("a send reaches the push service encrypted for the browser, signed with its own keys, and returns null", async t => {
  const { endpoint, received } = await pushService(t);
  const { ecdh, auth, subscription } = browser(endpoint);
  const keys = vapidPair();
  assert.equal(await resolver({
    $webpush: subscription, subject, ...keys,
    title: "Hi", badge: "/badge.png", data: { url: "/inbox" },
    ttl: 60, urgency: "high", topic: "inbox",
  }, {}), null);

  assert.equal(received.length, 1);
  const [{ headers, body }] = received;
  assert.deepEqual(decrypt(body, ecdh, auth), { title: "Hi", badge: "/badge.png", data: { url: "/inbox" } });
  const { publicKey, claims } = vapid(headers);
  assert.equal(publicKey, keys.publicKey);
  assert.equal(claims.sub, subject);
  assert.equal(claims.aud, new URL(endpoint).origin);
  assert.equal(headers.ttl, "60");
  assert.equal(headers.urgency, "high");
  assert.equal(headers.topic, "inbox");
});

// The keys travel with each send, never set for the whole process.
test("concurrent sends with different keys each sign with their own", async t => {
  const { endpoint, received } = await pushService(t);
  const { subscription } = browser(endpoint);
  const pairs = [vapidPair(), vapidPair()];
  await Promise.all(pairs.map(keys => resolver({ $webpush: subscription, subject, ...keys, title: "Hi" }, {})));
  assert.deepEqual(
    received.map(push => vapid(push.headers).publicKey).sort(),
    pairs.map(keys => keys.publicKey).sort(),
  );
});

// A dead subscription keeps its own status, so a `$catch` can prune it.
test("a failed send throws with the push service's status", async t => {
  const { endpoint } = await pushService(t, 410);
  const { subscription } = browser(endpoint);
  await assert.rejects(
    async () => resolver({ $webpush: subscription, subject, ...vapidPair(), title: "Hi" }, {}),
    (e: Error & { status?: number }) => e.status === 410 && /\$webpush failed/.test(e.message),
  );
});

test("a missing subject, half a key pair, a malformed subscription or an unknown urgency throw before sending", async t => {
  const { endpoint, received } = await pushService(t);
  const { subscription } = browser(endpoint);
  const keys = vapidPair();
  const send = (extra: Record<string, unknown>) => resolver({ $webpush: subscription, subject, ...keys, title: "Hi", ...extra }, {});
  await assert.rejects(async () => send({ subject: "" }), /needs a `subject`/);
  await assert.rejects(async () => send({ privateKey: undefined }), /takes `publicKey` and `privateKey` together, or neither/);
  // The app's own mistake, not the request's, so it carries no HTTP status.
  await assert.rejects(
    async () => send({ $webpush: { endpoint } }),
    (e: Error & { status?: number }) => e.status === undefined && /takes a push subscription/.test(e.message),
  );
  await assert.rejects(async () => send({ urgency: "urgent" }), /`urgency` is one of very-low, low, normal, high, not "urgent"/);
  assert.equal(received.length, 0);
});

test("without keys, a send signs with the pair the app secret derives, whose public half $webpushKey gives", t => underSecret("test secret", async () => {
  const { endpoint, received } = await pushService(t);
  const { subscription } = browser(endpoint);
  const r = deriving();
  try {
    const publicKey = await r({ $webpushKey: true }, {});
    assert.equal(await r({ $webpush: subscription, subject, title: "Hi" }, {}), null);
    // The signature checks out against the key, so the derived pair is a real P-256 pair.
    assert.equal(vapid(received[0].headers).publicKey, publicKey);
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
