import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createResolver, coreNodes, Node } from "@jexs/core";
import type { Resolver } from "@jexs/core";
import { ServerNode } from "../src/nodes/Server.js";
import { DeferNode } from "../src/nodes/Defer.js";

let base = "";
let resolver: Resolver;

const at = (path: string) => ({ $eq: [{ $var: "request.path" }, path] });

before(async () => {
  resolver = createResolver([...coreNodes(), new ServerNode()]);
  const port = await resolver({
    $listen: 0,
    do: [
      { $if: at("/created"), then: { $return: { response: { id: 7 }, responseStatus: 201 } } },
      { $if: at("/away"), then: { $return: { response: "/elsewhere", responseType: "redirect" } } },
      { $if: at("/plain"), then: { $return: { response: "<b>", responseType: "text", responseHeaders: { "X-Kind": "plain" } } } },
      { $if: at("/extra"), then: { $return: { response: "hi", note: "not sent" } } },
      // What a delivery step returns, data that has a `response` of its own, sent as a body.
      { $if: at("/report"), then: { $return: { response: { $var: "report" } } } },
      // A step held as data, with a `response` sibling.
      { $if: at("/stored"), then: { $return: { $var: "stored" } } },
      // A response object that is not the steps' value does not end them.
      { $if: at("/later"), then: { response: "early", responseStatus: 500 } },
      { $if: at("/string"), then: { $return: { $concat: ["<p>", "text</p>"] } } },
      { $if: at("/missing"), then: { $return: null } },
      { $if: at("/ip"), then: { $return: { $var: "request.ip" } } },
      { $tag: "p", content: "page" },
    ],
  }, { report: { response: "250 OK", accepted: ["a@b.c"] }, stored: { $email: "a@b.c", response: "x" } });
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  resolver.destroy();
});

test("a response object sets the status, and a body that is not a string is JSON", async () => {
  const res = await fetch(`${base}/created`);
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.deepEqual(await res.json(), { id: 7 });
});

test("a redirect response object sends its body as the Location", async () => {
  const res = await fetch(`${base}/away`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/elsewhere");
});

test("a response object sets the type and headers", async () => {
  const res = await fetch(`${base}/plain`);
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(res.headers.get("x-kind"), "plain");
  assert.equal(await res.text(), "<b>");
});

test("a response object's other keys are not sent", async () => {
  const res = await fetch(`${base}/extra`);
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await res.text(), "hi");
});

test("HTML is sent as text/html, a string as text/plain, and nothing as a 404 page", async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(await page.text(), "<p>page</p>");
  const text = await fetch(`${base}/string`);
  assert.equal(text.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await text.text(), "<p>text</p>");
  const missing = await fetch(`${base}/missing`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("content-type"), "text/html; charset=utf-8");
});

test("a value with a response of its own is sent whole as a response object's body", async () => {
  const res = await fetch(`${base}/report`);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.deepEqual(await res.json(), { response: "250 OK", accepted: ["a@b.c"] });
});

test("a step held as data is sent as JSON, even with a response sibling", async () => {
  const res = await fetch(`${base}/stored`);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.deepEqual(await res.json(), { $email: "a@b.c", response: "x" });
});

test("a page with deferred parts is streamed, each part after the page; any other reply is not", async () => {
  const other = createResolver([...coreNodes(), new ServerNode(), new DeferNode()]);
  try {
    // The part and the loader render as content does: a string as text, HTML as markup.
    const deferred = { $defer: { $var: "late" }, loader: { $tag: "i", content: "wait" } };
    const port = await other({
      $listen: 0,
      do: [
        { $tag: "p", content: [deferred], $as: "page" },
        { $if: at("/json"), then: { $return: { response: { page: { $var: "page" } } } } },
        { $var: "page" },
      ],
    }, { late: "<b>" });
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(page, /^<p><div id="(__jexs_defer_\d+)"><i>wait<\/i><\/div><\/p><script>function __jexs_defer.*<script>__jexs_defer\("\1","&lt;b&gt;"\)<\/script>$/);
    const json = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    assert.match(json.page, /^<p><div id="__jexs_defer_\d+"><i>wait<\/i><\/div><\/p>$/);
  } finally {
    other.destroy();
  }
});

