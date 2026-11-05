import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes());

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

type Reply = (url: string, init: RequestInit) => Response | Promise<Response>;

const jsonReply: Reply = () => new Response("{\"ok\":true}", {
  headers: { "content-type": "application/json" },
});

/** Capture the requests the node builds, and answer each with `reply`. */
function stubFetch(reply: Reply = jsonReply): { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = ((url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return Promise.resolve(reply(url, init));
  }) as typeof fetch;
  return { calls };
}

/** Headers the node passed, lowercased by the Headers object itself. */
function sentHeaders(init: RequestInit): Record<string, string> {
  return Object.fromEntries(new Headers(init.headers).entries());
}

test("fetch: sends literal and expression headers", async () => {
  const { calls } = stubFetch();
  const out = await resolve(
    {
      $fetch: "/api/me",
      headers: {
        Authorization: { $concat: ["Bearer ", { $var: "token" }] },
        Accept: "application/json",
      },
    },
    { token: "abc123" },
  );
  assert.deepEqual(out, { ok: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(sentHeaders(calls[0].init), {
    authorization: "Bearer abc123",
    accept: "application/json",
  });
});

test("fetch: headers may be a step resolving to a map", async () => {
  const { calls } = stubFetch();
  await resolve({ $fetch: "/api/me", headers: { $var: "h" } }, { h: { "X-Trace": "t1" } });
  assert.deepEqual(sentHeaders(calls[0].init), { "x-trace": "t1" });
});

test("fetch: an author Content-Type replaces the JSON default, whatever its casing", async () => {
  const { calls } = stubFetch();
  await resolve(
    {
      $fetch: "/api/form",
      method: "POST",
      body: "a=1&b=2",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    },
    {},
  );
  assert.equal(sentHeaders(calls[0].init)["content-type"], "application/x-www-form-urlencoded");
  assert.equal(calls[0].init.body, "a=1&b=2");
});

test("fetch: an object body still defaults to JSON", async () => {
  const { calls } = stubFetch();
  await resolve({ $fetch: "/api/users", method: "POST", body: { name: { $var: "name" } } }, { name: "Ada" });
  assert.equal(sentHeaders(calls[0].init)["content-type"], "application/json");
  assert.equal(calls[0].init.body, "{\"name\":\"Ada\"}");
});

test("fetch: headers named after a handler key are not dispatched as nodes", async () => {
  const { calls } = stubFetch();
  await resolve({ $fetch: "/api/me", headers: { var: "$notAPath", if: "cond" } }, {});
  assert.deepEqual(sentHeaders(calls[0].init), { var: "$notAPath", if: "cond" });
});

test("fetch: null/undefined header values are dropped", async () => {
  const { calls } = stubFetch();
  await resolve({ $fetch: "/api/me", headers: { Authorization: { $var: "missing" }, Accept: "text/plain" } }, {});
  assert.deepEqual(sentHeaders(calls[0].init), { accept: "text/plain" });
});

test("fetch: a binary body is sent as-is, with no JSON content type", async () => {
  const { calls } = stubFetch();
  const bytes = new Uint8Array([1, 2, 3]);
  await resolve({ $fetch: "/api/upload", method: "POST", body: { $var: "bytes" } }, { bytes });
  assert.equal(calls[0].init.body, bytes);
  assert.equal(sentHeaders(calls[0].init)["content-type"], undefined);
});

test("fetch: GET and HEAD never send a body", async () => {
  const { calls } = stubFetch();
  await resolve({ $fetch: "/api/thing", body: { a: 1 } }, {});
  await resolve({ $fetch: "/api/thing", method: "HEAD", body: { a: 1 } }, {});
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[1].init.body, undefined);
});

test("fetch: a non-2xx status throws an HTTP error catch can branch on", async () => {
  stubFetch(() => new Response("{\"message\":\"nope\"}", { status: 403, statusText: "Forbidden" }));
  const out = await resolve(
    {
      $fetch: "/api/secret",
      $catch: [{ $concat: ["denied with ", { $var: "error.status" }] }],
    },
    {},
  );
  assert.equal(out, "denied with 403");
});

test("fetch: catch gets the failing response as $response, beside $error", async () => {
  stubFetch(() => new Response("{\"field\":\"email\",\"message\":\"already taken\"}", {
    status: 422,
    headers: { "content-type": "application/json", "x-request-id": "r1" },
  }));
  const out = await resolve(
    {
      $fetch: "/api/users",
      method: "POST",
      body: { email: "a@b.c" },
      $catch: [{ $concat: [
        { $var: "error.status" }, " ",
        { $var: "response.body.field" }, " ",
        { $var: "response.body.message" }, " ",
        { $var: "response.headers.x-request-id" }, " ",
        { $var: "response.ok" },
      ] }],
    },
    {},
  );
  assert.equal(out, "422 email already taken r1 false");
});

test("fetch: a non-JSON failing body stays a string", async () => {
  stubFetch(() => new Response("<h1>Gateway Timeout</h1>", {
    status: 504,
    headers: { "content-type": "text/html" },
  }));
  const out = await resolve(
    { $fetch: "/api/thing", $catch: [{ $var: "response.body" }] },
    {},
  );
  assert.equal(out, "<h1>Gateway Timeout</h1>");
});

// $error keeps one shape for every node; a binding is a sibling of it, never a
// way to rewrite it.
test("fetch: $error stays { status, message } and $response cannot displace it", async () => {
  stubFetch(() => new Response("{\"status\":\"ignored\",\"message\":\"ignored\"}", {
    status: 400,
    headers: { "content-type": "application/json" },
  }));
  const out = await resolve(
    { $fetch: "/api/thing", $catch: [{ $concat: [{ $var: "error.status" }, " ", { $var: "error.message" }] }] },
    {},
  );
  assert.equal(out, "400 GET /api/thing failed with 400: {\"status\":\"ignored\",\"message\":\"ignored\"}");
});

test("fetch: $response is scoped to the catch, leaving the outer one alone", async () => {
  stubFetch(() => new Response("nope", { status: 500 }));
  const ctx: Record<string, unknown> = { response: "mine" };
  const out = await resolve({ $fetch: "/api/thing", $catch: [{ $var: "response.status" }] }, ctx);
  assert.equal(out, 500);
  assert.equal(ctx.response, "mine");
});

test("fetch: the thrown message carries the failing body", async () => {
  stubFetch(() => new Response("{\n  \"message\": \"nope\"\n}", { status: 500, statusText: "Server Error" }));
  await assert.rejects(
    async () => { await resolve({ $fetch: "/api/thing", method: "POST" }, {}); },
    (err: Error & { status?: number }) => {
      assert.equal(err.status, 500);
      assert.equal(err.message, "POST /api/thing failed with 500: { \"message\": \"nope\" }");
      return true;
    },
  );
});

test("fetch: full returns the envelope on success", async () => {
  stubFetch(() => new Response("{\"ok\":true}", {
    status: 201,
    headers: { "content-type": "application/json", etag: "W/\"1\"" },
  }));
  const out = await resolve({ $fetch: "/api/thing", method: "POST", full: true }, {}) as Record<string, unknown>;
  assert.equal(out.status, 201);
  assert.equal(out.ok, true);
  assert.deepEqual(out.body, { ok: true });
  assert.equal((out.headers as Record<string, string>).etag, "W/\"1\"");
});

// `throw` decides whether a failing status stops the step; `full` decides the
// shape. Asking for headers must not quietly disarm error handling.
test("fetch: full alone still throws on a failing status", async () => {
  stubFetch(() => new Response("{\"message\":\"gone\"}", { status: 404 }));
  await assert.rejects(
    async () => { await resolve({ $fetch: "/api/thing", full: true }, {}); },
    (err: Error & { status?: number }) => err.status === 404,
  );
});

test("fetch: $catch gets the failing response, its body decoded", async () => {
  stubFetch(() => new Response("{\"message\":\"gone\"}", {
    status: 404,
    headers: { "content-type": "application/json", "x-request-id": "r1" },
  }));
  const out = await resolve({ $fetch: "/api/thing", $catch: [{ $var: "response" }] }, {}) as Record<string, unknown>;
  assert.equal(out.status, 404);
  assert.equal(out.ok, false);
  assert.deepEqual(out.body, { message: "gone" });
  assert.equal((out.headers as Record<string, string>)["x-request-id"], "r1");
});

test("fetch: 204 and HEAD resolve to null", async () => {
  stubFetch(() => new Response(null, { status: 204 }));
  assert.equal(await resolve({ $fetch: "/api/thing.json", method: "DELETE" }, {}), null);
  stubFetch(() => new Response(null, { headers: { "content-type": "application/json" } }));
  assert.equal(await resolve({ $fetch: "/api/thing", method: "HEAD" }, {}), null);
});

test("fetch: an empty JSON body reads as null instead of throwing", async () => {
  stubFetch(() => new Response("", { headers: { "content-type": "application/json" } }));
  assert.equal(await resolve({ $fetch: "/api/thing" }, {}), null);
});

test("fetch: type forces decoding over the URL extension and Content-Type", async () => {
  stubFetch(() => new Response("{\"ok\":true}", { headers: { "content-type": "application/json" } }));
  assert.equal(await resolve({ $fetch: "/api/thing.json", type: "text" }, {}), "{\"ok\":true}");
  stubFetch(() => new Response("{\"ok\":true}", { headers: { "content-type": "application/octet-stream" } }));
  assert.deepEqual(await resolve({ $fetch: "/api/thing", type: "json" }, {}), { ok: true });
});

test("fetch: a +json content type decodes as JSON", async () => {
  stubFetch(() => new Response("{\"title\":\"Bad Request\"}", {
    headers: { "content-type": "application/problem+json" },
  }));
  assert.deepEqual(await resolve({ $fetch: "/api/thing", full: true }, {}) as Record<string, unknown>, {
    status: 200,
    ok: true,
    headers: { "content-type": "application/problem+json" },
    body: { title: "Bad Request" },
    url: "",
  });
});

/** A request that hangs until its own timeout aborts it. */
function stubHang(): void {
  globalThis.fetch = ((_url: string, init: RequestInit = {}) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  })) as typeof fetch;
}

