import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createResolver, coreNodes } from "@jexs/core";
import { CryptoNode } from "../src/nodes/Crypto.js";

const resolve = createResolver([...coreNodes(), new CryptoNode()]);

// ── Digests ───────────────────────────────────────────────────────────────────

test("sha256: hex by default, other encodings on request", () => {
  assert.equal(
    resolve({ sha256: "abc" }, {}),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(resolve({ sha256: "abc", encoding: "base64" }, {}), "ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=");
  // base64url is the one a digest going into a URL or a JWT wants: the two
  // substituted characters, and no padding.
  assert.equal(resolve({ sha256: "abc", encoding: "base64url" }, {}), "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
});

// The sibling is not `toBase64` of the hex, and cannot be: it encodes the 32
// digest BYTES, which are never a value a template can hold, while composing
// encodes the 64-character hex text. Only the first is what SRI, S3 checksums
// and webhook signatures mean by a base64 digest.
test("sha256: encoding is the digest bytes, not base64 of the hex string", () => {
  const encoded = resolve({ sha256: "abc", encoding: "base64" }, {}) as string;
  const composed = resolve({ toBase64: { sha256: "abc" } }, {}) as string;
  assert.notEqual(encoded, composed);
  assert.equal(Buffer.from(encoded, "base64").length, 32);
  assert.equal(Buffer.from(composed, "base64").toString(), resolve({ sha256: "abc" }, {}));
});

test("sha256: an unlisted encoding says so rather than picking one", () => {
  assert.throws(
    () => resolve({ sha256: "abc", encoding: "hex64" }, {}),
    /Invalid sha256 encoding "hex64": expected hex, base64, base64url/,
  );
});

// Absent means the documented default. An empty string is a value someone
// wrote, or an expression that resolved to nothing, and defaulting there would
// bury the mistake.
test("sha256: absent encoding defaults, an empty one is an error", () => {
  assert.equal(resolve({ sha256: "abc" }, {}), resolve({ sha256: "abc", encoding: null }, {}));
  assert.throws(() => resolve({ sha256: "abc", encoding: "" }, {}), /Invalid sha256 encoding/);
  assert.throws(
    () => resolve({ sha256: "abc", encoding: { var: "$unsetButEmpty" } }, { unsetButEmpty: "" }),
    /Invalid sha256 encoding/,
  );
});

// ── HMAC ──────────────────────────────────────────────────────────────────────

// RFC 4231 test case 2, so this pins the value rather than restating the code.
test("hmac: matches the RFC vector", () => {
  assert.equal(
    resolve({ hmac: ["what do ya want for nothing?", "Jefe"] }, {}),
    "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
  );
});

test("hmac: algorithm and encoding are honored", () => {
  const body = "{\"id\":1}";
  const key = "shhh";
  assert.equal(
    resolve({ hmac: [body, key], algorithm: "sha512", encoding: "base64" }, {}),
    createHmac("sha512", key).update(body).digest("base64"),
  );
  assert.throws(
    () => resolve({ hmac: ["x", "k"], algorithm: "md5" }, {}),
    /Invalid hmac algorithm "md5": expected sha256, sha512, sha1/,
  );
});

test("hmac: the signature check a webhook actually performs", () => {
  const body = "{\"event\":\"charge\"}";
  const secret = "whsec_123";
  const sent = createHmac("sha256", secret).update(body).digest("hex");
  const verified = resolve(
    {
      timingSafeEqual: [{ var: "$sent" }, { hmac: [{ var: "$body" }, { var: "$secret" }] }],
    },
    { body, secret, sent },
  );
  assert.equal(verified, true);
});

// ── Constant-time compare ─────────────────────────────────────────────────────

test("timingSafeEqual: equal, unequal, and lengths that differ", () => {
  assert.equal(resolve({ timingSafeEqual: ["token", "token"] }, {}), true);
  assert.equal(resolve({ timingSafeEqual: ["token", "tokem"] }, {}), false);
  // Raw timingSafeEqual throws on a length mismatch; digesting first means this
  // answers instead of blowing up, and without leaking which length was wrong.
  assert.equal(resolve({ timingSafeEqual: ["short", "a much longer value"] }, {}), false);
  assert.equal(resolve({ timingSafeEqual: ["", ""] }, {}), true);
});

// The arity check runs on the RESOLVED value, so the whole pair may come from
// one expression rather than being written out. Checking the raw def first read
// `{ var: … }` as a single value and refused it.
test("the two-value ops take their pair from one expression", async () => {
  const secret = "shhh";
  const body = "{\"id\":1}";
  const signature = createHmac("sha256", secret).update(body).digest("hex");

  assert.equal(
    resolve({ hmac: { var: "$signing" } }, { signing: [body, secret] }),
    signature,
  );
  assert.equal(resolve({ timingSafeEqual: { var: "$both" } }, { both: ["a", "a"] }), true);
  assert.equal(resolve({ timingSafeEqual: { var: "$both" } }, { both: ["a", "b"] }), false);

  const hash = await resolve({ hash: "hunter2" }, {}) as string;
  assert.equal(await resolve({ verify: { var: "$creds" } }, { creds: ["hunter2", hash] }), true);
});

// A comparison missing a side did not come out false, it never happened, and
// answering "does this token match" with `false` when nothing was compared is
// the wrong answer to give.
test("timingSafeEqual: a missing side is an error, not a false", () => {
  assert.throws(() => resolve({ timingSafeEqual: ["only"] }, {}), /timingSafeEqual needs two values: \[value, value\]/);
  assert.throws(() => resolve({ timingSafeEqual: "not a pair" }, {}), /timingSafeEqual needs two values/);
  assert.throws(() => resolve({ verify: ["password"] }, {}), /verify needs two values: \[password, hash\]/);
});

test("randomHex: absent means 32 bytes, unreadable means an error", () => {
  assert.equal((resolve({ randomHex: null }, {}) as string).length, 64);
  assert.equal((resolve({ randomHex: 16 }, {}) as string).length, 32);
  for (const bytes of ["abc", "", 0, -8, 1.5]) {
    assert.throws(
      () => resolve({ randomHex: bytes }, {}),
      /Invalid randomHex .*expected a positive whole number of bytes/,
      `randomHex: ${JSON.stringify(bytes)} should have been refused`,
    );
  }
});

// ── UUID ──────────────────────────────────────────────────────────────────────

test("uuid: a version 4 uuid, different every time", () => {
  const first = resolve({ uuid: true }, {}) as string;
  const second = resolve({ uuid: true }, {}) as string;
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first, second);
});
