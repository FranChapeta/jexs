import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { Node, createResolver, coreNodes, type Context } from "@jexs/core";
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
      "on-open": [{ "$socket-join": "lobby" }],
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
    await new Promise(r => setTimeout(r, 50)); // let on-open join the room
    assert.equal(await ask(clients[0]), "1");
    assert.equal(await ask(clients[1]), "1");
  } finally {
    for (const ws of clients) ws.close();
    a.resolver.destroy();
    b.resolver.destroy();
  }
});

// Each event runs in a scope of its own under the connection's, so a handler's
// own variables are gone after it, and what it bubbles stays with the connection.
test("a connection's handlers share its id and what they bubble, and on-close gets the close code", { timeout: 5000 }, async () => {
  const closes: unknown[] = [];
  class SeenNode extends Node {
    seen(def: Record<string, unknown>, context: Context) {
      closes.push({ id: context.id, code: context.code, reason: context.reason, name: context.name, reply: context.reply });
      return null;
    }
  }
  const resolver = createResolver([...coreNodes(), new ServerNode(), new WebSocketNode(), new SeenNode()]);
  const port = await resolver({
    $listen: 0,
    do: [{
      "$socket-accept": true,
      "on-message": [
        { $if: { $var: "message.name" }, then: { $setVars: { name: { $var: "message.name" } }, $bubble: true } },
        { $concat: [{ $var: "id" }, "|", { $var: "name" }], $as: "reply" },
        { "$socket-send": { $var: "reply" } },
      ],
      "on-close": [{ $seen: true }],
    }],
  }, {});
  try {
    const ws = await connect(port);
    const first = (await new Promise<string>(resolve => {
      ws.once("message", data => resolve(data.toString()));
      ws.send(JSON.stringify({ name: "ada" }));
    })).split("|");
    assert.match(first[0], /^[0-9a-f-]{36}$/, "the connection's id");
    assert.equal(first[1], "ada");
    assert.deepEqual(await ask(ws), `${first[0]}|ada`, "a later message reads what an earlier one bubbled");

    ws.close(4000, "bye");
    await new Promise(r => setTimeout(r, 100));
    assert.deepEqual(closes, [{ id: first[0], code: 4000, reason: "bye", name: "ada", reply: undefined }]);
  } finally {
    resolver.destroy();
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
