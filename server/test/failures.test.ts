import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import { serverNodes } from "../src/index.js";

// A failure is an error that reaches `$catch`, never a `null` or a log line.
const resolve = createResolver([...coreNodes(), ...serverNodes({ root: "." })]);

after(() => resolve.destroy());

test("an unknown operation is an error", async () => {
  await assert.rejects(async () => resolve({ $database: "nope" }, {}), /\$database: unknown operation "nope"/);
  await assert.rejects(async () => resolve({ $oauth: "nope" }, {}), /\$oauth: unknown operation "nope"/);
  await assert.rejects(async () => resolve({ $tailwind: "nope" }, {}), /\$tailwind: unknown operation "nope"/);
  await assert.rejects(async () => resolve({ $session: "nope" }, {}), /\$session takes "load", "destroy" or a map/);
});

test("a socket op outside a socket's handlers is an error", async () => {
  await assert.rejects(async () => resolve({ "$socketSend": "hi" }, {}), /\$socketSend runs in a socket's handlers/);
  await assert.rejects(async () => resolve({ "$socketJoin": "lobby" }, {}), /\$socketJoin runs in a socket's handlers/);
  await assert.rejects(async () => resolve({ "$socketSendTo": "nobody", data: 1 }, {}), /no open connection "nobody"/);
});

test("$listen without do is an error", async () => {
  await assert.rejects(async () => resolve({ $listen: 0 }, {}), /\$listen needs "do"/);
});

test("in production, the default cache must be connected", async () => {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const own = createResolver([...coreNodes(), ...serverNodes({ root: "." })]);
  try {
    await assert.rejects(async () => own({ "$cacheGet": "x" }, {}), /No cache is connected/);
    await own({ "$cacheConnect": "memory" }, {});
    assert.equal(await own({ "$cacheGet": "x" }, {}) ?? null, null, "a memory cache connected on purpose is fine");
  } finally {
    process.env.NODE_ENV = before;
    own.destroy();
  }
});

test("a malformed JSON body is a 400", async () => {
  const own = createResolver([...coreNodes(), ...serverNodes({ root: "." })]);
  try {
    const port = await own({ $listen: 0, do: [{ $var: "request.body" }] }, {});
    const post = (body: string) => fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal((await post('{"ok":true}')).status, 200);
    const bad = await post("{nope");
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /Malformed JSON body/);
  } finally {
    own.destroy();
  }
});

// A webhook's signature is over the bytes it sent, which a parsed body no
// longer has: spacing and key order are gone once it is an object.
test("a request carries its body as the text it came as, beside the parsed one", async () => {
  const own = createResolver([...coreNodes(), ...serverNodes({ root: "." })]);
  try {
    const port = await own({ $listen: 0, do: [{ response: { raw: { $var: "request.rawBody" }, id: { $var: "request.body.id" } } }] }, {});
    const sent = '{ "id": 7,  "b": 1 }';
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { "content-type": "application/json" }, body: sent });
    assert.deepEqual(await res.json(), { raw: sent, id: 7 });
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/`)).json(), { raw: "" }, "no body is the empty text");
  } finally {
    own.destroy();
  }
});
