import { Node, Context, NodeValue, resolve, resolveAll, runStepsDetached, createHttpError } from "@jexs/core";
import crypto from "node:crypto";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import type { JexsNodeSchema } from "@jexs/core";

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
  // This resolver's connections. Each socket's `close` handler removes it, and
  // ServerNode's `dispose` closes the sockets its listeners upgraded, so
  // another resolver in the process never sees these rooms, ids or counts.
  private readonly rooms = new Map<string, Set<WebSocket>>();
  private readonly clients = new Map<WebSocket, Set<string>>();
  private readonly paths = new Map<string, Set<WebSocket>>();
  private readonly ids = new Map<string, WebSocket>();
  private readonly wsToId = new Map<WebSocket, string>();
  private readonly meta = new WeakMap<WebSocket, Record<string, unknown>>();

  static schema: JexsNodeSchema = {
    "socket-accept": {
      type: "boolean",
      output: "null",
      markdownDescription: "Completes the WebSocket upgrade for the current request and binds per-connection step arrays. Must be called from an upgrade pipeline (where `_upgrade` is in context, populated by the `listen` node's upgrade handling).",
      examples: [
        "{ \"$socket-accept\": true, \"on-message\": [{ \"$socket-broadcast\": { \"$var\": \"message\" } }] }",
      ],
      siblings: {
        "on-connect": {
          steps: true,
          description: "Steps run once after the upgrade completes. `_ws`, `_wsPath`, `wsId` available in context.",
        },
        "on-message": {
          steps: true,
          description: "Steps run on each incoming message. `message` is the parsed JSON payload.",
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
        "{ \"$socket-send\": { \"type\": \"pong\" } }",
      ],
    },
    "socket-send-to": {
      type: "string",
      output: "null",
      markdownDescription: "Sends `data` to the peer identified by the connection ID. Objects are JSON-encoded.",
      examples: [
        "{ \"$socket-send-to\": { \"$var\": \"peerId\" }, \"data\": { \"hello\": true } }",
      ],
      siblings: {
        data: { description: "Payload to send to the target peer." },
      },
    },
    "socket-broadcast": {
      output: "null",
      markdownDescription: "Broadcasts the payload to all peers. With `room`, sends to room members; without `room`, sends to every connection on the same route path. The sender is excluded.",
      examples: [
        "{ \"$socket-broadcast\": { \"$var\": \"message\" }, \"room\": \"lobby\" }",
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
        "{ \"$socket-join\": \"lobby\" }",
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
        "{ \"$socket-count\": \"lobby\" }",
        "{ \"$socket-count\": true }",
      ],
    },
    "socket-list": {
      type: "string",
      output: {
        type: "array",
        items: { type: "object", properties: { id: { type: "string", description: "The connection's id." } }, additionalProperties: true },
      },
      markdownDescription: "Lists the connections in the named room.",
      outputDescription: "One entry per connection in the room: its `id`, plus whatever meta the connection was given.",
      examples: [
        "{ \"$socket-list\": \"lobby\" }",
      ],
    },
  };

  ["socket-accept"](def: Record<string, unknown>, context: Context): NodeValue {
    const upgrade = getUpgrade(context);
    if (upgrade.accepted) return null;
    upgrade.accepted = true;

    const onConnect = def["on-connect"] ?? null;
    const onMessage = def["on-message"] ?? null;
    const onClose   = def["on-close"]   ?? null;

    upgrade.wss.handleUpgrade(upgrade.req, upgrade.socket, upgrade.head, (ws) => {
      const path = (context.request as Record<string, unknown>)?.path as string || "/";
      const id = crypto.randomUUID();

      if (!this.paths.has(path)) this.paths.set(path, new Set());
      this.paths.get(path)!.add(ws);
      this.clients.set(ws, new Set());
      this.ids.set(id, ws);
      this.wsToId.set(ws, id);
      const session = context.session as Record<string, unknown> | undefined;
      this.meta.set(ws, { name: session?.user_name ?? "Anonymous" });

      const wsContext: Context = {
        ...context,
        _ws: ws,
        _wsPath: path,
        wsId: id,
      };
      delete wsContext._upgrade;

      if (onConnect) {
        void runStepsDetached(onConnect, { ...wsContext }, def, "[WebSocket] on-connect error:");
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

        void runStepsDetached(onMessage, { ...wsContext, message: messageData }, def, "[WebSocket] on-message error:");
      });

      ws.on("close", () => {
        if (onClose) {
          void runStepsDetached(onClose, { ...wsContext }, def, "[WebSocket] on-close error:");
        }

        this.paths.get(path)?.delete(ws);
        if (this.paths.get(path)?.size === 0) this.paths.delete(path);

        const memberRooms = this.clients.get(ws);
        if (memberRooms) {
          for (const room of memberRooms) {
            this.rooms.get(room)?.delete(ws);
            if (this.rooms.get(room)?.size === 0) this.rooms.delete(room);
          }
        }
        this.clients.delete(ws);

        const wsId = this.wsToId.get(ws);
        if (wsId) this.ids.delete(wsId);
        this.wsToId.delete(ws);
      });
    });

    return null;
  }

  ["socket-send"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["$socket-send"], context, data => {
      const ws = currentSocket(context);
      if (!ws || ws.readyState !== WebSocket.OPEN) return null;
      ws.send(encodePayload(data));
      return null;
    });
  }

  ["socket-send-to"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def["$socket-send-to"], def.data], context, ([idRaw, data]) => {
      const target = this.ids.get(String(idRaw));
      if (!target || target.readyState !== WebSocket.OPEN) return null;
      target.send(encodePayload(data));
      return null;
    });
  }

  ["socket-broadcast"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def["$socket-broadcast"], def.room ?? null], context, ([data, roomRaw]) => {
      const payload = encodePayload(data);
      const sender = currentSocket(context);

      const recipients: Set<WebSocket> | undefined = def.room && roomRaw != null
        ? this.rooms.get(String(roomRaw))
        : this.paths.get(currentPath(context));

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
    return resolve(def["$socket-join"], context, roomRaw => {
      const ws = currentSocket(context);
      if (!ws) return null;
      const room = String(roomRaw);
      if (!this.rooms.has(room)) this.rooms.set(room, new Set());
      this.rooms.get(room)!.add(ws);
      this.clients.get(ws)?.add(room);
      return null;
    });
  }

  ["socket-leave"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["$socket-leave"], context, roomRaw => {
      const ws = currentSocket(context);
      if (!ws) return null;
      const room = String(roomRaw);
      this.rooms.get(room)?.delete(ws);
      if (this.rooms.get(room)?.size === 0) this.rooms.delete(room);
      this.clients.get(ws)?.delete(room);
      return null;
    });
  }

  ["socket-close"](_def: Record<string, unknown>, context: Context): NodeValue {
    const ws = currentSocket(context);
    if (ws) ws.close();
    return null;
  }

  ["socket-count"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["$socket-count"], context, target => {
      if (target === true) return this.paths.get(currentPath(context))?.size ?? 0;
      return this.rooms.get(String(target))?.size ?? 0;
    });
  }

  ["socket-list"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["$socket-list"], context, roomRaw => {
      const room = String(roomRaw);
      const roomClients = this.rooms.get(room);
      if (!roomClients) return [];
      const result: Record<string, unknown>[] = [];
      for (const ws of roomClients) {
        const id = this.wsToId.get(ws);
        if (id) result.push({ id, ...this.meta.get(ws) });
      }
      return result;
    });
  }
}