test("fetch: timeout aborts the request and throws a 408", async () => {
  stubHang();
  const out = await resolve(
    {
      $fetch: "/api/slow",
      timeout: 20,
      $catch: [{ $concat: [{ $var: "error.status" }, " ", { $var: "error.message" }] }],
    },
    {},
  );
  assert.equal(out, "408 GET /api/slow timed out after 20ms");
});

// `ok` is derived from the status, not read off the response, so a Response-like
// that omits the property (a polyfill, a hand-rolled stub) is not read as failed.
test("fetch: a response without an ok property is judged by its status", async () => {
  globalThis.fetch = (() => Promise.resolve({
    status: 200,
    url: "/api/thing",
    headers: new Headers({ "content-type": "application/json" }),
    text: () => Promise.resolve("{\"ok\":true}"),
  })) as unknown as typeof fetch;
  assert.deepEqual(await resolve({ $fetch: "/api/thing" }, {}), { ok: true });
  const out = await resolve({ $fetch: "/api/thing", full: true }, {}) as Record<string, unknown>;
  assert.equal(out.ok, true);
});

test("fetch: a manual redirect is the result, not a failure", async () => {
  const { calls } = stubFetch(() => new Response(null, {
    status: 302,
    headers: { location: "/dest" },
  }));
  const out = await resolve(
    { $fetch: "/go", redirect: "manual", full: true },
    {},
  ) as Record<string, unknown>;
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(out.status, 302);
  assert.equal(out.ok, false);
  assert.equal((out.headers as Record<string, string>).location, "/dest");
});

