import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { createResolver, coreNodes } from "@jexs/core";
import { ServerNode } from "../src/nodes/Server.js";
import { WebSocketNode } from "../src/nodes/WebSocket.js";

const PORT = 45201;

/** A resolver with a listener whose sockets join `lobby` and answer any message
 *  with the room's size. */
async function server(port: number) {
  const resolver = createResolver([...coreNodes(), new ServerNode(), new WebSocketNode()]);
  await resolver({
    $listen: port,
    do: [{
      "$socket-accept": true,
      "on-connect": [{ "$socket-join": "lobby" }],
      "on-message": [{ "$socket-send": { "$socket-count": "lobby" } }],
    }],
  }, {});
  return resolver;
}

function connect(port: number): Promise<WebSocket> {
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
  const a = await server(PORT);
  const b = await server(PORT + 1);
  const clients = [await connect(PORT), await connect(PORT + 1)];
  try {
    await new Promise(r => setTimeout(r, 50)); // let on-connect join the room
    assert.equal(await ask(clients[0]), "1");
    assert.equal(await ask(clients[1]), "1");
  } finally {
    for (const ws of clients) ws.close();
    a.destroy();
    b.destroy();
  }
});
