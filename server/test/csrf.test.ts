import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes, type Context } from "@jexs/core";
import { CacheNode, cacheFor } from "../src/nodes/Cache.js";
import { SessionNode } from "../src/nodes/Session.js";

// No router here: the session itself checks the token, so an app that handles
// requests without `$routes`, or loads the session late, is still covered.

type Resolver = ReturnType<typeof createResolver>;

const request = (method: string, cookies: Record<string, string>, extra: Record<string, unknown> = {}): Context => ({
  request: { method, path: "/", cookies, headers: {}, body: {}, ...extra },
  _cookies: [],
});

/** A resolver holding one started session, with its id and token. */
async function started(): Promise<{ resolver: Resolver; context: Context; sid: string; token: string }> {
  const context: Context = {};
  const resolver = createResolver([...coreNodes(), new CacheNode(), new SessionNode()], { context });
  const first = request("GET", {});
  await resolver([{ $session: "load" }, { $session: { user: "ada" } }], first);
  const sid = (first._cookies as string[]).join(";").match(/sid=([^;]+)/)?.[1] ?? "";
  const token = String(first.session?._csrf ?? "");
  assert.ok(sid && token, "a session with a token was started");
  return { resolver, context, sid, token };
}

const stored = async (context: Context, sid: string) =>
  (await cacheFor(context).get<{ data: Record<string, unknown> }>(`session:${sid}`))?.data;

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
      async () => resolver({ $session: "load" }, request("POST", { sid }, { body: { _csrf: wrong } })),
      /CSRF token mismatch/,
    );
  } finally {
    resolver.destroy();
  }
});

test("the right token in the body or the header loads the session", async () => {
  const { resolver, sid, token } = await started();
  try {
    const inBody = request("POST", { sid }, { body: { _csrf: token } });
    await resolver({ $session: "load" }, inBody);
    assert.equal(inBody.session?.user, "ada");

    const inHeader = request("DELETE", { sid }, { headers: { "x-csrf-token": token } });
    await resolver({ $session: "load" }, inHeader);
    assert.equal(inHeader.session?.user, "ada");
  } finally {
    resolver.destroy();
  }
});

// Regenerating rotates the token the request was sent with, so the ops after
// it in the same request must not check again.
test("a login regenerates and then sets values in one POST", async () => {
  const { resolver, context, sid, token } = await started();
  try {
    const login = request("POST", { sid }, { body: { _csrf: token } });
    await resolver([{ $session: "regenerate" }, { $session: { user_id: 7 } }], login);
    const newSid = (login.request?.cookies ?? {}).sid;
    assert.notEqual(newSid, sid);
    assert.equal((await stored(context, newSid))?.user_id, 7);
    assert.equal(await stored(context, sid), undefined);
  } finally {
    resolver.destroy();
  }
});

test("a POST without a session cookie is not checked", async () => {
  const { resolver } = await started();
  try {
    const anonymous = request("POST", {});
    const result = await resolver({ $session: { user: "grace" } }, anonymous);
    assert.equal((result as { action: string }).action, "set");
    assert.equal(anonymous.session?.user, "grace");
  } finally {
    resolver.destroy();
  }
});

// Nothing is stored under the cookie, as after a memory-cache restart.
test("a POST with a session cookie the cache doesn't know is not checked", async () => {
  const { resolver } = await started();
  try {
    const stale = request("POST", { sid: "gone" });
    await resolver([{ $session: "load" }, { $session: "regenerate" }], stale);
    assert.ok(stale.session?._csrf);
    assert.notEqual(stale.request?.cookies?.sid, "gone");
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
    const viaSet = request("POST", { sid: "planted" });
    await resolver({ $session: { user: "eve" } }, viaSet);

    for (const ctx of [viaLoad, viaSet]) {
      const issued = (ctx._cookies as string[]).join(";").match(/sid=([^;]+)/)?.[1];
      assert.ok(issued && issued !== "planted", "a new id was issued");
    }
    assert.equal(await stored(context, "planted"), undefined);
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
