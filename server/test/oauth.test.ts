import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import { OAuthNode } from "../src/nodes/OAuth.js";

// Providers carry client secrets, so they belong to the resolver that
// configured them: another resolver in the process neither sees nor replaces them.
test("two resolvers keep separate OAuth providers", async () => {
  const a = createResolver([...coreNodes(), new OAuthNode()]);
  const b = createResolver([...coreNodes(), new OAuthNode()]);
  await a({ $oauth: "configure", provider: "github", clientId: "a-id", clientSecret: "a-secret" }, {});

  assert.deepEqual(await a({ $oauth: "providers" }, {}), ["github"]);
  assert.deepEqual(await b({ $oauth: "providers" }, {}), []);
  await assert.rejects(
    async () => b({ $oauth: "authUrl", provider: "github", redirectUri: "http://x/cb" }, {}),
    /not configured/,
  );
});

// A custom provider's profile keeps its id, email and name where it likes.
test("a custom provider says where its profile keeps the id, email and name", async t => {
  const r = createResolver([...coreNodes(), new OAuthNode()]);
  await r({
    $oauth: "configure", provider: "forge", clientId: "id", clientSecret: "secret",
    authorizeUrl: "https://forge.test/authorize", tokenUrl: "https://forge.test/token", userInfoUrl: "https://forge.test/me",
    userIdField: "data.uid", userNameField: "username",
  }, {});
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ data: { uid: 7 }, username: "ada", email: "ada@forge.test" })));
  const user = await r({ $oauth: "userInfo", provider: "forge", accessToken: "t" }, {}) as Record<string, unknown>;
  assert.deepEqual({ id: user.id, name: user.name, email: user.email }, { id: "7", name: "ada", email: "ada@forge.test" });

  assert.deepEqual(await r({ $oauth: "providers" }, {}), ["forge"]);
  assert.ok((await r({ $oauth: "providers", builtin: true }, {}) as string[]).includes("google"));
});

test("configure refuses credentials that resolve to nothing", async () => {
  const r = createResolver([...coreNodes(), new OAuthNode()]);
  await assert.rejects(
    async () => r({ $oauth: "configure", provider: "github", clientId: { $var: "missing" }, clientSecret: "s" }, {}),
    /needs clientId and clientSecret/,
  );
});
