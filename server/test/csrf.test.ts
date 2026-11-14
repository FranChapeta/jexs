import { test } from "node:test";
import assert from "node:assert/strict";
import { CSRF_TOKEN, createResolver, coreNodes, type Context } from "@jexs/core";
import { COOKIES } from "../src/context.js";
import { CacheNode } from "../src/nodes/Cache.js";
import { SessionNode } from "../src/nodes/Session.js";
import { ServerNode } from "../src/nodes/Server.js";

// No router here: the session itself checks the token, so an app that handles
// requests without `$routes`, or loads the session late, is still covered.

type Resolver = ReturnType<typeof createResolver>;

const request = (method: string, cookies: Record<string, string>, extra: Record<string, unknown> = {}): Context => ({
  request: { method, path: "/", cookies, headers: {}, body: {}, ...extra },
  [COOKIES]: [],
});

/** The Set-Cookie lines a request queued, and the session token its page renders (masked). */
const cookiesOf = (ctx: Context) => ctx[COOKIES] as string[];
const tokenOf = (ctx: Context) => String(ctx[CSRF_TOKEN] ?? "");
/** The session id the last `sid` cookie a request queued carries. */
const sidOf = (ctx: Context) => cookiesOf(ctx).map(c => c.match(/^sid=([^;]+)/)?.[1]).filter(Boolean).pop() ?? "";

/** A resolver holding one started session, with its id and token. */
async function started(): Promise<{ resolver: Resolver; context: Context; sid: string; token: string }> {
  const context: Context = {};
  const resolver = createResolver([...coreNodes(), new CacheNode(), new SessionNode()], { context });
  const first = request("GET", {});
  await resolver([{ $session: "load" }, { $session: { user: "ada" } }], first);
  const sid = cookiesOf(first).join(";").match(/sid=([^;]+)/)?.[1] ?? "";
  const token = tokenOf(first);
  assert.ok(sid && token, "a session with a token was started");
  return { resolver, context, sid, token };
}

const stored = async (context: Context, sid: string) =>
  (await CacheNode.cacheFor(context).get<{ data: Record<string, unknown> }>(`session:${sid}`))?.data;

test("a POST with the session cookie and no token is refused by every session op", async () => {
  const { resolver, context, sid } = await started();
  try {
    for (const op of ["load", "destroy", { role: "admin" }]) {
      await assert.rejects(
        async () => resolver({ $session: op }, request("POST", { sid })),
        (e: Error & { status?: number }) => e.status === 403,
        `$session: ${JSON.stringify(op)}`,
      );
    }
    const left = await stored(context, sid);
    assert.equal(left?.user, "ada", "not destroyed");
    assert.equal(left?.role, undefined, "not written");
  } finally {
    resolver.destroy();
  }
});

test("a wrong token is refused", async () => {
  const { resolver, sid, token } = await started();
  try {
    const wrong = token.replace(/./, c => (c === "0" ? "1" : "0"));
    await assert.rejects(
      async () => resolver({ $session: "load" }, request("POST", { sid }, { headers: { "x-csrf-token": wrong } })),
      /CSRF token mismatch/,
    );
  } finally {
    resolver.destroy();
  }
});

test("the right token in the header loads the session, and one in the body is not read", async () => {
  const { resolver, sid, token } = await started();
  try {
    for (const method of ["POST", "DELETE"]) {
      const inHeader = request(method, { sid }, { headers: { "x-csrf-token": token } });
      await resolver({ $session: "load" }, inHeader);
      assert.equal(inHeader.session?.user, "ada", method);
    }
    await assert.rejects(
      async () => resolver({ $session: "load" }, request("POST", { sid }, { body: { _csrf: token } })),
      /CSRF token mismatch/,
    );
  } finally {
    resolver.destroy();
  }
});

test("a login moves the session to a new id and token, keeping its data, in one step", async () => {
  const { resolver, context, sid, token } = await started();
  try {
    const login = request("POST", { sid }, { headers: { "x-csrf-token": token } });
    await resolver({ $session: { user_id: 7 }, regenerate: true }, login);
    const newSid = sidOf(login);
    assert.notEqual(newSid, sid);
    const data = await stored(context, newSid);
    assert.equal(data?.user_id, 7);
    assert.equal(data?.user, "ada", "data from before the login is kept");
    assert.notEqual(tokenOf(login), token);
    assert.equal(data?._csrf, undefined, "the token is not session data");
    assert.equal(await stored(context, sid), undefined);
  } finally {
    resolver.destroy();
  }
});

