import { Node, Context, NodeValue, childContext, runStepsDetached } from "@jexs/core";
import { resolve, resolveAll } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";

/** The connection a step means when it names none. */
const DEFAULT = "default";

const BINARY_TYPES: readonly BinaryType[] = ["blob", "arraybuffer"];

/** A live connection, plus everything needed to reopen it. */
interface Conn {
  /** The node this belongs to, so a callback firing long after the step can
   *  still reach the registry and the reconnect machinery. */
  node: WsNode;
  name: string;
  url: string;
  socket: WebSocket | null;
  /** The connect step's def and context, replayed on every reconnect. */
  def: Record<string, unknown>;
  context: Context;
  closing: boolean;
  /** Attempts left, `Infinity` for the default backoff-forever behavior. */
  retries: number;
  attempts: number;
  delay: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Messages written while the socket was still opening. */
  queue: Frame[];
}

/**
 * What `WebSocket.send` accepts. Deliberately not `ArrayBufferLike`, which also
 * covers SharedArrayBuffer: `send` refuses one, and the check below never
 * admits one either, since a SharedArrayBuffer is not an `instanceof
 * ArrayBuffer`.
 */
type Frame = string | Blob | BufferSource;

function isBinary(value: unknown): value is Blob | BufferSource {
  return value instanceof ArrayBuffer
    || ArrayBuffer.isView(value)
    || (typeof Blob !== "undefined" && value instanceof Blob);
}

/**
 * How many reconnect attempts a `retry` value asks for. Anything unreadable
 * throws rather than defaulting: falling back to Infinity would turn a typo into
 * a socket that reconnects forever, which is the failure hardest to notice.
 */
function retryCount(value: unknown): number {
  if (value === null || value === undefined) return Infinity;
  if (typeof value === "boolean") return value ? Infinity : 0;
  if (value === "true") return Infinity;
  if (value === "false") return 0;
  // Not a bare `Number(value)`: it reads "" and " " as 0, so an empty expression
  // would quietly mean "never reconnect" instead of saying it could not be read.
  const attempts = typeof value === "number" ? value
    : typeof value === "string" && value.trim() !== "" ? Number(value)
    : NaN;
  if (!Number.isFinite(attempts) || attempts < 0) {
    throw new Error(`Invalid ws retry "${String(value)}": expected true, false, or a number of attempts`);
  }
  return attempts;
}

function absoluteUrl(url: string): string {
  if (url.startsWith("ws")) return url;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return proto + "//" + location.host + url;
}

function run(conn: Conn, key: string, extra: Record<string, unknown>): void {
  const body = conn.def[key];
  if (body === undefined) return;
  // A lone expression is a one-step sequence, the same normalization `resolveSteps`
  // does and the same shape the `steps` schema def accepts, so a handler that does
  // one thing does not have to be written as an array to be seen.
  const steps = Array.isArray(body) ? body : [body];
  // A child scope per event, not a write onto the captured context: the handler
  // outlives the step, so binding into the parent would leak `$wsMessage` into
  // everything else sharing that context and leave the last one behind for good.
  runStepsDetached(steps, childContext(conn.context, extra), conn.def)
    .catch(e => console.error(`[WS] ${key} error:`, e));
}

export class WsNode extends Node {
  /**
   * Connections by name, so a page can hold more than one: a chat feed and a
   * live-updates channel are different sockets with different handlers, and the
   * server has no reason to multiplex them.
   *
   * On the node, so they belong to one resolver: two apps on a page each get
   * their own `default`, and `resolver.destroy()` closes only its own.
   */
  readonly connections = new Map<string, Conn>();

  /** Registered on first connect, removed on dispose. */
  visibilityHandler: (() => void) | null = null;

