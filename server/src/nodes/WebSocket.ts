import { Node, Context, NodeValue, resolve, resolveAll, runSteps } from "@jexs/core";
import crypto from "node:crypto";
import WebSocket from "ws";

// Module-level state
// Room name → set of connections
const rooms: Map<string, Set<WebSocket>> = new Map();
// Connection → set of room names (reverse lookup for cleanup)
const clients: Map<WebSocket, Set<string>> = new Map();
// Route path → set of connections (for path-level broadcast)
const paths: Map<string, Set<WebSocket>> = new Map();
// Connection ID → WebSocket (for targeted messaging)
const ids: Map<string, WebSocket> = new Map();
// WebSocket → connection ID (reverse lookup)
const wsToId: Map<WebSocket, string> = new Map();
// Connection metadata (user name, etc.)
const meta: WeakMap<WebSocket, Record<string, unknown>> = new WeakMap();

/**
 * WebSocketNode — Server-side WebSocket operations.
 *
 * Operations:
 * - { "ws": "send", "data": {...} }
 * - { "ws": "send-to", "id": "peer-id", "data": {...} }
 * - { "ws": "broadcast", "data": {...}, "room": "name" }
 * - { "ws": "broadcast", "data": {...} }
 * - { "ws": "join", "room": "name" }
 * - { "ws": "leave", "room": "name" }
 * - { "ws": "close" }
 * - { "ws": "count", "room": "name" }
 */
export class WebSocketNode extends Node {
  /**
   * Server-side WebSocket operations. Operations: `"send"`, `"send-to"`, `"broadcast"`,
   * `"join"`, `"leave"`, `"close"`, `"count"`, `"list"`.
   * `"broadcast"` without `"room"` sends to all connections on the same route path.
   *
   * @param {"send"|"send-to"|"broadcast"|"join"|"leave"|"close"|"count"|"list"} ws Operation to perform.
   * @param {expr} data Data to send (used with `"send"`, `"send-to"`, `"broadcast"`).
   * @param {string} id Peer connection ID (used with `"send-to"`).
   * @param {string} room Room name (used with `"join"`, `"leave"`, `"broadcast"`, `"count"`, `"list"`).
   * @example
   * { "ws": "broadcast", "data": { "type": "update", "payload": { "var": "$data" } }, "room": "general" }
   */
  ws(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.ws, context, operation => {
      switch (String(operation)) {
        case "send":
          return doSend(def, context);
        case "send-to":
          return doSendTo(def, context);
        case "broadcast":
          return doBroadcast(def, context);
        case "join":
          return doJoin(def, context);
        case "leave":
          return doLeave(def, context);
        case "close":
          return doClose(def, context);
        case "count":
          return doCount(def, context);
        case "list":
          return doList(def, context);
        default:
          console.error(`[WebSocket] Unknown operation: ${operation}`);
          return null;
      }
    });
  }

  /**
   * Called by Server after WebSocket upgrade completes.
   * Sets up message/close listeners and runs on-connect steps.
   */
  static handleConnection(
    ws: WebSocket,
    handler: Record<string, unknown>,
    context: Context,
  ): void {
    const path = (context.request as Record<string, unknown>)?.path as string || "/";
    const id = crypto.randomUUID();

    // Track connection
    if (!paths.has(path)) {
      paths.set(path, new Set());
    }
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

    // Run on-connect steps
    if (Array.isArray(handler["on-connect"])) {
      runSteps(handler["on-connect"], { ...wsContext });
    }

    // Handle messages
    ws.on("message", (raw: WebSocket.RawData) => {
      if (!Array.isArray(handler["on-message"])) return;

      const rawStr = raw.toString();

      // Size limit: 64 KB per message
      if (rawStr.length > 65_536) {
        ws.send(JSON.stringify({ type: "error", message: "Message too large" }));
        return;
      }

      // Require valid JSON
      let messageData: unknown;
      try {
        messageData = JSON.parse(rawStr);
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }

      // Must be an object
      if (typeof messageData !== "object" || messageData === null || Array.isArray(messageData)) {
        ws.send(JSON.stringify({ type: "error", message: "Expected JSON object" }));
        return;
      }

      runSteps(
        handler["on-message"] as unknown[],
        { ...wsContext, message: messageData },
      );
    });

    // Handle close
    ws.on("close", () => {
      if (Array.isArray(handler["on-close"])) {
        runSteps(handler["on-close"], { ...wsContext });
      }

      // Clean up path tracking
      paths.get(path)?.delete(ws);
      if (paths.get(path)?.size === 0) {
        paths.delete(path);
      }

      // Clean up room memberships
      const memberRooms = clients.get(ws);
      if (memberRooms) {
        for (const room of memberRooms) {
          rooms.get(room)?.delete(ws);
          if (rooms.get(room)?.size === 0) {
            rooms.delete(room);
          }
        }
      }
      clients.delete(ws);

      // Clean up ID tracking
      const wsId = wsToId.get(ws);
      if (wsId) ids.delete(wsId);
      wsToId.delete(ws);
    });
  }

  /**
   * Close all connections (for server shutdown).
   */
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