// Regenerating rotates the token the request was sent with, so the ops after
// it in the same request must not check again.
test("ops after a rotation in the same POST are not checked again", async () => {
  const { resolver, context, sid, token } = await started();
  try {
    const login = request("POST", { sid }, { headers: { "x-csrf-token": token } });
    await resolver([{ $session: {}, regenerate: true }, { $session: { user_id: 7 } }], login);
    const newSid = sidOf(login);
    assert.equal((await stored(context, newSid))?.user_id, 7);
  } finally {
    resolver.destroy();
  }
});

test("a POST without a session cookie is not checked", async () => {
  const { resolver } = await started();
  try {
    const anonymous = request("POST", {});
    const result = await resolver({ $session: { user: "grace" } }, anonymous);
    assert.equal(anonymous.session?.user, "grace");
    assert.equal(result, anonymous.session);
  } finally {
    resolver.destroy();
  }
});

test("a request that loaded its session writes to it without reading the cache again", async t => {
  const { resolver, context, sid, token } = await started();
  try {
    const get = t.mock.method(CacheNode.cacheFor(context), "get");
    const ctx = request("POST", { sid }, { headers: { "x-csrf-token": token } });
    await resolver([{ $session: "load" }, { $session: { a: 1 } }, { $session: { b: 2 } }], ctx);
    assert.equal(get.mock.callCount(), 1);
    const data = await stored(context, sid);
    assert.equal(data?.a, 1);
    assert.equal(data?.b, 2);
  } finally {
    resolver.destroy();
  }
});

// The id stays in its HttpOnly cookie: no op hands it to the template, where it
// could end up in a page or a log.
test("session ops return the session's data, and destroy returns null", async () => {
  const { resolver, sid, token } = await started();
  try {
    const ctx = request("POST", { sid }, { headers: { "x-csrf-token": token } });
    const loaded = await resolver({ $session: "load" }, ctx);
    assert.equal(loaded, ctx.session);
    assert.equal(ctx.session?.user, "ada");

    const login = await resolver({ $session: { role: "admin" }, regenerate: true }, ctx);
    assert.equal(login, ctx.session);
    assert.equal(ctx.session?.role, "admin");
    assert.ok(!JSON.stringify(login).includes(ctx.request?.cookies?.sid ?? "no sid"), "the session id is not returned");

    assert.equal(await resolver({ $session: "destroy" }, ctx), null);
  } finally {
    resolver.destroy();
  }
});

// Nothing is stored under the cookie, as after a memory-cache restart.
test("a POST with a session cookie the cache doesn't know is not checked", async () => {
  const { resolver } = await started();
  try {
    const stale = request("POST", { sid: "gone" });
    await resolver([{ $session: "load" }, { $session: {}, regenerate: true }], stale);
    assert.ok(tokenOf(stale));
    assert.ok(sidOf(stale));
    assert.notEqual(sidOf(stale), "gone");
  } finally {
    resolver.destroy();
  }
});

// A planted cookie must not choose the victim's session id (session fixation).
test("a session id the server didn't issue is never adopted", async () => {
  const { resolver, context } = await started();
  try {
    const viaLoad = request("GET", { sid: "planted" });
    await resolver({ $session: "load" }, viaLoad);
    assert.deepEqual(cookiesOf(viaLoad), [], "reading it starts nothing");

    const viaSet = request("POST", { sid: "planted" });
    await resolver({ $session: { user: "eve" } }, viaSet);
    assert.ok(sidOf(viaSet) && sidOf(viaSet) !== "planted", "a new id was issued");
    assert.equal(await stored(context, "planted"), undefined);
  } finally {
    resolver.destroy();
  }
});

// A visitor with nothing stored is sent no cookie, so their page is anyone's and
// a cache may keep it; a crawler, which never returns one, costs no session.
test("reading a session starts none, and setting a value does", async () => {
  const context: Context = {};
  const resolver = createResolver([...coreNodes(), new CacheNode(), new SessionNode()], { context });
  try {
    const view = request("GET", {});
    assert.deepEqual(await resolver({ $session: "load" }, view), {});
    assert.deepEqual(cookiesOf(view), []);
    assert.equal(view.session, undefined);
    assert.equal(tokenOf(view), "", "no token to render");

    const set = request("GET", {});
    await resolver([{ $session: "load" }, { $session: { theme: "dark" } }], set);
    assert.equal(cookiesOf(set).length, 2, "the session's id and its token");
    assert.equal((await stored(context, sidOf(set)))?.theme, "dark");
  } finally {
    resolver.destroy();
  }
});

