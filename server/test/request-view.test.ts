import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createResolver, coreNodes } from "@jexs/core";
import type { Resolver } from "@jexs/core";
import { CacheNode } from "../src/nodes/Cache.js";
import { ServerNode } from "../src/nodes/Server.js";
import { SessionNode } from "../src/nodes/Session.js";

// What a request's steps see of it: its path as the router reads it, and its
// cookies without the session's HttpOnly one.

let port = 0;
let resolver: Resolver;

before(async () => {
  resolver = createResolver([...coreNodes(), new CacheNode(), new SessionNode(), new ServerNode()]);
  port = await resolver({ $listen: 0, do: [
    { $session: "load" },
    { $if: { $eq: [{ $var: "request.path" }, "/login"] }, then: { $return: { response: { $session: { user: "ada" } }, responseType: "json" } } },
    {
      response: {
        path: { $var: "request.path" },
        cookies: { $var: "request.cookies" },
        header: { $coalesce: [{ $var: "request.headers.cookie" }, null] },
        user: { $coalesce: [{ $var: "session.user" }, null] },
      },
      responseType: "json",
    },
  ] }, {}) as number;
});

after(() => {
  resolver.destroy();
});

/** A GET sent with `path` exactly as written, the way curl --path-as-is sends it. */
function get(path: string, cookie?: string): Promise<{ body: Record<string, unknown>; setCookies: string[] }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers: cookie ? { cookie } : {} }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { text += chunk; });
      res.on("end", () => {
        try {
          resolve({ body: JSON.parse(text), setCookies: res.headers["set-cookie"] ?? [] });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

test("request.path has runs of / collapsed and no trailing /, as the router reads it", async () => {
  assert.equal((await get("/.//admin//invites")).body.path, "/admin/invites");
  assert.equal((await get("/a///b/")).body.path, "/a/b");
  assert.equal((await get("/admin/")).body.path, "/admin");
  assert.equal((await get("/")).body.path, "/");
  assert.equal((await get("//")).body.path, "/");
  // Not a host `admin` and the path `/invites`, as a URL resolved against a base reads it.
  assert.equal((await get("//admin/invites")).body.path, "/admin/invites");
});

test("the session cookie is kept from request.cookies and the cookie header, and still loads the session", async () => {
  const login = await get("/login");
  const pair = (name: string) => login.setCookies.map(line => line.split(";")[0]).find(p => p.startsWith(`${name}=`)) ?? "";
  const sid = pair("sid");
  const csrf = pair("csrf");
  assert.ok(sid, "the login set a session cookie");

  const { body } = await get("/page", `theme=dark; ${sid}; ${csrf}`);
  assert.equal(body.user, "ada", "the session loads from the cookie steps cannot see");
  const cookies = body.cookies as Record<string, string>;
  assert.equal(cookies.theme, "dark");
  assert.equal(cookies.sid, undefined);
  assert.ok(cookies.csrf, "the CSRF cookie, meant for page scripts, is still there");
  assert.ok(!String(body.header).includes(sid.split("=")[1]), "the cookie header leaves the session id out");
  assert.match(String(body.header), /theme=dark/);
});

test("a request whose only cookie is the session's has no cookie header", async () => {
  const { body } = await get("/page", "sid=whatever");
  assert.equal(body.header, null);
  assert.deepEqual(body.cookies, {});
});
