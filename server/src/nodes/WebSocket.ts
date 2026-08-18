import { Node, Context, NodeValue, resolve, resolveAll, runStepsDetached, createHttpError } from "@jexs/core";
import crypto from "node:crypto";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import type { JexsNodeSchema } from "@jexs/core";

const rooms: Map<string, Set<WebSocket>> = new Map();
const clients: Map<WebSocket, Set<string>> = new Map();
const paths: Map<string, Set<WebSocket>> = new Map();
const ids: Map<string, WebSocket> = new Map();
const wsToId: Map<WebSocket, string> = new Map();
const meta: WeakMap<WebSocket, Record<string, unknown>> = new WeakMap();

interface UpgradeContext {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  wss: WebSocketServer;
  accepted: boolean;
}

function getUpgrade(context: Context): UpgradeContext {
  const upgrade = context._upgrade as UpgradeContext | undefined;
  if (!upgrade) {
    throw createHttpError(500, "socket-accept must be called from an upgrade pipeline");
  }
  return upgrade;
}

function currentSocket(context: Context): WebSocket | null {
  return (context._ws as WebSocket | undefined) ?? null;
}

function currentPath(context: Context): string {
  return (context._wsPath as string | undefined) ?? "/";
}

function encodePayload(data: unknown): string {
  return typeof data === "string" ? data : JSON.stringify(data);
}

export class WebSocketNode extends Node {
  static schema: JexsNodeSchema = {
    "socket-accept": {
      type: "boolean",
      output: "null",
      markdownDescription: "Completes the WebSocket upgrade for the current request and binds per-connection step arrays. Must be called from an upgrade pipeline (where `_upgrade` is in context — populated by the `listen` node's upgrade handling).",
      examples: [
        "{ \"socket-accept\": true, \"on-message\": [{ \"socket-broadcast\": { \"var\": \"$message\" } }] }",
      ],
      siblings: {
        "on-connect": {
          steps: true,
          description: "Steps run once after the upgrade completes. `_ws`, `_wsPath`, `wsId` available in context.",
        },
        "on-message": {
          steps: true,
          description: "Steps run on each incoming message. `$message` is the parsed JSON payload.",
        },
        "on-close": {
          steps: true,
          description: "Steps run once when the connection closes.",
        },
      },
    },
    "socket-send": {
      output: "null",
      markdownDescription: "Sends a message on the current connection (`_ws` in context). Objects are JSON-encoded.",
      examples: [
        "{ \"socket-send\": { \"type\": \"pong\" } }",
      ],
    },
    "socket-send-to": {
      type: "string",
      output: "null",
      markdownDescription: "Sends `data` to the peer identified by the connection ID. Objects are JSON-encoded.",
      examples: [
        "{ \"socket-send-to\": { \"var\": \"$peerId\" }, \"data\": { \"hello\": true } }",
      ],
      siblings: {
        data: { description: "Payload to send to the target peer." },
      },
    },
    "socket-broadcast": {
      output: "null",
      markdownDescription: "Broadcasts the payload to all peers. With `room`, sends to room members; without `room`, sends to every connection on the same route path. The sender is excluded.",
      examples: [
        "{ \"socket-broadcast\": { \"var\": \"$message\" }, \"room\": \"lobby\" }",
      ],
      siblings: {
        room: { type: "string", description: "Restrict broadcast to a named room." },
      },
    },
    "socket-join": {
      type: "string",
      output: "null",
      markdownDescription: "Adds the current connection to the named room.",
      examples: [
        "{ \"socket-join\": \"lobby\" }",
      ],
    },
    "socket-leave": {
      type: "string",
      output: "null",
      markdownDescription: "Removes the current connection from the named room.",
    },
    "socket-close": {
      type: "boolean",
      output: "null",
      markdownDescription: "Closes the current connection.",
    },
    "socket-count": {
      type: ["string", "boolean"],
      output: "number",
      markdownDescription: "Counts connections in a room (pass the room name) or on the current route path (pass `true`).",
      outputDescription: "The connection count as a number.",
      examples: [
        "{ \"socket-count\": \"lobby\" }",
        "{ \"socket-count\": true }",
      ],
    },
    "socket-list": {
      type: "string",
      output: "array",
      markdownDescription: "Lists the connections in the named room.",
      outputDescription: "An array of `{ id, ...meta }` objects, one per connection in the room.",
      examples: [
        "{ \"socket-list\": \"lobby\" }",
      ],
    },
  };