test("the steps' last value is the response, so an earlier response object is not", async () => {
  const res = await fetch(`${base}/later`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(await res.text(), "<p>page</p>");
});

test("request.ip is the client's address", async () => {
  assert.match(await (await fetch(`${base}/ip`)).text(), /127\.0\.0\.1/);
});

test("a client that takes longer than requestTimeout to send its request is answered 408", async () => {
  const own = createResolver([...coreNodes(), new ServerNode()]);
  const port = await own({ $listen: 0, requestTimeout: 200, do: [{ $concat: ["ok"] }] }, {});
  const reply = await new Promise<string>(done => {
    const socket = net.connect(port as number, "127.0.0.1", () => {
      // Headers promising a body that never comes.
      socket.write("POST / HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: 100\r\n\r\npart");
    });
    let data = "";
    socket.on("data", chunk => (data += chunk));
    socket.on("close", () => done(data));
  });
  assert.match(reply, /^HTTP\/1\.1 408/);
  own.destroy();
});

test("a POST that names its method in its URL is answered as that method, and the name is not in the query the steps see", async () => {
  const own = createResolver([...coreNodes(), new ServerNode()]);
  try {
    const port = await own({ $listen: 0, do: [{ response: { method: { $var: "request.method" }, query: { $var: "request.query" } } }] }, {});
    const seen = async (method: string, query: string) => (await fetch(`http://127.0.0.1:${port}/photos/7${query}`, { method })).json();
    assert.deepEqual(await seen("POST", "?_method=PUT&id=7"), { method: "PUT", query: { id: "7" } });
    assert.deepEqual(await seen("POST", "?_method=delete"), { method: "DELETE", query: {} });
    assert.deepEqual(await seen("POST", "?id=7"), { method: "POST", query: { id: "7" } }, "a POST that names none is a POST");
    assert.deepEqual(await seen("POST", "?_method=TRACE"), { method: "POST", query: {} }, "only PUT, PATCH and DELETE are named");
    assert.deepEqual(await seen("GET", "?_method=PUT"), { method: "GET", query: { _method: "PUT" } }, "only a POST stands for another method");
  } finally {
    own.destroy();
  }
});

test("requestTimeout is a whole number of milliseconds", async () => {
  const own = createResolver([...coreNodes(), new ServerNode()]);
  await assert.rejects(Promise.resolve(own({ $listen: 0, requestTimeout: -1, do: [] }, {})), /requestTimeout/);
  own.destroy();
});

/** Names of the `$source` streams that were cancelled, in order. */
const cancelled: string[] = [];
/** What the stream server logged as errors. */
const streamErrors: string[] = [];
let streamBase = "";
let streamResolver: Resolver;

// `$source` yields its values one per read, as bytes with `bytes`, then closes,
// fails (`end: "fail"`) or stays open (`end: "hold"`).
class SourceNode extends Node {
  source(def: Record<string, unknown>) {
    const values = Array.isArray(def.$source) ? [...def.$source] : [];
    const encoder = new TextEncoder();
    return new ReadableStream<unknown>({
      pull(controller) {
        if (values.length > 0) {
          const value = values.shift();
          return controller.enqueue(def.bytes === true ? encoder.encode(String(value)) : value);
        }
        if (def.end === "fail") return controller.error(new Error("source failed"));
        if (def.end === "hold") return new Promise<void>(() => undefined);
        controller.close();
      },
      cancel() { cancelled.push(String(def.name)); },
    }, { highWaterMark: 0 });
  }
}

const upstream = (path: unknown) => ({ $concat: ["http://", { $var: "request.headers.host" }, path] });

/** What background steps of the stream server caught, pushed there by their `$catch`. */
const caught: string[] = [];

// Step lists the routes below run with `$runVar`, so each runs in sequence.
const streamSteps = {
  // Two rounds, each a `$fetch` stream read in the background into one response.
  rounds: [
    { $stream: [], $as: "out" },
    {
      $foreach: ["/sse", "/sse"],
      item: "path",
      do: { $foreach: { $fetch: upstream({ $var: "path" }), stream: "sse" }, do: { $streamWrite: [{ $var: "out" }, { $var: "item" }] } },
      $then: { $streamClose: { $var: "out" } },
    },
    { response: { $var: "out" }, responseType: "sse" },
  ],
  // A `$fetch` stream left in a variable when the request ends.
  left: [
    { $fetch: upstream("/hold"), stream: "sse", $as: "held" },
    { $concat: ["left"] },
  ],
  // A `$stream` never sent, its background writer waiting for room.
  orphan: [
    { $stream: [], $as: "orphan" },
    {
      $foreach: [1, 2],
      do: { $streamWrite: [{ $var: "orphan" }, { $var: "item" }] },
      $then: [],
      $catch: { $push: [{ $var: "caught" }, { $var: "error.message" }] },
    },
    { $concat: ["orphan"] },
  ],
};

before(async () => {
  const log = (message: string) => { streamErrors.push(message); };
  streamResolver = createResolver([...coreNodes(), new ServerNode(), new SourceNode()], { logger: { info: () => {}, warn: () => {}, error: log } });
  const port = await streamResolver({
    $listen: 0,
    do: [
      { $if: at("/sse"), then: { $return: { response: { $source: ["a", { b: 1 }, "two\nlines", null] }, responseType: "sse" } } },
      { $if: at("/ndjson"), then: { $return: { response: { $source: [1, "x", { c: [2] }] }, responseType: "ndjson" } } },
      { $if: at("/text"), then: { $return: { response: { $source: ["a", { b: 1 }] } } } },
      { $if: at("/bytes"), then: { $return: { response: { $source: ["data: raw\n\n", "data: 2\n\n"], bytes: true }, responseType: "sse" } } },
      { $if: at("/hold"), then: { $return: { response: { $source: ["first"], end: "hold", name: "hold" }, responseType: "sse" } } },
      { $if: at("/empty"), then: { $return: { response: { $source: ["unsent"], end: "hold", name: "empty" }, responseStatus: 204 } } },
      { $if: at("/fail"), then: { $return: { response: { $source: ["one"], end: "fail" }, responseType: "sse" } } },
      { $if: at("/relay"), then: { $return: { response: { $fetch: upstream("/sse"), stream: "sse" }, responseType: "sse" } } },
      { $if: at("/relay-bytes"), then: { $return: { response: { $fetch: upstream("/sse"), stream: "binary" }, responseType: "sse" } } },
      { $if: at("/relay-hold"), then: { $return: { response: { $fetch: upstream("/hold"), stream: "sse" }, responseType: "sse" } } },
      { $if: at("/rounds"), then: { $return: { $runVar: "steps.rounds" } } },
      { $if: at("/left"), then: { $return: { $runVar: "steps.left" } } },
      { $if: at("/orphan"), then: { $return: { $runVar: "steps.orphan" } } },
      { $if: at("/nested"), then: { $return: { response: { data: { $stream: [] } } } } },
    ],
  }, { steps: streamSteps, caught });
  streamBase = `http://127.0.0.1:${port}`;
});

after(() => {
  streamResolver.destroy();
});

/** Wait for `check` to hold, failing after a second. */
async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; !check(); tries++) {
    if (tries > 100) throw new Error("timed out waiting");
    await new Promise(r => setTimeout(r, 10));
  }
}

