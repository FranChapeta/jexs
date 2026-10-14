import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
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
      { $concat: ["<p>page</p>"] },
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
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(await res.text(), "hi");
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
    const deferred = { $defer: { $concat: ["late"] }, loader: { $concat: ["wait"] } };
    const port = await other({
      $listen: 0,
      do: [
        { $concat: ["<p>", deferred, "</p>"], $as: "page" },
        { $if: at("/json"), then: { $return: { response: { page: { $var: "page" } } } } },
        { $var: "page" },
      ],
    }, {});
    const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(page, /^<p><div id="(__jexs_defer_\d+)">wait<\/div><\/p><script>function __jexs_defer.*<script>__jexs_defer\("\1","late"\)<\/script>$/);
    const json = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    assert.match(json.page, /^<p><div id="__jexs_defer_\d+">wait<\/div><\/p>$/);
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
