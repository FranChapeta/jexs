import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import type { Resolver } from "@jexs/core";
import { CacheNode } from "../src/nodes/Cache.js";
import { ServerNode } from "../src/nodes/Server.js";
import { SessionNode } from "../src/nodes/Session.js";

// What a page might try against the request it answers, by path. Each answers
// with the error it met.
const attempts: Record<string, unknown> = {
  "/bind-session": { $setVars: { session: { role: "admin" } } },
  "/as-session": { $foreach: [1], do: [{ $concat: ["admin"], $as: "session" }] },
  "/item-session": { $map: [1], item: "session", do: { $var: "session" } },
  "/write-session": { $setVars: { "session.role": "admin" } },
  "/bind-request": { $setVars: { request: { method: "GET" } } },
  "/write-method": { $setVars: { "request.method": "GET" } },
  "/write-header": { $setVars: { "request.headers.x-csrf-token": "forged" } },
  "/write-cookie": { $setVars: { "request.cookies.sid": "someone-else" } },
};

const at = (path: string) => ({ $eq: [{ $var: "request.path" }, path] });
const orDash = (path: string) => ({ $coalesce: [{ $var: path }, "-"] });

let base = "";
let resolver: Resolver;

before(async () => {
  resolver = createResolver([...coreNodes(), new CacheNode(), new SessionNode(), new ServerNode()]);
  const port = await resolver({ $listen: 0, do: [
    // Before the session loads, so the check would see the copied token.
    { $if: at("/forge"), then: { $setVars: { "request.body._csrf": { $var: "request.cookies.csrf" } } } },
    { $session: "load" },
    ...Object.entries(attempts).map(([path, step]) => ({
      $if: at(path), then: { ...(step as object), $catch: { $return: { $var: "error.message" } } },
    })),
    { $if: at("/extend"), then: { $setVars: { "request.locale": "en", "request.query.page": "2" } } },
    // Set in a scope of its own, and read after it.
    { $if: at("/login"), then: { $foreach: [1], do: [{ $session: { role: "user" } }] } },
    { $concat: [orDash("request.locale"), "|", orDash("request.query.page"), "|", orDash("session.role")] },
  ] }, {});
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  resolver.destroy();
});

/** A request with the cookies a session's responses set, kept as a browser would. */
function browser() {
  const jar = new Map<string, string>();
  return async (path: string, init: RequestInit = {}) => {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    const res = await fetch(base + path, { ...init, headers: { ...init.headers as object, cookie } });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const [name, value] = pair.split("=");
      jar.set(name, value);
    }
    return { status: res.status, text: await res.text(), csrf: jar.get("csrf") ?? "" };
  };
}

test("a step can't bind `request` or `session` anew, or change what the session ops trust", async () => {
  const visit = browser();
  await visit("/login");
  for (const path of Object.keys(attempts)) {
    const { text } = await visit(path);
    assert.match(text, /read-only/, path);
  }
});

test("the rest of `request` is the steps' to change and add to", async () => {
  assert.equal((await browser()("/extend?page=1")).text, "en|2|-");
});

test("`session` holds what a `$session` op set in any scope, and a write to it changes nothing stored", async () => {
  const visit = browser();
  assert.equal((await visit("/login")).text, "-|-|user");
  assert.match((await visit("/write-session")).text, /"session" is read-only data/);
  assert.equal((await visit("/")).text, "-|-|user");
});

test("a CSRF token a step copies into the body is not the one the request sent", async () => {
  const visit = browser();
  const { csrf } = await visit("/login");
  const forged = await visit("/forge", { method: "POST" });
  assert.equal(forged.status, 403);
  assert.match(forged.text, /CSRF token mismatch/);
  const sent = await visit("/", { method: "POST", headers: { "x-csrf-token": csrf } });
  assert.equal(sent.text, "-|-|user");
});