test("safe methods are not checked", async () => {
  const { resolver, sid } = await started();
  try {
    for (const method of ["GET", "HEAD", "OPTIONS", "WS"]) {
      const ctx = request(method, { sid });
      await resolver({ $session: "load" }, ctx);
      assert.equal(ctx.session?.user, "ada", method);
    }
  } finally {
    resolver.destroy();
  }
});

// The shape that went unchecked before: the session is loaded partway through
// the request's steps, not ahead of a router.
test("steps that load the session late are still refused without a token", async () => {
  const { resolver, sid } = await started();
  try {
    const ctx = request("POST", { sid });
    await assert.rejects(
      async () => resolver([
        { $concat: ["before"], $as: "seen" },
        { $session: "load" },
        { $concat: ["after"], $as: "reached" },
      ], ctx),
      /CSRF token mismatch/,
    );
    assert.equal(ctx.seen, "before");
    assert.equal(ctx.reached, undefined);
  } finally {
    resolver.destroy();
  }
});

// A browser marks where a request came from in a header no page can set, so
// one it marks as the app's own needs no token.
test("a POST the browser marks same-origin passes without a token; one from elsewhere, or unmarked, needs it", async () => {
  const { resolver, context, sid } = await started();
  try {
    const from = (site?: string) => request("POST", { sid }, { headers: site ? { "sec-fetch-site": site } : {} });
    for (const site of ["same-site", "cross-site", "none", undefined]) {
      await assert.rejects(async () => resolver({ $session: { role: "admin" } }, from(site)), /CSRF token mismatch/, String(site));
    }
    await resolver({ $session: { role: "admin" } }, from("same-origin"));
    assert.equal((await stored(context, sid))?.role, "admin");
  } finally {
    resolver.destroy();
  }
});

// A browser that sends no such mark still names the page's origin on a POST.
test("without the mark, an Origin whose host the request was sent to passes, and another's does not", async () => {
  const { resolver, context, sid } = await started();
  try {
    const from = (headers: Record<string, string>, extra: Record<string, unknown> = {}) => request("POST", { sid }, { headers, ...extra });
    const refused = [
      from({ host: "app.test", origin: "https://evil.test" }),
      from({ host: "app.test", origin: "null" }),
      // The mark, when there is one, decides: an Origin beside it is not asked.
      from({ host: "app.test", origin: "https://app.test", "sec-fetch-site": "cross-site" }),
    ];
    for (const ctx of refused) await assert.rejects(async () => resolver({ $session: { role: "admin" } }, ctx), /CSRF token mismatch/);
    await resolver({ $session: { role: "admin" } }, from({ host: "app.test", origin: "https://app.test" }));
    assert.equal((await stored(context, sid))?.role, "admin");
    // Behind a proxy the request's own Host is the proxy's: the app's URL names the host its pages are on.
    const proxied = from({ host: "10.0.0.5:3000", origin: "http://app.test" });
    await assert.rejects(async () => resolver({ $session: { plan: "pro" } }, from({ host: "10.0.0.5:3000", origin: "http://app.test" })), /CSRF token mismatch/);
    proxied.baseUrl = "http://app.test";
    await resolver({ $session: { plan: "pro" } }, proxied);
    assert.equal((await stored(context, sid))?.plan, "pro");
  } finally {
    resolver.destroy();
  }
});

test("through a listener, a token in the body is not taken, and a browser's own headers pass without one", async () => {
  const resolver = createResolver([...coreNodes(), new CacheNode(), new SessionNode(), new ServerNode()]);
  try {
    const port = await resolver({
      $listen: 0,
      do: [
        { $if: { $eq: [{ $var: "request.method" }, "GET"] }, then: { $session: { user: "ada" } }, else: { $session: { seen: true } } },
        { $concat: ["ok"] },
      ],
    }, {});
    const url = `http://127.0.0.1:${port}/`;
    const set = (await fetch(url)).headers.getSetCookie().join(";");
    const sid = set.match(/sid=([^;]+)/)?.[1] ?? "";
    const token = decodeURIComponent(set.match(/csrf=([^;]+)/)?.[1] ?? "");
    assert.ok(sid && token, "a session with a token was started");
    const post = (body: string, headers: Record<string, string> = {}) =>
      fetch(url, { method: "POST", headers: { cookie: `sid=${sid}`, "content-type": "application/x-www-form-urlencoded", ...headers }, body });

    assert.equal((await post("title=x")).status, 403);
    assert.equal((await post(`_csrf=${encodeURIComponent(token)}&title=x`)).status, 403);
    assert.equal(await (await post("title=x", { "x-csrf-token": token })).text(), "ok");
    assert.equal(await (await post("title=x", { "sec-fetch-site": "same-origin" })).text(), "ok");
    assert.equal(await (await post("title=x", { origin: `http://127.0.0.1:${port}` })).text(), "ok");
  } finally {
    resolver.destroy();
  }
});

