import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createResolver, coreNodes } from "@jexs/core";
import type { Resolver } from "@jexs/core";
import { ServerNode } from "../src/nodes/Server.js";
import { FileNode } from "../src/nodes/File.js";
import { RouterNode } from "../src/nodes/Router.js";
import { SchemaNode } from "../src/nodes/Schema.js";

let root = "";
let manual = "";
let routed = "";
let resolver: Resolver;
const seen: Record<string, unknown> = {};

const record = (key: string, value: unknown) => ({ $setVars: { [`seen.${key}`]: value }, $bubble: true });
const at = (p: string) => ({ $eq: [{ $var: "request.path" }, p] });

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "jexs-body-root-"));
  resolver = createResolver([...coreNodes(), new ServerNode(), new FileNode(root), new RouterNode(), new SchemaNode(root)]);

  // Without the router: a step reads the body, whole with $requestBody or as the stream request.body is.
  const manualPort = await resolver({
    $listen: 0,
    maxBodySize: 4096,
    do: [
      {
        $if: at("/json"),
        then: [
          { $requestBody: { type: "object", required: ["title"], properties: { title: { type: "string" } } }, $as: "body" },
          record("body", { $var: "body" }),
          record("after", { $var: "request.body" }),
          record("raw", { $var: "request.rawBody" }),
        ],
      },
      { $if: at("/any"), then: [{ $requestBody: {}, $as: "body" }, record("body", { $var: "body" }), record("raw", { $var: "request.rawBody" })] },
      {
        // request.body as it is: a stream of bytes, read whole as text and parsed.
        $if: at("/bytes"),
        then: [
          { $parseJSON: { $fromBytes: { $var: "request.body" } }, $as: "parsed" },
          record("parsed", { $var: "parsed" }),
        ],
      },
      { $if: at("/pipe"), then: [{ $file: "/piped.bin", write: { $var: "request.body" } }] },
      { $if: at("/twice"), then: [{ $requestBody: {} }, { $requestBody: { type: "object", required: ["title"] }, $as: "second" }, record("body", { $var: "second" })] },
      { $concat: ["ok"] },
    ],
  }, { seen });

  // With the router: it reads the body for the handler it reaches, by the handler's body.
  const routedPort = await resolver({
    $listen: 0,
    do: [{
      $routes: {
        children: {
          leave: { methods: { POST: { do: [{ $concat: ["left"] }] } } },
          title: { methods: { POST: { do: [{ $var: "request.body.title" }] } } },
          raw: { methods: { POST: { do: [{ $var: "request.rawBody" }] } } },
          whole: { methods: { POST: { do: [{ $var: "request.body" }] }, GET: { do: [{ $var: "request.body" }] } } },
          strict: { methods: { POST: { body: { type: "object", properties: { title: { type: "string" } } }, do: [{ $var: "request.body.title" }] } } },
          checked: { methods: { POST: { queryParams: { type: "object", required: ["id"] }, body: { type: "object", required: ["title"] }, do: [{ $concat: ["checked"] }] } } },
        },
      },
    }],
  }, { seen });
  manual = `http://127.0.0.1:${manualPort}`;
  routed = `http://127.0.0.1:${routedPort}`;
});

after(async () => {
  resolver.destroy();
  await fs.rm(root, { recursive: true, force: true });
});

const send = (url: string, type: string, body: BodyInit, method = "POST") => fetch(url, { method, headers: { "content-type": type }, body });

// ── Reading the body whole, without a router ──

test("$requestBody reads the body, parsed by its content type, checks it, and makes it request.body", async () => {
  assert.equal(await (await send(`${manual}/json`, "application/json", '{"title":"Report"}')).text(), "ok");
  assert.deepEqual(seen.body, { title: "Report" });
  assert.deepEqual(seen.after, { title: "Report" });
  assert.equal(seen.raw, '{"title":"Report"}');
  assert.equal(await (await send(`${manual}/json`, "application/x-www-form-urlencoded", "title=Report&n=1")).text(), "ok");
  assert.deepEqual(seen.body, { title: "Report", n: "1" });
});

test("a body that fails the schema, or doesn't parse, is a 400, and one past maxBodySize a 413", async () => {
  const missing = await send(`${manual}/json`, "application/json", '{"other":1}');
  assert.equal(missing.status, 400);
  assert.match(await missing.text(), /title/);
  assert.equal((await send(`${manual}/json`, "application/json", '{"title":7}')).status, 400);
  assert.equal((await send(`${manual}/json`, "application/json", "{not json")).status, 400);
  assert.equal((await send(`${manual}/any`, "application/json", JSON.stringify({ big: "x".repeat(5000) }))).status, 413);
});

