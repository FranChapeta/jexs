import { test } from "node:test";
import assert from "node:assert/strict";
import { CSRF_TOKEN, createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes());
const render = async (form: Record<string, unknown>, context: Record<PropertyKey, unknown> = {}) =>
  String(await resolve({ $tag: "form", content: [], ...form }, context));

test("form: a method a browser cannot send is rendered as a POST whose action names it", async () => {
  for (const method of ["PUT", "patch", "Delete"]) {
    const html = await render({ method, action: "/photos/7" });
    assert.match(html, / method="post"/, method);
    assert.match(html, new RegExp(` action="/photos/7\\?_method=${method.toUpperCase()}"`), method);
  }
});

test("form: the method joins a query the action has, ahead of its fragment", async () => {
  assert.match(await render({ method: "PUT", action: "/photos?page=2" }), / action="\/photos\?page=2&amp;_method=PUT"/);
  assert.match(await render({ method: "PUT", action: "/photos#top" }), / action="\/photos\?_method=PUT#top"/);
});

test("form: without an action, one is written that posts to the page's path", async () => {
  const html = await render({ method: "DELETE" });
  assert.match(html, / method="post"/);
  assert.match(html, / action="\?_method=DELETE"/);
});

test("form: the method and action may be expressions", async () => {
  const html = await render({ method: { $var: "verb" }, action: { $concat: ["/photos/", { $var: "id" }] } }, { verb: "put", id: 7 });
  assert.match(html, / method="post" action="\/photos\/7\?_method=PUT"/);
});

test("form: GET and POST are rendered as written", async () => {
  assert.match(await render({ method: "POST", action: "/save" }), / method="POST" action="\/save"/);
  assert.match(await render({ method: "get", action: "/search" }), / method="get" action="\/search"/);
  assert.doesNotMatch(await render({ action: "/search" }), /_method/);
});

test("form: without the client, one written with PUT still carries the session's token", async () => {
  assert.match(await render({ method: "PUT", action: "/save" }, { [CSRF_TOKEN]: "tok" }), /name="_csrf" value="tok"/);
});
