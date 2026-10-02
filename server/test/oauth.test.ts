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

test("configure refuses credentials that resolve to nothing", async () => {
  const r = createResolver([...coreNodes(), new OAuthNode()]);
  await assert.rejects(
    async () => r({ $oauth: "configure", provider: "github", clientId: { $var: "missing" }, clientSecret: "s" }, {}),
    /needs clientId and clientSecret/,
  );
});