// Over https the cookies are Secure, and the session's is `__Host-sid`, which a
// browser takes only from this exact host, so a sibling subdomain can't plant one.
test("on an https app the session cookie is Secure and host-only", async () => {
  const { resolver } = await started();
  try {
    const first = { ...request("GET", {}), baseUrl: "https://app.example" };
    await resolver([{ $session: "load" }, { $session: { user: "ada" } }], first);
    const line = cookiesOf(first).find(c => c.startsWith("__Host-sid=")) ?? "";
    assert.match(line, /; Secure/);
    assert.match(line, /; Path=\//);
    assert.ok(cookiesOf(first).every(c => /; Secure/.test(c)), "the csrf cookie is Secure too");

    const sid = line.slice("__Host-sid=".length, line.indexOf(";"));
    const again = { ...request("GET", { "__Host-sid": sid }), baseUrl: "https://app.example" };
    await resolver({ $session: "load" }, again);
    assert.equal(again.session?.user, "ada");

    const plain = request("GET", {});
    await resolver({ $session: {} }, plain);
    assert.ok(cookiesOf(plain).some(c => c.startsWith("sid=") && !/Secure/.test(c)), "plain http in development keeps `sid`");
  } finally {
    resolver.destroy();
  }
});

/** The `csrf` cookie a response queued, as its raw Set-Cookie line, and the token it carries. */
const csrfCookie = (ctx: Context) => cookiesOf(ctx).find(c => c.startsWith("csrf="));
const secretOf = (ctx: Context) => csrfCookie(ctx)?.match(/^csrf=([^;]*)/)?.[1] ?? "";

// The token reaches page scripts in a cookie, not in the HTML, so `$fetch` can
// send it back while the page itself stays cacheable.
test("the CSRF token is handed to page scripts in a readable cookie", async () => {
  const context: Context = {};
  const resolver = createResolver([...coreNodes(), new CacheNode(), new SessionNode()], { context });
  try {
    const first = request("GET", {});
    await resolver({ $session: {} }, first);
    const token = secretOf(first);
    assert.match(token, /^[0-9a-f]{64}$/, "the cookie carries the session's token");
    assert.ok(!/HttpOnly/i.test(csrfCookie(first) ?? ""), "page scripts can read it");
    assert.match(cookiesOf(first).find(c => c.startsWith("sid=")) ?? "", /HttpOnly/, "the session id stays out of reach");

    // A browser already holding the current token isn't sent it again.
    const sid = sidOf(first);
    const again = request("GET", { sid, csrf: token });
    await resolver({ $session: "load" }, again);
    assert.equal(csrfCookie(again), undefined);

    // A rotation sends the new one; logging out clears it.
    const login = request("POST", { sid, csrf: token }, { headers: { "x-csrf-token": token } });
    await resolver({ $session: {}, regenerate: true }, login);
    assert.match(secretOf(login), /^[0-9a-f]{64}$/);
    assert.notEqual(secretOf(login), token);

    const logout = request("POST", { sid: sidOf(login) }, { headers: { "x-csrf-token": secretOf(login) } });
    await resolver({ $session: "destroy" }, logout);
    assert.match(csrfCookie(logout) ?? "", /^csrf=;.*Max-Age=0/);
  } finally {
    resolver.destroy();
  }
});

// A compressed page that repeated the token would leak it to an attacker who
// echoes guesses into the page and watches its size (BREACH).
test("the token a page renders is masked anew on every response, and both forms pass", async () => {
  const context: Context = {};
  const resolver = createResolver([...coreNodes(), new CacheNode(), new SessionNode()], { context });
  try {
    const first = request("GET", {});
    await resolver({ $session: {} }, first);
    const secret = secretOf(first);
    const sid = sidOf(first);

    const second = request("GET", { sid, csrf: secret });
    await resolver({ $session: "load" }, second);
    const rendered = [tokenOf(first), tokenOf(second)];
    assert.notEqual(rendered[0], rendered[1]);
    for (const masked of rendered) assert.ok(masked && !masked.includes(secret), "the token is not in what the page renders");

    // Each masked copy, as a form sends it, and the token itself, as $fetch sends it from the cookie.
    for (const sent of [...rendered, secret]) {
      const post = request("POST", { sid, csrf: secret }, { headers: { "x-csrf-token": sent } });
      await resolver({ $session: "load" }, post);
      assert.ok(post.session, sent);
    }

    // A masked copy of another session's token is not this one's.
    const other = request("GET", {});
    await resolver({ $session: {} }, other);
    await assert.rejects(
      async () => resolver({ $session: "load" }, request("POST", { sid }, { headers: { "x-csrf-token": tokenOf(other) } })),
      /CSRF token mismatch/,
    );
  } finally {
    resolver.destroy();
  }
});

/**
 * A server whose every request loads the session, and whose `/start` and
 * `/start/public` store a value in it; and the cookies a visit to `/start` is handed.
 */
async function sessionServer(resolver: Resolver, routes: Record<string, unknown>): Promise<{ get: (path: string, cookie?: string) => Promise<Response>; visit: () => Promise<string> }> {
  const at = (path: string) => ({ $eq: [{ $var: "request.path" }, path] });
  const port = await resolver({
    $listen: 0,
    do: [
      { $session: "load" },
      { $if: at("/start"), then: { $session: { seen: true } } },
      { $if: at("/start/public"), then: { $session: { seen: true } } },
      ...Object.entries(routes).map(([path, response]) => ({ $if: at(path), then: { $return: response } })),
      { response: "page" },
    ],
  }, {});
  const get = (path: string, cookie?: string) => fetch(`http://127.0.0.1:${port}${path}`, cookie ? { headers: { cookie } } : {});
  const visit = async () => (await get("/start")).headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  return { get, visit };
}

const PUBLIC = { "Cache-Control": "public, max-age=60" };

test("a page goes out as cacheable as it says, and a response that sets a cookie keeps the cookie from shared caches", async () => {
  const resolver = createResolver([...coreNodes(), new CacheNode(), new SessionNode(), new ServerNode()]);
  try {
    const { get, visit } = await sessionServer(resolver, {
      "/public": { response: "page", responseHeaders: PUBLIC },
      "/start/public": { response: "page", responseHeaders: PUBLIC },
      "/secret": { response: "page", responseHeaders: { "cache-control": "no-store" } },
    });
    const cookie = await visit();

    // Loading the session changes nothing a cache sees: a visitor with no
    // cookies, as every crawler is, and one with a session get the same headers.
    for (const sent of [undefined, cookie]) {
      const plain = await get("/", sent);
      assert.equal(plain.headers.getSetCookie().length, 0);
      assert.equal(plain.headers.get("cache-control"), null);

      const page = await get("/public", sent);
      assert.equal(page.headers.getSetCookie().length, 0);
      assert.equal(page.headers.get("cache-control"), "public, max-age=60");
    }

    // The response that starts a session carries its cookies, which stay the visitor's.
    const started = await get("/start");
    assert.equal(started.headers.getSetCookie().length, 2);
    assert.equal(started.headers.get("cache-control"), 'private="Set-Cookie"');
    const startedPublic = await get("/start/public");
    assert.equal(startedPublic.headers.get("cache-control"), 'public, max-age=60, private="Set-Cookie"');

    // A response already out of shared caches is left alone.
    assert.equal((await get("/secret")).headers.get("cache-control"), "no-store");
  } finally {
    resolver.destroy();
  }
});

// The token in a form is one visitor's: a shared cache that kept the page would
// hand it to the next, whose own session refuses it.
test("a page that renders the session's token is private, whatever it says", async () => {
  const form = { $tag: "form", method: "POST", action: "/save", content: [] };
  const resolver = createResolver([...coreNodes(), new CacheNode(), new SessionNode(), new ServerNode()]);
  try {
    const { get, visit } = await sessionServer(resolver, {
      "/form": form,
      "/public-form": { response: form, responseHeaders: PUBLIC },
      "/search": { response: { ...form, method: "GET" }, responseHeaders: PUBLIC },
    });
    const cookie = await visit();
    for (const path of ["/form", "/public-form"]) {
      const res = await get(path, cookie);
      assert.match(await res.text(), /name="_csrf"/);
      assert.equal(res.headers.get("cache-control"), "private", path);
    }

    // Without a session there is no token, and the page is anyone's.
    const anonymous = await get("/public-form");
    assert.doesNotMatch(await anonymous.text(), /_csrf/);
    assert.equal(anonymous.headers.get("cache-control"), "public, max-age=60");

    // A form that carries no token leaves the page as cacheable as it said.
    const search = await get("/search", cookie);
    assert.doesNotMatch(await search.text(), /_csrf/);
    assert.equal(search.headers.get("cache-control"), "public, max-age=60");
  } finally {
    resolver.destroy();
  }
});
