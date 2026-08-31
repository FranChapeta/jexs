import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes);

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
      fetch: "/api/me",
      headers: {
        Authorization: { concat: ["Bearer ", { var: "$token" }] },
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

test("fetch: an author Content-Type replaces the JSON default, whatever its casing", async () => {
  const { calls } = stubFetch();
  await resolve(
    {
      fetch: "/api/form",
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
  await resolve({ fetch: "/api/users", method: "POST", body: { name: { var: "$name" } } }, { name: "Ada" });
  assert.equal(sentHeaders(calls[0].init)["content-type"], "application/json");
  assert.equal(calls[0].init.body, "{\"name\":\"Ada\"}");
});

test("fetch: headers named after a handler key are not dispatched as nodes", async () => {
  const { calls } = stubFetch();
  await resolve({ fetch: "/api/me", headers: { var: "$notAPath", if: "cond" } }, {});
  assert.deepEqual(sentHeaders(calls[0].init), { var: "$notAPath", if: "cond" });
});

test("fetch: null/undefined header values are dropped", async () => {
  const { calls } = stubFetch();
  await resolve({ fetch: "/api/me", headers: { Authorization: { var: "$missing" }, Accept: "text/plain" } }, {});
  assert.deepEqual(sentHeaders(calls[0].init), { accept: "text/plain" });
});

test("fetch: a binary body is sent as-is, with no JSON content type", async () => {
  const { calls } = stubFetch();
  const bytes = new Uint8Array([1, 2, 3]);
  await resolve({ fetch: "/api/upload", method: "POST", body: { var: "$bytes" } }, { bytes });
  assert.equal(calls[0].init.body, bytes);
  assert.equal(sentHeaders(calls[0].init)["content-type"], undefined);
});

test("fetch: GET and HEAD never send a body", async () => {
  const { calls } = stubFetch();
  await resolve({ fetch: "/api/thing", body: { a: 1 } }, {});
  await resolve({ fetch: "/api/thing", method: "HEAD", body: { a: 1 } }, {});
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[1].init.body, undefined);
});

test("fetch: a non-2xx status throws an HTTP error catch can branch on", async () => {
  stubFetch(() => new Response("{\"message\":\"nope\"}", { status: 403, statusText: "Forbidden" }));
  const out = await resolve(
    {
      fetch: "/api/secret",
      catch: [{ concat: ["denied with ", { var: "$error.status" }] }],
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
      fetch: "/api/users",
      method: "POST",
      body: { email: "a@b.c" },
      catch: [{ concat: [
        { var: "$error.status" }, " ",
        { var: "$response.body.field" }, " ",
        { var: "$response.body.message" }, " ",
        { var: "$response.headers.x-request-id" }, " ",
        { var: "$response.ok" },
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
    { fetch: "/api/thing", catch: [{ var: "$response.body" }] },
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
    { fetch: "/api/thing", catch: [{ concat: [{ var: "$error.status" }, " ", { var: "$error.message" }] }] },
    {},
  );
  assert.equal(out, "400 GET /api/thing failed with 400: {\"status\":\"ignored\",\"message\":\"ignored\"}");
});

test("fetch: $response is scoped to the catch, leaving the outer one alone", async () => {
  stubFetch(() => new Response("nope", { status: 500 }));
  const ctx: Record<string, unknown> = { response: "mine" };
  const out = await resolve({ fetch: "/api/thing", catch: [{ var: "$response.status" }] }, ctx);
  assert.equal(out, 500);
  assert.equal(ctx.response, "mine");
});

test("fetch: the thrown message carries the failing body", async () => {
  stubFetch(() => new Response("{\n  \"message\": \"nope\"\n}", { status: 500, statusText: "Server Error" }));
  await assert.rejects(
    async () => { await resolve({ fetch: "/api/thing", method: "POST" }, {}); },
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
  const out = await resolve({ fetch: "/api/thing", method: "POST", full: true }, {}) as Record<string, unknown>;
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
    async () => { await resolve({ fetch: "/api/thing", full: true }, {}); },
    (err: Error & { status?: number }) => err.status === 404,
  );
});

test("fetch: throw false resolves the failing body, with or without full", async () => {
  stubFetch(() => new Response("{\"message\":\"gone\"}", {
    status: 404,
    headers: { "content-type": "application/json", "x-request-id": "r1" },
  }));
  assert.deepEqual(await resolve({ fetch: "/api/thing", throw: false }, {}), { message: "gone" });
  const out = await resolve({ fetch: "/api/thing", throw: false, full: true }, {}) as Record<string, unknown>;
  assert.equal(out.status, 404);
  assert.equal(out.ok, false);
  assert.deepEqual(out.body, { message: "gone" });
  assert.equal((out.headers as Record<string, string>)["x-request-id"], "r1");
});

test("fetch: 204 and HEAD resolve to null", async () => {
  stubFetch(() => new Response(null, { status: 204 }));
  assert.equal(await resolve({ fetch: "/api/thing.json", method: "DELETE" }, {}), null);
  stubFetch(() => new Response(null, { headers: { "content-type": "application/json" } }));
  assert.equal(await resolve({ fetch: "/api/thing", method: "HEAD" }, {}), null);
});

test("fetch: an empty JSON body reads as null instead of throwing", async () => {
  stubFetch(() => new Response("", { headers: { "content-type": "application/json" } }));
  assert.equal(await resolve({ fetch: "/api/thing" }, {}), null);
});

test("fetch: type forces decoding over the URL extension and Content-Type", async () => {
  stubFetch(() => new Response("{\"ok\":true}", { headers: { "content-type": "application/json" } }));
  assert.equal(await resolve({ fetch: "/api/thing.json", type: "text" }, {}), "{\"ok\":true}");
  stubFetch(() => new Response("{\"ok\":true}", { headers: { "content-type": "application/octet-stream" } }));
  assert.deepEqual(await resolve({ fetch: "/api/thing", type: "json" }, {}), { ok: true });
});

test("fetch: a +json content type decodes as JSON", async () => {
  stubFetch(() => new Response("{\"title\":\"Bad Request\"}", {
    headers: { "content-type": "application/problem+json" },
  }));
  assert.deepEqual(await resolve({ fetch: "/api/thing", full: true }, {}) as Record<string, unknown>, {
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
      fetch: "/api/slow",
      timeout: 20,
      catch: [{ concat: [{ var: "$error.status" }, " ", { var: "$error.message" }] }],
    },
    {},
  );
  assert.equal(out, "408 GET /api/slow timed out after 20ms");
});

// `throw: false` promises the step won't interrupt the sequence. A timeout that
// still threw would make the promise worthless: you'd need the catch anyway.
test("fetch: throw false covers a timeout too, not just a bad status", async () => {
  stubHang();
  assert.equal(await resolve({ fetch: "/api/slow", timeout: 20, throw: false }, {}), null);
  stubHang();
  // `status: 0` is what marks "no response arrived": the platform's own
  // convention, and the one thing a bare null cannot tell you.
  assert.deepEqual(
    await resolve({ fetch: "/api/slow", timeout: 20, throw: false, full: true }, {}),
    { status: 0, ok: false, headers: {}, body: null, url: "/api/slow" },
  );
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
  assert.deepEqual(await resolve({ fetch: "/api/thing" }, {}), { ok: true });
  const out = await resolve({ fetch: "/api/thing", full: true }, {}) as Record<string, unknown>;
  assert.equal(out.ok, true);
});

test("fetch: a manual redirect is readable with throw false", async () => {
  const { calls } = stubFetch(() => new Response(null, {
    status: 302,
    headers: { location: "/dest" },
  }));
  const out = await resolve(
    { fetch: "/go", redirect: "manual", throw: false, full: true },
    {},
  ) as Record<string, unknown>;
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(out.status, 302);
  assert.equal(out.ok, false);
  assert.equal((out.headers as Record<string, string>).location, "/dest");
});

test("fetch: throw false covers a request that never connects", async () => {
  globalThis.fetch = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
  const out = await resolve({ fetch: "/api/gone", throw: false, full: true }, {}) as Record<string, unknown>;
  assert.equal(out.status, 0);
  assert.equal(out.ok, false);
});

test("fetch: request options pass through", async () => {
  const { calls } = stubFetch();
  await resolve(
    { fetch: "/api/thing", credentials: "include", mode: "cors", redirect: "manual", cache: "no-store" },
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
    async () => { await resolve({ fetch: "/api/thing", credentials: "sometimes" }, {}); },
    { message: "Invalid fetch credentials \"sometimes\": expected omit, same-origin, include" },
  );
  await assert.rejects(
    async () => { await resolve({ fetch: "/api/thing", type: "buffer" }, {}); },
    { message: "Invalid fetch type \"buffer\": expected json, text, binary, blob" },
  );
  // Rejected before the request is made, so a typo costs no round trip.
  assert.equal(calls.length, 0);
});