  static schema: JexsNodeSchema = {
    "ws-connect": {
      type: "string",
      output: "null",
      markdownDescription: "Opens a WebSocket connection and resolves once it is open, so a server that never answers reaches an enclosing `catch` rather than failing silently. Pass `then` instead if the sequence should carry on without waiting.\n\nRelative URLs are prefixed with `ws://` or `wss://` to match the page. Pass `on-open`, `on-message` and `on-close` step arrays. After a successful open the connection reconnects on its own with exponential backoff; `retry` controls that.\n\nName the connection to hold more than one at a time. The unnamed connection is the default, and is the one `ws-send`, `ws-close` and `ws-status` act on when they name none.",
      examples: [
        "{ \"ws-connect\": \"/ws\", \"on-message\": [{ \"var\": \"$wsMessage\" }] }",
        "{ \"ws-connect\": \"/feed\", \"name\": \"feed\", \"retry\": 3, \"catch\": [{ \"var\": \"$error.message\" }] }",
      ],
      siblings: {
        name: {
          type: "string",
          description: "Names this connection, so other steps can address it and a second `ws-connect` does not replace it.",
        },
        "on-open": {
          steps: true,
          description: "Steps to run when the connection opens, including after a reconnect.",
        },
        "on-message": {
          steps: true,
          markdownDescription: "Steps to run on each incoming message, with `$wsMessage` in scope: parsed as JSON when it parses, otherwise the raw value. The node reads nothing out of a message itself, so any protocol on top of the socket, an id handed out on connect included, is yours to read here.",
        },
        "on-close": {
          steps: true,
          markdownDescription: "Steps to run when the connection closes, with `$wsCode`, `$wsReason` and `$wsClean` in scope. A dropped connection lands here too, before the reconnect.",
        },
        retry: {
          type: ["boolean", "number"],
          markdownDescription: "Reconnect behavior after a connection that opened is lost. `true` (the default) retries forever with backoff, `false` never retries, and a number caps the attempts. The initial connect is not a retry: it either opens or throws.",
        },
        protocols: {
          type: ["string", "array"],
          description: "Subprotocol names offered during the handshake.",
        },
        binaryType: {
          type: "string",
          enum: BINARY_TYPES,
          description: "How binary messages arrive: `\"blob\"` (the browser default) or `\"arraybuffer\"`.",
        },
      },
    },
    "ws-send": {
      markdownDescription: "Sends data over a connection. Strings go as they are, binary values (`ArrayBuffer`, a typed array, a `Blob`) go as frames, and anything else is JSON-serialized.\n\nA message written while the socket is still opening is queued and flushed on open, since that is an ordinary startup race. Sending with no connection, or after it closed, throws.",
      output: "null",
      examples: [
        "{ \"ws-send\": { \"type\": \"ping\" } }",
        "{ \"ws-send\": { \"var\": \"$frame\" }, \"name\": \"feed\" }",
      ],
      siblings: {
        name: {
          type: "string",
          description: "Which connection to send on (default: the unnamed one).",
        },
      },
    },
    "ws-close": {
      output: "null",
      markdownDescription: "Closes a connection and stops it reconnecting. Pass `code` and `reason` to tell the server why; the defaults are a normal closure.",
      examples: [
        "{ \"ws-close\": true }",
        "{ \"ws-close\": true, \"name\": \"feed\", \"code\": 4001, \"reason\": \"signed out\" }",
      ],
      siblings: {
        name: {
          type: "string",
          description: "Which connection to close (default: the unnamed one).",
        },
        code: {
          type: "number",
          description: "Close code (default `1000`, a normal closure). Application codes are 4000-4999.",
        },
        reason: {
          type: "string",
          description: "Human-readable reason, at most 123 bytes once encoded.",
        },
      },
    },
    "ws-status": {
      output: "string",
      markdownDescription: "Reports the state of a connection, for showing whether the page is live.",
      outputDescription: "`\"open\"`, `\"connecting\"`, `\"closing\"`, `\"closed\"`, or `\"none\"` when nothing by that name was ever opened.",
      examples: [
        "{ \"ws-status\": true }",
        "{ \"ws-status\": true, \"name\": \"feed\" }",
      ],
      siblings: {
        name: {
          type: "string",
          description: "Which connection to report on (default: the unnamed one).",
        },
      },
    },
  };

  ["ws-connect"](def: Record<string, unknown>, context: Context): NodeValue {
    // Named values rather than the whole `def`: the `on-*` siblings are step
    // arrays, and resolving those would run the handlers here at connect time.
    return resolveAll(
      [def["ws-connect"], def.name, def.retry, def.protocols, def.binaryType],
      context,
      ([urlRaw, nameRaw, retry, protocolsRaw, binaryTypeRaw]) => {
        const name = this.toString(nameRaw) || DEFAULT;
        const binaryType = this.getOption(binaryTypeRaw, BINARY_TYPES, "ws binaryType");
        const protocols = protocolsRaw == null
          ? undefined
          : Array.isArray(protocolsRaw) ? protocolsRaw.map(String) : String(protocolsRaw);

        // A second connect under the same name replaces the first, rather than
        // leaking a socket nothing can reach any more.
        closeConnection(this, name, 1000, "replaced");

        const conn: Conn = {
          node: this,
          name,
          url: absoluteUrl(this.toString(urlRaw)),
          socket: null,
          def,
          context,
          closing: false,
          retries: retryCount(retry),
          attempts: 0,
          delay: 1000,
          timer: null,
          queue: [],
        };
        this.connections.set(name, conn);
        return openSocket(conn, protocols, binaryType);
      },
    );
  }

  ["ws-send"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def["ws-send"], def.name], context, ([data, nameRaw]) => {
      const name = this.toString(nameRaw) || DEFAULT;
      const conn = this.connections.get(name);
      const frame = typeof data === "string" ? data
        : isBinary(data) ? data
        : JSON.stringify(data);

      if (!conn || !conn.socket) {
        throw new Error(`ws-send has no "${name}" connection: run ws-connect first`);
      }
      // Opening is a race worth waiting out; closed is a mistake worth reporting.
      if (conn.socket.readyState === WebSocket.CONNECTING) {
        conn.queue.push(frame);
        return null;
      }
      if (conn.socket.readyState !== WebSocket.OPEN) {
        throw new Error(`ws-send cannot use the "${name}" connection: it is ${statusOf(this, name)}`);
      }
      conn.socket.send(frame);
      return null;
    });
  }

  ["ws-close"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.name, def.code, def.reason], context, ([nameRaw, code, reason]) => {
      closeConnection(
        this,
        this.toString(nameRaw) || DEFAULT,
        code == null ? 1000 : this.toNumber(code),
        reason == null ? "" : this.toString(reason),
      );
      return null;
    });
  }

  ["ws-status"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.name, context, name =>
      statusOf(this, this.toString(name) || DEFAULT),
    );
  }

  /**
   * Close every connection and drop the visibility listener. Called by
   * `resolver.destroy()`, which is what makes the sockets a resolver's to clean
   * up rather than the process's. `dispose` is exempt from the rule that every
   * method on a Node is a dispatch key.
   */
  dispose(): void {
    for (const name of [...this.connections.keys()]) closeConnection(this, name, 1000, "");
    if (this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }
}

