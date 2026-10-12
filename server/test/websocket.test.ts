import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { createResolver, coreNodes } from "@jexs/core";
import { ServerNode } from "../src/nodes/Server.js";
import { WebSocketNode } from "../src/nodes/WebSocket.js";

/** A resolver with a listener, on a free port, whose sockets join `lobby` and
 *  answer any message with the room's size. */
async function server(options: Record<string, unknown> = {}) {
  const resolver = createResolver([...coreNodes(), new ServerNode(), new WebSocketNode()]);
  const port = await resolver({
    $listen: 0,
    ...options,
    do: [{
      "$socket-accept": true,
      "on-connect": [{ "$socket-join": "lobby" }],
      "on-message": [{ "$socket-send": { "$socket-count": "lobby" } }],
    }],
  }, {});
  return { resolver, port };
}

function connect(port: unknown): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function ask(ws: WebSocket): Promise<string> {
  return new Promise(resolve => {
    ws.once("message", data => resolve(data.toString()));
    ws.send("{}");
  });
}

// Rooms, ids and counts belong to the resolver whose listener upgraded the
// socket, so two resolvers in one process never see each other's connections.
test("two resolvers' sockets do not share rooms", async () => {
  const a = await server();
  const b = await server();
  const clients = [await connect(a.port), await connect(b.port)];
  try {
    await new Promise(r => setTimeout(r, 50)); // let on-connect join the room
    assert.equal(await ask(clients[0]), "1");
    assert.equal(await ask(clients[1]), "1");
  } finally {
    for (const ws of clients) ws.close();
    a.resolver.destroy();
    b.resolver.destroy();
  }
});

/** The close code the server ends `ws` with after it is sent `bytes` of payload. */
function closeCodeAfterSending(ws: WebSocket, bytes: number): Promise<number> {
  return new Promise(resolve => {
    ws.once("close", code => resolve(code));
    ws.send(JSON.stringify({ pad: "x".repeat(bytes) }));
  });
}

// The limit is enforced by the ws server while the frame arrives, so an oversized
// message is never buffered whole: the socket closes with 1009 (message too big).
test("a message over the listener's maxMessageSize closes the socket with 1009", { timeout: 5000 }, async () => {
  const { resolver, port } = await server({ maxMessageSize: 1024 });
  try {
    const ws = await connect(port);
    assert.equal(await ask(ws), "1", "a message within the limit is handled");
    assert.equal(await closeCodeAfterSending(ws, 2048), 1009);
  } finally {
    resolver.destroy();
  }
});

test("messages are limited to 64 KiB by default", { timeout: 5000 }, async () => {
  const { resolver, port } = await server();
  try {
    const ws = await connect(port);
    assert.equal(await closeCodeAfterSending(ws, 70_000), 1009);
  } finally {
    resolver.destroy();
  }
});