function doSend(def: Record<string, unknown>, context: Context): NodeValue {
  return resolve(def.data, context, data => {
    const ws = context._ws as WebSocket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;
    ws.send(typeof data === "string" ? data : JSON.stringify(data));
    return null;
  });
}

function doSendTo(def: Record<string, unknown>, context: Context): NodeValue {
  return resolveAll([def.id, def.data], context, ([idRaw, data]) => {
    const target = ids.get(String(idRaw));
    if (!target || target.readyState !== WebSocket.OPEN) return null;
    target.send(typeof data === "string" ? data : JSON.stringify(data));
    return null;
  });
}

function doBroadcast(def: Record<string, unknown>, context: Context): NodeValue {
  return resolveAll([def.data, def.room ?? null], context, ([data, roomRaw]) => {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    const currentWs = context._ws as WebSocket;

    if (def.room && roomRaw != null) {
      const room = String(roomRaw);
      const roomClients = rooms.get(room);
      if (roomClients) {
        for (const client of roomClients) {
          if (client !== currentWs && client.readyState === WebSocket.OPEN) {
            client.send(payload);
          }
        }
      }
    } else {
      const wsPath = context._wsPath as string;
      const pathClients = paths.get(wsPath);
      if (pathClients) {
        for (const client of pathClients) {
          if (client !== currentWs && client.readyState === WebSocket.OPEN) {
            client.send(payload);
          }
        }
      }
    }
    return null;
  });
}

function doJoin(def: Record<string, unknown>, context: Context): NodeValue {
  return resolve(def.room, context, roomRaw => {
    const room = String(roomRaw);
    const ws = context._ws as WebSocket;
    if (!ws) return null;
    if (!rooms.has(room)) rooms.set(room, new Set());
    rooms.get(room)!.add(ws);
    clients.get(ws)?.add(room);
    return null;
  });
}

function doLeave(def: Record<string, unknown>, context: Context): NodeValue {
  return resolve(def.room, context, roomRaw => {
    const room = String(roomRaw);
    const ws = context._ws as WebSocket;
    if (!ws) return null;
    rooms.get(room)?.delete(ws);
    if (rooms.get(room)?.size === 0) rooms.delete(room);
    clients.get(ws)?.delete(room);
    return null;
  });
}

function doClose(def: Record<string, unknown>, context: Context): NodeValue {
  return resolveAll([def.code ?? null, def.reason ?? null], context, ([codeRaw, reasonRaw]) => {
    const ws = context._ws as WebSocket;
    if (!ws) return null;
    const code = def.code ? Number(codeRaw) : 1000;
    const reason = def.reason ? String(reasonRaw) : "";
    ws.close(code, reason);
    return null;
  });
}

function doCount(def: Record<string, unknown>, context: Context): NodeValue {
  if (!def.room) {
    const wsPath = context._wsPath as string;
    return paths.get(wsPath)?.size ?? 0;
  }
  return resolve(def.room, context, roomRaw => rooms.get(String(roomRaw))?.size ?? 0);
}

function doList(def: Record<string, unknown>, context: Context): NodeValue {
  return resolve(def.room, context, roomRaw => {
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