  ["socket-accept"](def: Record<string, unknown>, context: Context): NodeValue {
    const upgrade = getUpgrade(context);
    if (upgrade.accepted) return null;
    upgrade.accepted = true;

    const onConnect = Array.isArray(def["on-connect"]) ? def["on-connect"] as unknown[] : null;
    const onMessage = Array.isArray(def["on-message"]) ? def["on-message"] as unknown[] : null;
    const onClose   = Array.isArray(def["on-close"])   ? def["on-close"]   as unknown[] : null;

    upgrade.wss.handleUpgrade(upgrade.req, upgrade.socket, upgrade.head, (ws) => {
      const path = (context.request as Record<string, unknown>)?.path as string || "/";
      const id = crypto.randomUUID();

      if (!paths.has(path)) paths.set(path, new Set());
      paths.get(path)!.add(ws);
      clients.set(ws, new Set());
      ids.set(id, ws);
      wsToId.set(ws, id);
      const session = context.session as Record<string, unknown> | undefined;
      meta.set(ws, { name: session?.user_name ?? "Anonymous" });

      const wsContext: Context = {
        ...context,
        _ws: ws,
        _wsPath: path,
        wsId: id,
      };
      delete wsContext._upgrade;

      if (onConnect) {
        runStepsDetached(onConnect, { ...wsContext }, def)
          .catch(err => console.error("[WebSocket] on-connect error:", err));
      }

      ws.on("message", (raw: WebSocket.RawData) => {
        if (!onMessage) return;
        const rawStr = raw.toString();

        if (rawStr.length > 65_536) {
          ws.send(JSON.stringify({ type: "error", message: "Message too large" }));
          return;
        }

        let messageData: unknown;
        try {
          messageData = JSON.parse(rawStr);
        } catch {
          ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
          return;
        }

        if (typeof messageData !== "object" || messageData === null || Array.isArray(messageData)) {
          ws.send(JSON.stringify({ type: "error", message: "Expected JSON object" }));
          return;
        }

        runStepsDetached(onMessage, { ...wsContext, message: messageData }, def)
          .catch(err => console.error("[WebSocket] on-message error:", err));
      });

      ws.on("close", () => {
        if (onClose) {
          runStepsDetached(onClose, { ...wsContext }, def)
            .catch(err => console.error("[WebSocket] on-close error:", err));
        }

        paths.get(path)?.delete(ws);
        if (paths.get(path)?.size === 0) paths.delete(path);

        const memberRooms = clients.get(ws);
        if (memberRooms) {
          for (const room of memberRooms) {
            rooms.get(room)?.delete(ws);
            if (rooms.get(room)?.size === 0) rooms.delete(room);
          }
        }
        clients.delete(ws);

        const wsId = wsToId.get(ws);
        if (wsId) ids.delete(wsId);
        wsToId.delete(ws);
      });
    });

    return null;
  }

  ["socket-send"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["socket-send"], context, data => {
      const ws = currentSocket(context);
      if (!ws || ws.readyState !== WebSocket.OPEN) return null;
      ws.send(encodePayload(data));
      return null;
    });
  }

  ["socket-send-to"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def["socket-send-to"], def.data], context, ([idRaw, data]) => {
      const target = ids.get(String(idRaw));
      if (!target || target.readyState !== WebSocket.OPEN) return null;
      target.send(encodePayload(data));
      return null;
    });
  }

  ["socket-broadcast"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def["socket-broadcast"], def.room ?? null], context, ([data, roomRaw]) => {
      const payload = encodePayload(data);
      const sender = currentSocket(context);

      const recipients: Set<WebSocket> | undefined = def.room && roomRaw != null
        ? rooms.get(String(roomRaw))
        : paths.get(currentPath(context));

      if (!recipients) return null;
      for (const peer of recipients) {
        if (peer !== sender && peer.readyState === WebSocket.OPEN) {
          peer.send(payload);
        }
      }
      return null;
    });
  }

  ["socket-join"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["socket-join"], context, roomRaw => {
      const ws = currentSocket(context);
      if (!ws) return null;
      const room = String(roomRaw);
      if (!rooms.has(room)) rooms.set(room, new Set());
      rooms.get(room)!.add(ws);
      clients.get(ws)?.add(room);
      return null;
    });
  }

  ["socket-leave"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["socket-leave"], context, roomRaw => {
      const ws = currentSocket(context);
      if (!ws) return null;
      const room = String(roomRaw);
      rooms.get(room)?.delete(ws);
      if (rooms.get(room)?.size === 0) rooms.delete(room);
      clients.get(ws)?.delete(room);
      return null;
    });
  }

  ["socket-close"](_def: Record<string, unknown>, context: Context): NodeValue {
    const ws = currentSocket(context);
    if (ws) ws.close();
    return null;
  }

  ["socket-count"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["socket-count"], context, target => {
      if (target === true) return paths.get(currentPath(context))?.size ?? 0;
      return rooms.get(String(target))?.size ?? 0;
    });
  }

  ["socket-list"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["socket-list"], context, roomRaw => {
      const room = String(roomRaw);
      const roomClients = rooms.get(room);
      if (!roomClients) return [];
      const result: Record<string, unknown>[] = [];
      for (const ws of roomClients) {
        const id = wsToId.get(ws);
        if (id) result.push({ id, ...meta.get(ws) });
      }
      return result;
    });
  }

  static closeAll(): void {
    for (const pathClients of paths.values()) {
      for (const ws of pathClients) {
        ws.close(1001, "Server shutting down");
      }
    }
    paths.clear();
    rooms.clear();
    clients.clear();
    ids.clear();
    wsToId.clear();
  }
}