test("fetch: a request that never connects reaches $catch, without a response", async () => {
  globalThis.fetch = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
  const out = await resolve(
    { $fetch: "/api/gone", $catch: [{ $concat: [{ $var: "error.message" }, " ", { $typeof: { $var: "response" } }] }] },
    {},
  );
  assert.equal(out, "fetch failed undefined");
});

test("fetch: request options pass through", async () => {
  const { calls } = stubFetch();
  await resolve(
    { $fetch: "/api/thing", credentials: "include", mode: "cors", redirect: "manual", cache: "no-store" },
    {},
  );
  assert.equal(calls[0].init.credentials, "include");
  assert.equal(calls[0].init.mode, "cors");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.cache, "no-store");
});

test("fetch: an enum value outside its list says so instead of being dropped", async () => {
  const { calls } = stubFetch();
  await assert.rejects(
    async () => { await resolve({ $fetch: "/api/thing", credentials: "sometimes" }, {}); },
    { message: "Invalid fetch credentials \"sometimes\": expected omit, same-origin, include" },
  );
  await assert.rejects(
    async () => { await resolve({ $fetch: "/api/thing", type: "buffer" }, {}); },
    { message: "Invalid fetch type \"buffer\": expected json, text, binary, blob" },
  );
  // Rejected before the request is made, so a typo costs no round trip.
  assert.equal(calls.length, 0);
});

