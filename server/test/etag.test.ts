import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import type { Resolver } from "@jexs/core";
import { CacheNode } from "../src/nodes/Cache.js";
import { SessionNode } from "../src/nodes/Session.js";
import { ServerNode } from "../src/nodes/Server.js";

let base = "";
let resolver: Resolver;

const at = (path: string) => ({ $eq: [{ $var: "request.path" }, path] });
const form = { $tag: "form", method: "POST", action: "/save", content: [] };
const LONG = "a long page. ".repeat(200);

before(async () => {
  resolver = createResolver([...coreNodes(), new CacheNode(), new SessionNode(), new ServerNode()]);
  const port = await resolver({
    $listen: 0,
    do: [
      { $session: "load" },
      { $if: at("/start"), then: { $session: { seen: true } } },
      { $if: at("/login"), then: { $session: {}, regenerate: true } },
      { $if: at("/other"), then: { $return: "another page" } },
      { $if: at("/long"), then: { $return: LONG } },
      { $if: at("/own"), then: { $return: { response: "page", responseHeaders: { etag: '"v7"' } } } },
      { $if: at("/created"), then: { $return: { response: "page", responseStatus: 201 } } },
      { $if: at("/form"), then: { $return: form } },
      { $if: at("/missing"), then: { $return: null } },
      { response: "page" },
    ],
  }, {});
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  resolver.destroy();
});

const get = (path: string, headers: Record<string, string> = {}, method = "GET") => fetch(base + path, { method, headers });
const tagOf = (res: Response) => res.headers.get("etag") ?? "";
/** The cookies a response set, as a request sends them back. */
const cookiesOf = (res: Response) => res.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");

test("a page carries an ETag, and a client that sends it back is answered 304 without the body", async () => {
  const first = await get("/");
  assert.match(tagOf(first), /^W\/"[\w-]+"$/);
  assert.equal(await first.text(), "page");

  const again = await get("/", { "if-none-match": tagOf(first) });
  assert.equal(again.status, 304);
  assert.equal(await again.text(), "");
  assert.equal(tagOf(again), tagOf(first));
  assert.equal(again.headers.get("content-type"), null);

  // The same body is the same tag, another body another.
  assert.equal(tagOf(await get("/start")), tagOf(first));
  const other = await get("/other");
  assert.notEqual(tagOf(other), tagOf(first));
  assert.equal((await get("/other", { "if-none-match": tagOf(first) })).status, 200);
});

test("only a 200 to a GET or HEAD carries an ETag", async () => {
  assert.ok(tagOf(await get("/", {}, "HEAD")));
  assert.equal(tagOf(await get("/", {}, "POST")), "");
  assert.equal(tagOf(await get("/created")), "");
  assert.equal(tagOf(await get("/missing")), "");
  assert.equal((await get("/", { "if-none-match": "*" }, "POST")).status, 200);
});

test("an ETag the response sets is the one sent and checked", async () => {
  const own = await get("/own");
  assert.equal(tagOf(own), '"v7"');
  assert.equal((await get("/own", { "if-none-match": '"v7"' })).status, 304);
  assert.equal((await get("/own", { "if-none-match": '"v6"' })).status, 200);
});

test("each encoding of a body has its own ETag", async () => {
  const plain = await get("/long", { "accept-encoding": "identity" });
  const gzip = await get("/long", { "accept-encoding": "gzip" });
  assert.equal(gzip.headers.get("content-encoding"), "gzip");
  assert.notEqual(tagOf(plain), tagOf(gzip));

  const again = await get("/long", { "accept-encoding": "gzip", "if-none-match": tagOf(gzip) });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get("vary"), "Accept-Encoding");
  assert.equal((await get("/long", { "accept-encoding": "identity", "if-none-match": tagOf(gzip) })).status, 200);
});

test("a 304 still sets the response's cookies, and keeps them from shared caches", async () => {
  const tag = tagOf(await get("/"));
  const started = await get("/start", { "if-none-match": tag });
  assert.equal(started.status, 304);
  assert.equal(started.headers.getSetCookie().length, 2);
  assert.equal(started.headers.get("cache-control"), 'private="Set-Cookie"');
});

// The token in a form is masked anew on every response, so the bytes differ
// each time; the page is the same until the token itself changes.
test("a page that renders the session's token keeps its ETag until the token changes", async () => {
  const cookie = cookiesOf(await get("/start"));
  const first = await get("/form", { cookie });
  const second = await get("/form", { cookie });
  const bodies = [await first.text(), await second.text()];
  assert.match(bodies[0], /name="_csrf"/);
  assert.notEqual(bodies[0], bodies[1]);
  assert.equal(tagOf(first), tagOf(second));

  const fresh = await get("/form", { cookie, "if-none-match": tagOf(first) });
  assert.equal(fresh.status, 304);
  assert.equal(fresh.headers.get("cache-control"), "private");

  // Another visitor's page is not this one's, and neither is this visitor's
  // from before a login: its token no longer passes.
  const visitor = cookiesOf(await get("/start"));
  assert.notEqual(tagOf(await get("/form", { cookie: visitor })), tagOf(first));
  const loggedIn = cookiesOf(await get("/login", { cookie }));
  assert.equal((await get("/form", { cookie: loggedIn, "if-none-match": tagOf(first) })).status, 200);
});
