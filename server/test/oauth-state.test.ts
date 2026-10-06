import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createResolver, coreNodes, type Context } from "@jexs/core";
import { CacheNode } from "../src/nodes/Cache.js";
import { SessionNode } from "../src/nodes/Session.js";
import { OAuthNode } from "../src/nodes/OAuth.js";

// The state `authUrl` sends to the provider waits in the browser's session, and
// `exchange` takes it back once, so a callback that browser never started is
// refused before its code reaches the provider.

const REDIRECT = "http://app.test/oauth/callback/github";

async function app() {
  const resolver = createResolver([...coreNodes(), new CacheNode(), new SessionNode(), new OAuthNode()], { context: {} });
  await resolver({ $oauth: "configure", provider: "github", clientId: "id", clientSecret: "secret" }, {});
  return resolver;
}

const request = (cookies: Record<string, string>, query: Record<string, unknown> = {}): Context => ({
  request: { method: "GET", path: "/", cookies, query, headers: {}, body: {} },
  _cookies: [],
});

/** Start a login in a fresh browser: its session cookie and the state sent. */
async function startLogin(resolver: Awaited<ReturnType<typeof app>>) {
  const ctx = request({});
  const url = String(await resolver({ $oauth: "authUrl", provider: "github", redirectUri: REDIRECT }, ctx));
  const state = new URL(url).searchParams.get("state") ?? "";
  const sid = (ctx._cookies as string[]).join(";").match(/sid=([^;]+)/)?.[1] ?? "";
  assert.ok(state && sid, "a state was sent and a session started");
  return { state, sid };
}

/** The callback as a route writes it: everything comes from the session and the query. */
const exchange = (resolver: Awaited<ReturnType<typeof app>>, ctx: Context) =>
  resolver({ $oauth: "exchange" }, ctx);

const tokenResponse = async () =>
  new Response(JSON.stringify({ access_token: "tok" }), { status: 200, headers: { "content-type": "application/json" } });

test("the callback with the browser's own state reaches the token request", async t => {
  const fetch = t.mock.method(globalThis, "fetch", tokenResponse);
  const resolver = await app();
  try {
    const { state, sid } = await startLogin(resolver);
    const result = await exchange(resolver, request({ sid }, { state, code: "the-code" }));
    assert.equal((result as { accessToken: string }).accessToken, "tok");
    assert.equal(fetch.mock.callCount(), 1);
  } finally {
    resolver.destroy();
  }
});

test("a wrong or missing state is refused before the code is spent", async t => {
  const fetch = t.mock.method(globalThis, "fetch", tokenResponse);
  const resolver = await app();
  try {
    const { sid } = await startLogin(resolver);
    await assert.rejects(async () => exchange(resolver, request({ sid }, { state: "guessed", code: "c" })), /OAuth state mismatch/);

    const again = await startLogin(resolver);
    await assert.rejects(async () => exchange(resolver, request({ sid: again.sid }, { code: "c" })), /OAuth state mismatch/);
    assert.equal(fetch.mock.callCount(), 0);
  } finally {
    resolver.destroy();
  }
});

test("a state works once", async t => {
  const fetch = t.mock.method(globalThis, "fetch", tokenResponse);
  const resolver = await app();
  try {
    const { state, sid } = await startLogin(resolver);
    await exchange(resolver, request({ sid }, { state, code: "c" }));
    await assert.rejects(async () => exchange(resolver, request({ sid }, { state, code: "c" })), /OAuth state mismatch/);
    assert.equal(fetch.mock.callCount(), 1);
  } finally {
    resolver.destroy();
  }
});

// The login CSRF: an attacker starts a login, then sends the victim their own
// callback, state and all. The victim's browser never asked for it.
test("a state from another browser's login is refused", async t => {
  const fetch = t.mock.method(globalThis, "fetch", tokenResponse);
  const resolver = await app();
  try {
    const attacker = await startLogin(resolver);
    const victim = await startLogin(resolver);
    await assert.rejects(
      async () => exchange(resolver, request({ sid: victim.sid }, { state: attacker.state, code: "c" })),
      (e: Error & { status?: number }) => e.status === 403,
    );
    await assert.rejects(async () => exchange(resolver, request({}, { state: attacker.state, code: "c" })), /OAuth state mismatch/);
    assert.equal(fetch.mock.callCount(), 0);
  } finally {
    resolver.destroy();
  }
});