test("a text body, a CSP report or YAML is read as its text, and a request without a body as {}", async () => {
  for (const type of ["text/plain", "application/csp-report", "application/yaml"]) {
    const text = '{"csp-report":{"blocked-uri":"inline"}}';
    assert.equal(await (await send(`${manual}/any`, type, text)).text(), "ok");
    assert.equal(seen.body, text, type);
    assert.equal(seen.raw, text, type);
  }
  assert.equal(await (await fetch(`${manual}/any`)).text(), "ok");
  assert.deepEqual(seen.body, {});
});

test("a request is answered by its head: a body no step reads is never read or parsed", async () => {
  assert.equal(await (await send(`${manual}/none`, "application/json", "{not json")).text(), "ok");
  assert.equal(await (await send(`${manual}/none`, "application/json", JSON.stringify({ big: "x".repeat(5000) }))).text(), "ok", "past maxBodySize");
});

test("a body read whole and read again is checked as it stands", async () => {
  assert.equal(await (await send(`${manual}/twice`, "application/json", '{"title":"Report"}')).text(), "ok");
  assert.deepEqual(seen.body, { title: "Report" });
  assert.equal((await send(`${manual}/twice`, "application/json", '{"other":1}')).status, 400);
});

// ── request.body as a stream ──

test("until it is read whole, request.body is a stream of the body's bytes, which $fromBytes reads whole as text", async () => {
  // Sent in pieces that split a character in two, which reading each piece on its own would break.
  const bytes = Buffer.from('{"title":"Señor café"}');
  const cut = bytes.indexOf(0xc3) + 1;
  const pieces = [bytes.subarray(0, cut), bytes.subarray(cut)];
  const body = new ReadableStream({ pull(c) { const next = pieces.shift(); if (next) c.enqueue(next); else c.close(); } });
  const res = await fetch(`${manual}/bytes`, { method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half" } as RequestInit);
  assert.equal(await res.text(), "ok");
  assert.deepEqual(seen.parsed, { title: "Señor café" });
});

test("a $file write of request.body streams the body's bytes to the file, however many there are", async () => {
  const bytes = Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 251));
  assert.equal(await (await send(`${manual}/pipe`, "application/octet-stream", bytes, "PUT")).text(), "ok");
  assert.deepEqual(await fs.readFile(path.join(root, "piped.bin")), bytes, "past maxBodySize, which does not limit a stream");
});

// ── With the router ──

test("a route reads the body for the handler it reaches, so its steps read request.body", async () => {
  const json = (p: string) => send(`${routed}${p}`, "application/json", '{"title":"Report"}');
  assert.equal(await (await json("/title")).text(), "Report");
  assert.equal(await (await json("/raw")).text(), '{"title":"Report"}');
  assert.deepEqual(await (await json("/whole")).json(), { title: "Report" });
  assert.deepEqual(await (await fetch(`${routed}/whole`)).json(), {}, "a request without a body has {}");
});

test("a route checks the body against its handler's body as it reads it, and a request no route takes has its body left unread", async () => {
  assert.equal((await send(`${routed}/strict`, "application/json", '{"title":7}')).status, 400);
  assert.equal(await (await send(`${routed}/strict`, "application/json", '{"title":"Report"}')).text(), "Report");
  assert.equal((await send(`${routed}/leave`, "application/json", "{not json")).status, 400, "a handler's body is read, schema or not");
  assert.equal((await send(`${routed}/nowhere`, "application/json", "{not json")).status, 404);
});

test("a route checks its queryParams before it reads the body", async () => {
  const refused = await send(`${routed}/checked`, "application/json", "{not json");
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /id/, "the query is what refused it, the body unread");
  assert.equal(await (await send(`${routed}/checked?id=1`, "application/json", '{"title":"Report"}')).text(), "checked");
});

// ── Without a request ──

test("with no connection to read, $requestBody checks the body the request has", async () => {
  const own = createResolver([...coreNodes(), new ServerNode(), new SchemaNode(root)]);
  const schema = { type: "object", required: ["title"] };
  assert.deepEqual(await own({ $requestBody: schema }, { request: { body: { title: "Report" } } }), { title: "Report" });
  await assert.rejects(Promise.resolve(own({ $requestBody: schema }, { request: { body: {} } })), /title/);
  own.destroy();
});
