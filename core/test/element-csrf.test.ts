import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes());

const form = { $tag: "form", method: "POST", action: "/save", content: [] };
const session = { _csrf: "tok" };

test("form: without the client, a POST form carries the session's token", async () => {
  const html = String(await resolve(form, { session }));
  assert.match(html, /<input type="hidden" name="_csrf" value="tok">/);
});

// The client adds the token from the cookie when the form is submitted, so the
// page stays the same for every visitor and can be cached.
test("form: a page that loads the client renders no token", async () => {
  const html = String(await resolve(form, { session, _clientScript: "/jexs/client.js" }));
  assert.doesNotMatch(html, /_csrf/);
});

test("form: a GET form never carries the token", async () => {
  const html = String(await resolve({ ...form, method: "GET" }, { session }));
  assert.doesNotMatch(html, /_csrf/);
});