// The helpers below take the node rather than living on it: every method on a
// Node registers as a dispatch key, so only the ops and `dispose` can be methods.

/**
 * Open the socket, resolving when it opens and rejecting if it closes first.
 * Awaiting the handshake is what lets a failed connect reach `catch`: a step
 * that returned before the socket settled would be long gone by then.
 */
function openSocket(conn: Conn, protocols?: string | string[], binaryType?: BinaryType): Promise<null> {
  // Lazy-init the visibility handler on first connect (idempotent, safe to call
  // repeatedly). Done here rather than at module top level so the module can be
  // imported in Node.js (e.g. by the schema generator) without touching `document`.
  initVisibility(conn.node);
  const socket = protocols === undefined ? new WebSocket(conn.url) : new WebSocket(conn.url, protocols);
  if (binaryType) socket.binaryType = binaryType;
  conn.socket = socket;

  return new Promise<null>((settled, failed) => {
    let opened = false;

    socket.onopen = () => {
      opened = true;
      conn.attempts = 0;
      conn.delay = 1000;
      for (const frame of conn.queue.splice(0)) socket.send(frame);
      run(conn, "on-open", {});
      settled(null);
    };

    socket.onmessage = (e: MessageEvent) => {
      let data: unknown;
      try {
        data = JSON.parse(e.data);
      } catch {
        data = e.data;
      }
      run(conn, "on-message", { wsMessage: data });
    };

    socket.onclose = (e: CloseEvent) => {
      conn.socket = null;
      // Before it ever opened, the close IS the failure: there is no separate
      // error event worth listening for, since the spec fires close after error
      // and the error event carries no detail by design.
      if (!opened) {
        conn.node.connections.delete(conn.name);
        failed(new Error(
          `WebSocket to ${conn.url} failed to open (code ${e.code}${e.reason ? `: ${e.reason}` : ""})`,
        ));
        return;
      }
      run(conn, "on-close", { wsCode: e.code, wsReason: e.reason, wsClean: e.wasClean });
      if (!conn.closing && conn.attempts < conn.retries) scheduleReconnect(conn);
      else if (!conn.closing) conn.node.connections.delete(conn.name);
    };
  });
}

function scheduleReconnect(conn: Conn): void {
  if (conn.timer) return;
  conn.timer = setTimeout(() => {
    conn.timer = null;
    if (conn.socket || conn.closing) return;
    conn.attempts += 1;
    // A reconnect is detached from any step, so its failure has nowhere to be
    // caught; the next close schedules the next attempt.
    void openSocket(conn).catch(() => { /* handled by the close that follows */ });
  }, conn.delay);
  conn.delay = Math.min(conn.delay * 2, 30000);
}

function closeConnection(node: WsNode, name: string, code: number, reason: string): void {
  const conn = node.connections.get(name);
  if (!conn) return;
  conn.closing = true;
  if (conn.timer) {
    clearTimeout(conn.timer);
    conn.timer = null;
  }
  conn.queue.length = 0;
  if (conn.socket) conn.socket.close(code, reason);
  conn.socket = null;
  node.connections.delete(name);
}

function statusOf(node: WsNode, name: string = DEFAULT): string {
  const socket = node.connections.get(name)?.socket;
  if (!socket) return node.connections.has(name) ? "closed" : "none";
  switch (socket.readyState) {
    case WebSocket.CONNECTING: return "connecting";
    case WebSocket.OPEN: return "open";
    case WebSocket.CLOSING: return "closing";
    default: return "closed";
  }
}

/**
 * Reconnect dropped connections the moment the tab comes back. Only the return
 * to the foreground is worth acting on: while hidden, the backoff timer is
 * itself throttled to once a second and then, after five minutes, once a
 * minute, so a socket that dropped can sit unretried far longer than its own
 * delay says. Going away needs nothing, which is why the handler leaves at once.
 */
function initVisibility(node: WsNode): void {
  if (node.visibilityHandler) return;
  node.visibilityHandler = () => {
    if (document.visibilityState !== "visible") return;
    for (const conn of node.connections.values()) {
      if (conn.socket || conn.closing) continue;
      if (conn.timer) {
        clearTimeout(conn.timer);
        conn.timer = null;
      }
      conn.delay = 1000;
      conn.attempts = 0;
      void openSocket(conn).catch(() => { /* the close handler retries */ });
    }
  };
  document.addEventListener("visibilitychange", node.visibilityHandler);
}