const sseBody = 'data: "a"\n\ndata: {"b":1}\n\ndata: "two\\nlines"\n\ndata: null\n\n';

test("a stream body as sse sends a data event of JSON per value, uncached and unbuffered", async () => {
  const res = await fetch(`${streamBase}/sse`);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(res.headers.get("cache-control"), "no-cache");
  assert.equal(res.headers.get("x-accel-buffering"), "no");
  assert.equal(res.headers.get("content-length"), null);
  assert.equal(await res.text(), sseBody);
});

test("a stream body as ndjson sends a JSON line per value", async () => {
  const res = await fetch(`${streamBase}/ndjson`);
  assert.equal(res.headers.get("content-type"), "application/x-ndjson");
  assert.equal(await res.text(), '1\n"x"\n{"c":[2]}\n');
});

test("a stream body without a type is application/octet-stream: strings as they are, other values as JSON", async () => {
  const res = await fetch(`${streamBase}/text`);
  assert.equal(res.headers.get("content-type"), "application/octet-stream");
  assert.equal(await res.text(), 'a{"b":1}');
});

test("bytes in a stream body go out as they are", async () => {
  assert.equal(await (await fetch(`${streamBase}/bytes`)).text(), "data: raw\n\ndata: 2\n\n");
});

test("a $fetch stream relays, parsed and framed again or as its bytes", async () => {
  assert.equal(await (await fetch(`${streamBase}/relay`)).text(), sseBody);
  assert.equal(await (await fetch(`${streamBase}/relay-bytes`)).text(), sseBody);
  // And a $fetch with onMessage reads the relayed events back as the values sent.
  const ctx = { out: [] as unknown[] };
  await streamResolver({ $fetch: `${streamBase}/relay`, onMessage: [{ $push: [{ $var: "out" }, { $var: "message" }] }] }, ctx);
  assert.deepEqual(ctx.out, ["a", { b: 1 }, "two\nlines", null]);
});

