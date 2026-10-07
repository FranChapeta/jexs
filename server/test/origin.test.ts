import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createResolver, coreNodes } from "@jexs/core";
import type { Resolver } from "@jexs/core";
import { ServerNode } from "../src/nodes/Server.js";
import { WebSocketNode } from "../src/nodes/WebSocket.js";

// Real listeners, each on a free port: the check runs on the raw request before any step.
let PORT = 0;
let TRUSTING_PORT = 0;
let SOCKET_PORT = 0;

let resolver: Resolver;

before(async () => {
  resolver = createResolver([...coreNodes(), new ServerNode(), new WebSocketNode()]);
  PORT = Number(await resolver({ $listen: 0, do: [{ response: "ran" }] }, {}));
  TRUSTING_PORT = Number(await resolver({ $listen: 0, trustedOrigins: ["https://admin.example"], do: [{ response: "ran" }] }, {}));
  SOCKET_PORT = Number(await resolver({ $listen: 0, do: [{ "$socket-accept": true }] }, {}));
});

after(() => {
  resolver.destroy();
});

/** Send a request with exactly these headers; resolves to the status. */
function send(method: string, headers: Record<string, string>, port = PORT): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: "/", headers }, res => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

test("a POST a browser sends from another site is refused", async () => {
  assert.equal(await send("POST", { "sec-fetch-site": "cross-site", origin: "https://evil.example" }), 403);
  // A sibling subdomain can be someone else's, so same-site is not enough.
  assert.equal(await send("DELETE", { "sec-fetch-site": "same-site", origin: "https://other.localhost" }), 403);
});

test("a POST from the app's own pages goes through", async () => {
  assert.equal(await send("POST", { "sec-fetch-site": "same-origin", origin: `http://127.0.0.1:${PORT}` }), 200);
  // Typed into the address bar or opened from a bookmark.
  assert.equal(await send("POST", { "sec-fetch-site": "none" }), 200);
});

// Browsers without Sec-Fetch-Site still send Origin.
test("without Sec-Fetch-Site, Origin is compared with the host", async () => {
  assert.equal(await send("POST", { origin: "https://evil.example" }), 403);
  assert.equal(await send("POST", { origin: `http://127.0.0.1:${PORT}` }), 200);
});

test("a request from outside a browser, without either header, goes through", async () => {
  assert.equal(await send("POST", {}), 200);
});

test("safe methods are never refused", async () => {
  assert.equal(await send("GET", { "sec-fetch-site": "cross-site", origin: "https://evil.example" }), 200);
});

test("a trusted origin may send unsafe requests", async () => {
  const headers = { "sec-fetch-site": "cross-site", origin: "https://admin.example" };
  assert.equal(await send("POST", headers, TRUSTING_PORT), 200);
  assert.equal(await send("POST", { ...headers, origin: "https://evil.example" }, TRUSTING_PORT), 403);
});

/** Attempt a WebSocket handshake from `origin`; resolves to what happened. */
function upgrade(origin: string): Promise<string> {
  return new Promise(resolve => {
    const req = http.request({
      host: "127.0.0.1", port: SOCKET_PORT, path: "/",
      headers: {
        connection: "Upgrade", upgrade: "websocket",
        "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        origin,
      },
    });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      resolve("upgraded");
    });
    req.on("response", res => resolve(`status ${res.statusCode}`));
    req.on("error", () => resolve("closed"));
    req.end();
  });
}

test("a WebSocket upgrade from another site is closed before any step runs", async () => {
  assert.equal(await upgrade(`http://127.0.0.1:${SOCKET_PORT}`), "upgraded");
  assert.equal(await upgrade("https://evil.example"), "closed");
});