test("an explicit state sibling is checked instead of the query", async t => {
  t.mock.method(globalThis, "fetch", tokenResponse);
  const resolver = await app();
  try {
    const { state, sid } = await startLogin(resolver);
    const ctx = request({ sid }, { state: "not this one" });
    const result = await resolver({ $oauth: "exchange", provider: "github", code: "c", state }, ctx);
    assert.equal((result as { success: boolean }).success, true);
  } finally {
    resolver.destroy();
  }
});

/** The form fields and headers the token endpoint received. */
function tokenCall(fetch: { mock: { calls: Array<{ arguments: unknown[] }> } }) {
  const init = fetch.mock.calls[0].arguments[1] as { headers: Record<string, string>; body: string };
  return { headers: init.headers, form: new URLSearchParams(init.body) };
}

// PKCE: only the server that started the login holds the verifier, so a code
// intercepted on its way back is useless to anyone else.
test("the token request proves the login's PKCE challenge and reuses its redirect URI", async t => {
  const fetch = t.mock.method(globalThis, "fetch", tokenResponse);
  const resolver = await app();
  try {
    const ctx = request({});
    const url = new URL(String(await resolver({ $oauth: "authUrl", provider: "github", redirectUri: REDIRECT }, ctx)));
    const sid = (ctx._cookies as string[]).join(";").match(/sid=([^;]+)/)?.[1] ?? "";
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");

    await exchange(resolver, request({ sid }, { state: url.searchParams.get("state"), code: "c" }));
    const { form, headers } = tokenCall(fetch);
    const verifier = form.get("code_verifier") ?? "";
    assert.equal(createHash("sha256").update(verifier).digest("base64url"), url.searchParams.get("code_challenge"));
    assert.equal(form.get("redirect_uri"), REDIRECT);
    assert.equal(form.get("code"), "c");
    assert.equal(form.get("client_secret"), "secret");
    assert.equal(headers.Authorization, undefined);
  } finally {
    resolver.destroy();
  }
});

test("a provider using Basic auth gets its credentials in the header, not the form", async t => {
  const fetch = t.mock.method(globalThis, "fetch", tokenResponse);
  const resolver = await app();
  try {
    await resolver({ $oauth: "configure", provider: "twitter", clientId: "tw id", clientSecret: "tw:secret" }, {});
    const ctx = request({});
    const url = new URL(String(await resolver({ $oauth: "authUrl", provider: "twitter", redirectUri: REDIRECT }, ctx)));
    const sid = (ctx._cookies as string[]).join(";").match(/sid=([^;]+)/)?.[1] ?? "";

    await exchange(resolver, request({ sid }, { state: url.searchParams.get("state"), code: "c" }));
    const { form, headers } = tokenCall(fetch);
    assert.equal(headers.Authorization, `Basic ${Buffer.from("tw+id:tw%3Asecret").toString("base64")}`);
    assert.equal(form.get("client_secret"), null);
    assert.equal(form.get("client_id"), "tw id");
  } finally {
    resolver.destroy();
  }
});

test("with two logins in progress, exchange needs its provider", async t => {
  t.mock.method(globalThis, "fetch", tokenResponse);
  const resolver = await app();
  try {
    await resolver({ $oauth: "configure", provider: "google", clientId: "g", clientSecret: "s" }, {});
    const { state, sid } = await startLogin(resolver);
    await resolver({ $oauth: "authUrl", provider: "google", redirectUri: REDIRECT }, request({ sid }));

    await assert.rejects(async () => exchange(resolver, request({ sid }, { state, code: "c" })), /give "exchange" its "provider"/);
    const result = await resolver({ $oauth: "exchange", provider: "github" }, request({ sid }, { state, code: "c" }));
    assert.equal((result as { success: boolean }).success, true);
  } finally {
    resolver.destroy();
  }
});

test("a declined login reports the provider's error", async t => {
  const fetch = t.mock.method(globalThis, "fetch", tokenResponse);
  const resolver = await app();
  try {
    const { state, sid } = await startLogin(resolver);
    await assert.rejects(
      async () => exchange(resolver, request({ sid }, { state, error: "access_denied" })),
      /OAuth login failed: access_denied/,
    );
    assert.equal(fetch.mock.callCount(), 0);
  } finally {
    resolver.destroy();
  }
});