test("a client that disconnects cancels the stream, through a relay to its upstream", async () => {
  for (const path of ["/hold", "/relay-hold"]) {
    cancelled.length = 0;
    const abort = new AbortController();
    const res = await fetch(`${streamBase}${path}`, { signal: abort.signal });
    assert.ok(res.body);
    const reader = res.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: "first"\n\n');
    abort.abort();
    await until(() => cancelled.includes("hold"));
  }
});

test("a stream with no body to send, for HEAD or a 204, is cancelled unread", async () => {
  cancelled.length = 0;
  const head = await fetch(`${streamBase}/hold`, { method: "HEAD" });
  assert.equal(head.headers.get("content-type"), "text/event-stream");
  assert.equal(await head.text(), "");
  const empty = await fetch(`${streamBase}/empty`);
  assert.equal(empty.status, 204);
  await until(() => cancelled.includes("hold") && cancelled.includes("empty"));
});

test("a stream that fails cuts the connection and logs the error", async () => {
  streamErrors.length = 0;
  const res = await fetch(`${streamBase}/fail`);
  await assert.rejects(res.text());
  await until(() => streamErrors.length > 0);
  assert.match(streamErrors[0], /after the response started/);
});

test("a $stream fed by background steps carries several upstream rounds in one response", async () => {
  const res = await fetch(`${streamBase}/rounds`);
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  assert.equal(await res.text(), sseBody + sseBody);
});

test("when a request ends, a $fetch stream it left unread is cancelled, aborting its upstream", async () => {
  cancelled.length = 0;
  assert.equal(await (await fetch(`${streamBase}/left`)).text(), "left");
  await until(() => cancelled.includes("hold"));
});

test("when a request ends, a $stream it never sent is cancelled, so a push waiting on it throws", async () => {
  caught.length = 0;
  assert.equal(await (await fetch(`${streamBase}/orphan`)).text(), "orphan");
  await until(() => caught.length > 0);
  assert.match(caught[0], /cancelled/);
});

test("a stream inside a value sent as JSON is an error, not {}", async () => {
  streamErrors.length = 0;
  const res = await fetch(`${streamBase}/nested`);
  assert.equal(res.status, 500);
  await until(() => streamErrors.length > 0);
});

test("a stream response that writes nothing for streamIdleTimeout is cut", async () => {
  const errors: string[] = [];
  const own = createResolver([...coreNodes(), new ServerNode()], { logger: { info: () => {}, warn: () => {}, error: m => { errors.push(m); } } });
  try {
    const port = await own({ $listen: 0, streamIdleTimeout: 100, do: [{ response: { $stream: ["first"] }, responseType: "sse" }] }, {});
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.ok(res.body);
    const reader = res.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: "first"\n\n');
    const started = Date.now();
    await assert.rejects(async () => { for (;;) if ((await reader.read()).done) return; });
    assert.ok(Date.now() - started < 2000);
    await until(() => errors.length > 0);
    await assert.rejects(Promise.resolve(own({ $listen: 0, streamIdleTimeout: -1, do: [] }, {})), /streamIdleTimeout/);
  } finally {
    own.destroy();
  }
});