// In a page, a Jexs server keeps the session's CSRF token in a `csrf` cookie;
// `$fetch` sends it back on the page's own state-changing requests.
test("fetch: in a page, sends the csrf cookie on its own state-changing requests only", async t => {
  Object.assign(globalThis, {
    document: { cookie: "theme=dark; csrf=tok%2Ben" },
    location: { href: "https://app.test/admin", origin: "https://app.test" },
  });
  t.after(() => {
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "location");
  });
  const { calls } = stubFetch();

  await resolve({ $fetch: "/api/items", method: "POST", body: { a: 1 } }, {});
  await resolve({ $fetch: "https://app.test/api/items/1", method: "DELETE" }, {});
  await resolve({ $fetch: "/api/items" }, {});
  await resolve({ $fetch: "https://other.test/api", method: "POST" }, {});
  await resolve({ $fetch: "/api/items", method: "PUT", headers: { "x-csrf-token": "mine" } }, {});

  const tokens = calls.map(c => sentHeaders(c.init)["x-csrf-token"]);
  assert.deepEqual(tokens, ["tok+en", "tok+en", undefined, undefined, "mine"]);
});

test("fetch: outside a page, no csrf header is added", async () => {
  const { calls } = stubFetch();
  await resolve({ $fetch: "https://app.test/api", method: "POST" }, {});
  assert.equal(sentHeaders(calls[0].init)["x-csrf-token"], undefined);
});

/** A response whose body arrives in `parts`, one chunk per read, noting a cancel. */
function streamReply(parts: (string | number[])[], init: ResponseInit = {}): { reply: Reply; cancelled: () => boolean } {
  let cancelled = false;
  const reply: Reply = () => {
    const encoder = new TextEncoder();
    let next = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next >= parts.length) return controller.close();
        const part = parts[next++];
        controller.enqueue(typeof part === "string" ? encoder.encode(part) : new Uint8Array(part));
      },
      cancel() { cancelled = true; },
    });
    return new Response(body, init);
  };
  return { reply, cancelled: () => cancelled };
}

const collect = [{ $push: [{ $var: "out" }, { $var: "message" }] }];

const sseParts = [
  ": keep-alive\r\n\r\nevent: content_block_delta\r\ndata: {\"delta\":{\"text\":\"Hel\"}}\r\n",
  "\r\nevent: content_block_delta\ndata: {\"delta\":{\"text\":\"lo\"}}\n\n",
  "data: first\ndata: second\nid: 7\n\nevent: ping\n\ndata: null\n\ndata: tail",
];
const sseInit = { headers: { "content-type": "text/event-stream; charset=utf-8" } };

test("fetch stream: a text/event-stream body runs onMessage per Server-Sent Event, with its data", async () => {
  stubFetch(streamReply(sseParts, sseInit).reply);
  const ctx = { out: [] as unknown[] };
  const result = await resolve({ $fetch: "/api/stream", onMessage: collect }, ctx);
  assert.equal(result, null);
  assert.deepEqual(ctx.out, [{ delta: { text: "Hel" } }, { delta: { text: "lo" } }, "first\nsecond", null, "tail"]);
});

test("fetch stream: with full, onMessage gets each whole Server-Sent Event", async () => {
  stubFetch(streamReply(sseParts, sseInit).reply);
  const ctx = { out: [] as unknown[] };
  await resolve({ $fetch: "/api/stream", full: true, onMessage: collect }, ctx);
  assert.deepEqual(ctx.out, [
    { event: "content_block_delta", data: { delta: { text: "Hel" } } },
    { event: "content_block_delta", data: { delta: { text: "lo" } } },
    { event: "message", data: "first\nsecond", id: "7" },
    { event: "message", data: null },
    { event: "message", data: "tail" },
  ]);
});

