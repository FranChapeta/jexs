import { Node, Context, NodeValue, Html, childContext, isObject, resolve, resolveAll, runStepsDetached, createHttpError } from "@jexs/core";
import crypto from "node:crypto";
import type { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import type { JexsNodeSchema } from "@jexs/core";
import { UPGRADE, WS, WS_PATH } from "../context.js";

interface UpgradeContext {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  wss: WebSocketServer;
  accepted: boolean;
}

function getUpgrade(context: Context): UpgradeContext {
  // Only the listener's upgrade handling sets it, as an UpgradeContext.
  const upgrade = context[UPGRADE] as UpgradeContext | undefined;
  if (!upgrade) {
    throw createHttpError(500, "socketAccept must be called from an upgrade pipeline");
  }
  return upgrade;
}

/** The connection a socket handler runs for, which an op acting on it needs. */
function handlerSocket(op: string, context: Context): WebSocket {
  const ws = context[WS];
  if (!(ws instanceof WebSocket)) throw new Error(`$${op} runs in a socket's handlers, where there is a connection to act on`);
  return ws;
}

function currentPath(context: Context): string {
  const path = context[WS_PATH];
  return typeof path === "string" ? path : "/";
}

function encodePayload(data: unknown): string {
  return typeof data === "string" || data instanceof Html ? String(data) : JSON.stringify(data);
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
    socketAccept: {
      type: "boolean",
      output: "null",
      markdownDescription: "Completes the WebSocket upgrade for the current request and binds per-connection step arrays. Must be called while a `listen` node handles an upgrade (a `WS` route), and throws anywhere else.",
      examples: [
        "{ \"$socketAccept\": true, \"onMessage\": [{ \"$socketBroadcast\": { \"$var\": \"message\" } }] }",
      ],
      siblings: {
        onOpen: {
          steps: true,
          description: "Steps run once after the upgrade completes. Every handler sees `id`, the connection's id (for `socketSendTo`), and the request that opened it; a value it sets with `$bubble` stays for the connection's later handlers.",
        },
        onMessage: {
          steps: true,
          description: "Steps run on each incoming message. `message` is the parsed JSON payload.",
        },
        onClose: {
          steps: true,
          description: "Steps run once when the connection closes. `code` and `reason` are the close code and its reason text.",
        },
        meta: {
          type: "object",
          description: "What `socketList` reports for the connection beside its `id`, resolved when it is accepted, e.g. `{ \"name\": { \"$var\": \"session.name\" } }`.",
        },
      },
    },
    socketSend: {
      output: "null",
      markdownDescription: "Sends a message on the connection a socket handler runs for. Objects are JSON-encoded.",
      examples: [
        "{ \"$socketSend\": { \"type\": \"pong\" } }",
      ],
    },
    socketSendTo: {
      type: "string",
      output: "null",
      markdownDescription: "Sends `data` to the peer identified by the connection ID. Objects are JSON-encoded.",
      examples: [
        "{ \"$socketSendTo\": { \"$var\": \"peerId\" }, \"data\": { \"hello\": true } }",
      ],
      siblings: {
        data: { required: true, description: "Payload to send to the target peer." },
      },
    },
    socketBroadcast: {
      output: "null",
      markdownDescription: "Broadcasts the payload to all peers. With `room`, sends to room members; without `room`, sends to every connection on the same route path. The sender is excluded.",
      examples: [
        "{ \"$socketBroadcast\": { \"$var\": \"message\" }, \"room\": \"lobby\" }",
      ],
      siblings: {
        room: { type: "string", description: "Restrict broadcast to a named room." },
      },
    },
    socketJoin: {
      type: "string",
      output: "null",
      markdownDescription: "Adds the current connection to the named room.",
      examples: [
        "{ \"$socketJoin\": \"lobby\" }",
      ],
    },
    socketLeave: {
      type: "string",
      output: "boolean",
      outputDescription: "`true` if the connection was in the room, otherwise `false`.",
      markdownDescription: "Removes the current connection from the named room.",
    },
    socketClose: {
      type: "boolean",
      output: "null",
      markdownDescription: "Closes the current connection.",
    },
    socketCount: {
      type: ["string", "boolean"],
      output: "number",
      markdownDescription: "Counts connections in a room (pass the room name) or on the current route path (pass `true`).",
      outputDescription: "The connection count as a number.",
      examples: [
        "{ \"$socketCount\": \"lobby\" }",
        "{ \"$socketCount\": true }",
      ],
    },
    socketList: {
      type: "string",
      output: {
        type: "array",
        items: { type: "object", properties: { id: { type: "string", description: "The connection's id." } }, additionalProperties: true },
      },
      markdownDescription: "Lists the connections in the named room.",
      outputDescription: "One entry per connection in the room: its `id`, plus the `meta` it was accepted with.",
      examples: [
        "{ \"$socketList\": \"lobby\" }",
      ],
    },
  };

  socketAccept(def: Record<string, unknown>, context: Context): NodeValue {
    const upgrade = getUpgrade(context);
    if (upgrade.accepted) return null;

    const onOpen    = def.onOpen    ?? null;
    const onMessage = def.onMessage ?? null;
    const onClose   = def.onClose   ?? null;

    // Resolved before the upgrade is claimed, so one that fails leaves it to be refused.
    return resolve(def.meta ?? null, context, meta => {
      if (meta !== null && !isObject(meta)) {
        throw new Error(`socketAccept: meta must be an object, not ${JSON.stringify(meta)}`);
      }
      if (upgrade.accepted) return null;
      upgrade.accepted = true;

      upgrade.wss.handleUpgrade(upgrade.req, upgrade.socket, upgrade.head, (ws) => {
        const path = (context.request as Record<string, unknown>)?.path as string || "/";
        const id = crypto.randomUUID();

        if (!this.paths.has(path)) this.paths.set(path, new Set());
        this.paths.get(path)!.add(ws);
        this.clients.set(ws, new Set());
        this.ids.set(id, ws);
        this.wsToId.set(ws, id);
        this.meta.set(ws, meta ?? {});

        // The connection's own scope, under the request that opened it. Each event's
        // steps run in a scope of their own under it, so what one handler sets with
        // `$bubble` the connection's later handlers read.
        const connection = childContext(context, { [WS]: ws, [WS_PATH]: path, [UPGRADE]: undefined, id });

        if (onOpen) {
          void runStepsDetached(onOpen, childContext(connection), { step: def, logAs: "[WebSocket] onOpen error:" });
        }

        ws.on("message", (raw: WebSocket.RawData) => {
          if (!onMessage) return;
          // The listener's upgrade server already refused anything over its
          // `maxMessageSize`, so this is within the limit.
          const rawStr = raw.toString();

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

          void runStepsDetached(onMessage, childContext(connection, { message: messageData }), { step: def, logAs: "[WebSocket] onMessage error:" });
        });

        // A client that breaks the protocol (a frame over `maxMessageSize`, invalid
        // UTF-8, a bad opcode) makes ws emit `error` and then close the socket with
        // the matching code, so `onClose` still runs. Without a listener the
        // event would throw and take the process down with it.
        ws.on("error", () => {});

        ws.on("close", (code: number, reason: Buffer) => {
          if (onClose) {
            const closed = childContext(connection, { code, reason: reason.toString() });
            void runStepsDetached(onClose, closed, { step: def, logAs: "[WebSocket] onClose error:" });
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
    });
  }

  socketSend(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$socketSend, context, data => {
      const ws = handlerSocket("socketSend", context);
      if (ws.readyState !== WebSocket.OPEN) throw new Error("$socketSend: the connection is closed");
      ws.send(encodePayload(data));
      return null;
    });
  }

  socketSendTo(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$socketSendTo, def.data], context, ([idRaw, data]) => {
      const target = this.ids.get(String(idRaw));
      if (!target || target.readyState !== WebSocket.OPEN) {
        throw new Error(`$socketSendTo: no open connection "${String(idRaw)}"`);
      }
      target.send(encodePayload(data));
      return null;
    });
  }

  socketBroadcast(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$socketBroadcast, def.room ?? null], context, ([data, roomRaw]) => {
      const payload = encodePayload(data);
      // Outside a handler there is no sender to skip, and nothing in a room matches undefined.
      const sender = context[WS];

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

  socketJoin(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$socketJoin, context, roomRaw => {
      const ws = handlerSocket("socketJoin", context);
      const room = String(roomRaw);
      if (!this.rooms.has(room)) this.rooms.set(room, new Set());
      this.rooms.get(room)!.add(ws);
      this.clients.get(ws)?.add(room);
      return null;
    });
  }

  socketLeave(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$socketLeave, context, roomRaw => {
      const ws = handlerSocket("socketLeave", context);
      const room = String(roomRaw);
      const was = this.rooms.get(room)?.delete(ws) ?? false;
      if (this.rooms.get(room)?.size === 0) this.rooms.delete(room);
      this.clients.get(ws)?.delete(room);
      return was;
    });
  }

  socketClose(_def: Record<string, unknown>, context: Context): NodeValue {
    handlerSocket("socketClose", context).close();
    return null;
  }

  socketCount(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$socketCount, context, target => {
      if (target === true) return this.paths.get(currentPath(context))?.size ?? 0;
      return this.rooms.get(String(target))?.size ?? 0;
    });
  }

  socketList(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$socketList, context, roomRaw => {
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
