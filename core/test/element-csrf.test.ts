import { test } from "node:test";
import assert from "node:assert/strict";
import { CLIENT_SCRIPT, CSRF_TOKEN, createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes());

const form = { $tag: "form", method: "POST", action: "/save", content: [] };
const token = { [CSRF_TOKEN]: "tok" };

test("form: without the client, a POST form carries the session's token", async () => {
  const html = String(await resolve(form, { ...token }));
  assert.match(html, /<input type="hidden" name="_csrf" value="tok">/);
});

// The client adds the token from the cookie when the form is submitted, so the
// page stays the same for every visitor and can be cached.
test("form: a page that loads the client renders no token", async () => {
  const html = String(await resolve(form, { ...token, [CLIENT_SCRIPT]: "/jexs/client.js" }));
  assert.doesNotMatch(html, /_csrf/);
});

test("form: a GET form never carries the token", async () => {
  const html = String(await resolve({ ...form, method: "GET" }, { ...token }));
  assert.doesNotMatch(html, /_csrf/);
});

// Only the runtime sets it: a template's or a session's `_csrf` is just data.
test("form: a token a template could write is not the session's", async () => {
  const html = String(await resolve(form, { _csrf: "forged", session: { _csrf: "forged" } }));
  assert.doesNotMatch(html, /_csrf/);
});