test("fetch stream: an NDJSON body runs onMessage per value, blank lines skipped", async () => {
  stubFetch(streamReply(["{\"a\":1}\n\n{\"a\"", ":2}\n[3]"], { headers: { "content-type": "application/x-ndjson" } }).reply);
  const ctx = { out: [] as unknown[] };
  await resolve({ $fetch: "/api/stream", onMessage: collect }, ctx);
  assert.deepEqual(ctx.out, [{ a: 1 }, { a: 2 }, [3]]);
});

test("fetch stream: a text body arrives in chunks, a character split across two kept whole", async () => {
  // "añb", with the two bytes of "ñ" in different chunks.
  stubFetch(streamReply([[0x61, 0xc3], [0xb1, 0x62]], { headers: { "content-type": "text/plain" } }).reply);
  const ctx = { out: [] as unknown[] };
  await resolve({ $fetch: "/api/stream", onMessage: collect }, ctx);
  assert.deepEqual(ctx.out, ["a", "ñb"]);
});

test("fetch stream: any other body arrives as byte chunks", async () => {
  stubFetch(streamReply([[1, 2], [3]], { headers: { "content-type": "application/octet-stream" } }).reply);
  const ctx = { out: [] as unknown[] };
  await resolve({ $fetch: "/api/stream", onMessage: collect }, ctx);
  assert.deepEqual(ctx.out.map(chunk => chunk instanceof Uint8Array ? [...chunk] : chunk), [[1, 2], [3]]);
});

test("fetch stream: stream overrides the Content-Type, and lines splits on LF, CRLF and CR", async () => {
  stubFetch(streamReply(["a\r", "\nb\rc\n", "d"], { headers: { "content-type": "application/json" } }).reply);
  const ctx = { out: [] as unknown[] };
  await resolve({ $fetch: "/api/stream", stream: "lines", onMessage: collect }, ctx);
  assert.deepEqual(ctx.out, ["a", "b", "c", "d"]);
});

test("fetch stream: each message's steps finish before the next one runs", async () => {
  stubFetch(streamReply(["1\n2\n"], { headers: { "content-type": "text/plain" } }).reply);
  const ctx = { out: [] as unknown[] };
  await resolve({
    $fetch: "/api/stream",
    stream: "lines",
    onMessage: [
      { $push: [{ $var: "out" }, { $concat: ["start ", { $var: "message" }] }] },
      { $sleep: 10 },
      { $push: [{ $var: "out" }, { $concat: ["end ", { $var: "message" }] }] },
    ],
  }, ctx);
  assert.deepEqual(ctx.out, ["start 1", "end 1", "start 2", "end 2"]);
});

test("fetch stream: an error in onMessage cancels the body and reaches $catch", async () => {
  const stream = streamReply(["1\n", "2\n", "3\n"], { headers: { "content-type": "text/plain" } });
  stubFetch(stream.reply);
  const ctx = { out: [] as unknown[] };
  const out = await resolve({
    $fetch: "/api/stream",
    stream: "lines",
    onMessage: [...collect, { $error: 500, message: "stop" }],
    $catch: [{ $var: "error.message" }],
  }, ctx);
  assert.equal(out, "stop");
  assert.deepEqual(ctx.out, ["1"]);
  assert.equal(stream.cancelled(), true);
});

test("fetch stream: full resolves to the response with a null body", async () => {
  stubFetch(streamReply(["x"], { status: 201, headers: { "content-type": "text/plain" } }).reply);
  const ctx = { out: [] as unknown[] };
  const out = await resolve({ $fetch: "/api/stream", full: true, onMessage: collect }, ctx) as Record<string, unknown>;
  assert.equal(out.status, 201);
  assert.equal(out.body, null);
  assert.deepEqual(ctx.out, ["x"]);
});

test("fetch stream: a non-2xx throws before any message runs", async () => {
  stubFetch(streamReply(["{\"message\":\"nope\"}"], { status: 429, headers: { "content-type": "application/json" } }).reply);
  const ctx = { out: [] as unknown[] };
  const out = await resolve({ $fetch: "/api/stream", onMessage: collect, $catch: [{ $var: "response.body.message" }] }, ctx);
  assert.equal(out, "nope");
  assert.deepEqual(ctx.out, []);
});

test("fetch stream: a 204 runs no message", async () => {
  stubFetch(() => new Response(null, { status: 204 }));
  const ctx = { out: [] as unknown[] };
  assert.equal(await resolve({ $fetch: "/api/stream", onMessage: collect }, ctx), null);
  assert.deepEqual(ctx.out, []);
});

test("fetch stream: type does not combine with onMessage or stream", async () => {
  const { calls } = stubFetch();
  await assert.rejects(Promise.resolve(resolve({ $fetch: "/api/stream", type: "text", onMessage: collect }, { out: [] })), /does not apply/);
  await assert.rejects(Promise.resolve(resolve({ $fetch: "/api/stream", type: "text", stream: "text" }, {})), /does not apply/);
  assert.equal(calls.length, 0);
});

/** Every value a stream yields, read to its end. */
async function readAll(stream: unknown): Promise<unknown[]> {
  assert.ok(stream instanceof ReadableStream, "expected a ReadableStream");
  const reader = stream.getReader();
  const out: unknown[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

test("fetch stream: stream alone resolves to a ReadableStream of the messages", async () => {
  stubFetch(streamReply(sseParts, sseInit).reply);
  const stream = await resolve({ $fetch: "/api/stream", stream: "sse" }, {});
  assert.deepEqual(await readAll(stream), [{ delta: { text: "Hel" } }, { delta: { text: "lo" } }, "first\nsecond", null, "tail"]);
});

test("fetch stream: stream alone frames as its kind says, NDJSON and bytes alike", async () => {
  stubFetch(streamReply(["{\"a\":1}\n{\"a\"", ":2}\n"]).reply);
  assert.deepEqual(await readAll(await resolve({ $fetch: "/api/stream", stream: "ndjson" }, {})), [{ a: 1 }, { a: 2 }]);
  stubFetch(streamReply([[1, 2], [3]]).reply);
  const bytes = await readAll(await resolve({ $fetch: "/api/stream", stream: "binary" }, {}));
  assert.deepEqual(bytes.map(chunk => chunk instanceof Uint8Array ? [...chunk] : chunk), [[1, 2], [3]]);
});

test("fetch stream: stream with full resolves to the response, the stream as its body", async () => {
  stubFetch(streamReply(sseParts, sseInit).reply);
  const out = await resolve({ $fetch: "/api/stream", stream: "sse", full: true }, {}) as Record<string, unknown>;
  assert.equal(out.status, 200);
  assert.equal(out.headers && (out.headers as Record<string, string>)["content-type"], "text/event-stream; charset=utf-8");
  const events = await readAll(out.body);
  assert.deepEqual(events[0], { event: "content_block_delta", data: { delta: { text: "Hel" } } });
});

test("fetch stream: with stream, a non-2xx still reaches $catch", async () => {
  stubFetch(streamReply(["{\"message\":\"nope\"}"], { status: 500, headers: { "content-type": "application/json" } }).reply);
  const out = await resolve({ $fetch: "/api/stream", stream: "sse", $catch: [{ $var: "response.body.message" }] }, {});
  assert.equal(out, "nope");
});

test("fetch stream: cancelling the returned stream cancels the body, even mid-read", async () => {
  let cancelled = false;
  // One message, then a body that never sends another: the second read waits on the network.
  stubFetch(() => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("1\n")); },
    pull() { return new Promise(() => undefined); },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/plain" } }));
  const stream = await resolve({ $fetch: "/api/stream", stream: "lines" }, {});
  assert.ok(stream instanceof ReadableStream);
  const reader = stream.getReader();
  assert.deepEqual(await reader.read(), { done: false, value: "1" });
  const pending = reader.read();
  await reader.cancel("gone");
  assert.deepEqual(await pending, { done: true, value: undefined });
  assert.equal(cancelled, true);
});
