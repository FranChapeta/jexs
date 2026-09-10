import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import { WsNode } from "../src/nodes/WsNode.js";

// The node is held, not just registered: its connections live on it now, so the
// teardown and the WebRTC accessors both go through the instance.
const wsNode = new WsNode();
const resolve = createResolver([...coreNodes(), wsNode]);

/**
 * A WebSocket stand-in. The node is written against the browser API, so the
 * tests drive that API rather than a transport: `accept()` completes the
 * handshake, `deliver()` pushes a message, `drop()` closes with a code.
 */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static live: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  binaryType = "blob";
  sent: unknown[] = [];
  closedWith: { code: number; reason: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string; wasClean: boolean }) => void) | null = null;

  constructor(readonly url: string, readonly protocols?: string | string[]) {
    FakeSocket.live.push(this);
  }

  send(frame: unknown): void { this.sent.push(frame); }

  close(code = 1000, reason = ""): void {
    this.closedWith = { code, reason };
    this.readyState = FakeSocket.CLOSED;
  }

  /** Complete the handshake. */
  accept(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  deliver(data: unknown): void {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }

  /** Close from the far end. */
  drop(code = 1006, reason = "", wasClean = false): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean });
  }

  static last(): FakeSocket {
    const socket = FakeSocket.live[FakeSocket.live.length - 1];
    assert.ok(socket, "expected a socket to have been opened");
    return socket;
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
globals.WebSocket = FakeSocket;
globals.location = { protocol: "https:", host: "app.test" };
globals.document = {
  visibilityState: "visible",
  addEventListener: () => { /* the node registers a visibility handler on connect */ },
  removeEventListener: () => { /* and removes it on destroy */ },
};

afterEach(() => {
  wsNode.dispose();
  FakeSocket.live = [];
});

/** Connect, completing the handshake as soon as the socket exists. */
async function connect(def: Record<string, unknown>, ctx: Record<string, unknown> = {}): Promise<FakeSocket> {
  const pending = resolve(def, ctx) as Promise<unknown>;
  FakeSocket.last().accept();
  await pending;
  return FakeSocket.last();
}

test("ws-connect: resolves once open, and makes the url absolute against the page", async () => {
  const socket = await connect({ "ws-connect": "/ws" });
  assert.equal(socket.url, "wss://app.test/ws");
  assert.equal(resolve({ "ws-status": true }, {}), "open");
});

// The step used to return before the socket settled, so a server that never
// answered surfaced nowhere. Awaiting the handshake is what puts it in reach.
test("ws-connect: a connection that never opens reaches catch", async () => {
  const pending = resolve(
    { "ws-connect": "/ws", catch: [{ concat: ["caught: ", { var: "$error.message" }] }] },
    {},
  ) as Promise<unknown>;
  FakeSocket.last().drop(1006, "");
  assert.match(await pending as string, /^caught: WebSocket to wss:\/\/app\.test\/ws failed to open \(code 1006\)/);
  // Nothing is left behind for a later step to find.
  assert.equal(resolve({ "ws-status": true }, {}), "none");
});

test("ws-connect: two named connections coexist", async () => {
  await connect({ "ws-connect": "/chat", name: "chat" });
  await connect({ "ws-connect": "/feed", name: "feed" });
  assert.equal(FakeSocket.live.length, 2);
  assert.equal(resolve({ "ws-status": true, name: "chat" }, {}), "open");
  assert.equal(resolve({ "ws-status": true, name: "feed" }, {}), "open");

  await resolve({ "ws-send": { hello: 1 }, name: "chat" }, {});
  assert.deepEqual(FakeSocket.live[0].sent, ["{\"hello\":1}"]);
  assert.deepEqual(FakeSocket.live[1].sent, []);

  await resolve({ "ws-close": true, name: "chat" }, {});
  assert.equal(resolve({ "ws-status": true, name: "chat" }, {}), "none");
  assert.equal(resolve({ "ws-status": true, name: "feed" }, {}), "open");
});

test("ws-connect: protocols and binaryType reach the socket", async () => {
  const socket = await connect({ "ws-connect": "/ws", protocols: ["v2", "v1"], binaryType: "arraybuffer" });
  assert.deepEqual(socket.protocols, ["v2", "v1"]);
  assert.equal(socket.binaryType, "arraybuffer");
  assert.throws(
    () => resolve({ "ws-connect": "/ws", binaryType: "buffer" }, {}),
    /Invalid ws binaryType "buffer": expected blob, arraybuffer/,
  );
});

// Defaulting an unreadable retry to Infinity would turn a typo into a socket
// that reconnects forever, which is the failure hardest to notice.
test("ws-connect: retry takes booleans and counts, and refuses anything else", async () => {
  await connect({ "ws-connect": "/ws", retry: false });
  await connect({ "ws-connect": "/ws", retry: 3 });
  await connect({ "ws-connect": "/ws", retry: true });
  for (const retry of ["soon", "", -1]) {
    assert.throws(
      () => resolve({ "ws-connect": "/ws", retry }, {}),
      /Invalid ws retry .*expected true, false, or a number of attempts/,
      `retry: ${JSON.stringify(retry)} should have been refused`,
    );
  }
});

// $wsMessage used to be written onto the captured context, so it outlived the
// handler and leaked into everything else sharing that context.
test("on-message: binds in a child scope, leaving the outer context alone", async () => {
  const ctx: Record<string, unknown> = { wsMessage: "mine", seen: null };
  const pending = resolve(
    { "ws-connect": "/ws", "on-message": [{ setVars: { seen: { var: "$wsMessage" } }, bubble: true }] },
    ctx,
  ) as Promise<unknown>;
  FakeSocket.last().accept();
  await pending;

  FakeSocket.last().deliver({ hello: "there" });
  await new Promise(done => setTimeout(done, 10));

  assert.deepEqual(ctx.seen, { hello: "there" });
  assert.equal(ctx.wsMessage, "mine");
});

// The `steps` schema def has always accepted a lone expression, but the runtime
// required an array and silently ignored anything else.
test("a handler may be a single expression, not only an array", async () => {
  const ctx: Record<string, unknown> = { seen: null };
  const pending = resolve(
    { "ws-connect": "/ws", "on-message": { setVars: { seen: { var: "$wsMessage" } }, bubble: true } },
    ctx,
  ) as Promise<unknown>;
  FakeSocket.last().accept();
  await pending;

  FakeSocket.last().deliver({ hello: "there" });
  await new Promise(done => setTimeout(done, 10));
  assert.deepEqual(ctx.seen, { hello: "there" });
});

test("on-close: the code and reason reach the steps", async () => {
  const ctx: Record<string, unknown> = {};
  const pending = resolve(
    {
      "ws-connect": "/ws",
      retry: false,
      "on-close": [{ setVars: { why: { concat: [{ var: "$wsCode" }, " ", { var: "$wsReason" }, " ", { var: "$wsClean" }] } }, bubble: true }],
    },
    ctx,
  ) as Promise<unknown>;
  FakeSocket.last().accept();
  await pending;

  FakeSocket.last().drop(4001, "policy", false);
  await new Promise(done => setTimeout(done, 10));
  assert.equal(ctx.why, "4001 policy false");
});

test("ws-close: the code and reason reach the server", async () => {
  const socket = await connect({ "ws-connect": "/ws" });
  await resolve({ "ws-close": true, code: 4002, reason: "signed out" }, {});
  assert.deepEqual(socket.closedWith, { code: 4002, reason: "signed out" });
});

test("ws-send: queued while opening, flushed on open", async () => {
  const pending = resolve({ "ws-connect": "/ws" }, {}) as Promise<unknown>;
  const socket = FakeSocket.last();
  // Written before the handshake finishes: an ordinary startup race, not an error.
  await resolve({ "ws-send": "early" }, {});
  assert.deepEqual(socket.sent, []);
  socket.accept();
  await pending;
  assert.deepEqual(socket.sent, ["early"]);
});

test("ws-send: with no connection, or after close, throws rather than dropping", async () => {
  await assert.rejects(
    async () => { await resolve({ "ws-send": "x" }, {}); },
    /ws-send has no "default" connection: run ws-connect first/,
  );
  const socket = await connect({ "ws-connect": "/ws", retry: false });
  socket.drop(1006, "");
  await new Promise(done => setTimeout(done, 10));
  await assert.rejects(
    async () => { await resolve({ "ws-send": "x" }, {}); },
    /ws-send has no "default" connection/,
  );
});

test("ws-send: binary goes as a frame, objects as JSON", async () => {
  const socket = await connect({ "ws-connect": "/ws" });
  const bytes = new Uint8Array([1, 2, 3]);
  await resolve({ "ws-send": { var: "$bytes" } }, { bytes });
  await resolve({ "ws-send": { a: 1 } }, {});
  await resolve({ "ws-send": "raw" }, {});
  assert.equal(socket.sent[0], bytes);
  assert.equal(socket.sent[1], "{\"a\":1}");
  assert.equal(socket.sent[2], "raw");
});

test("ws-status: reports every state, and none for a name never opened", async () => {
  assert.equal(resolve({ "ws-status": true, name: "nope" }, {}), "none");
  const pending = resolve({ "ws-connect": "/ws" }, {}) as Promise<unknown>;
  assert.equal(resolve({ "ws-status": true }, {}), "connecting");
  FakeSocket.last().accept();
  await pending;
  assert.equal(resolve({ "ws-status": true }, {}), "open");
});

// The node used to sniff `{ type: "welcome" }` off the wire to bind `$wsId`, and
// to send `{ type: "presence" }` on every visibility change. Both were an
// application protocol invented by a transport, and nothing on the other end
// had agreed to either.
test("no protocol of its own: a message is passed through untouched", async () => {
  const ctx: Record<string, unknown> = {};
  await connect({
    "ws-connect": "/ws",
    "on-message": [{ setVars: { seen: { var: "$wsMessage" } }, bubble: true }],
  }, ctx);

  const socket = FakeSocket.last();
  socket.deliver({ type: "welcome", id: "client-7" });
  await new Promise(done => setTimeout(done, 10));

  // Read whole, interpreted by the template, not by the node.
  assert.deepEqual(ctx.seen, { type: "welcome", id: "client-7" });
  assert.deepEqual(socket.sent, [], "nothing is sent that the template did not ask for");
});

// The point of moving the registry onto the node: two resolvers on one page do
// not share sockets, and one resolver's teardown leaves the other alone.
test("two nodes keep their own connections", async () => {
  const other = new WsNode();
  const otherResolve = createResolver([...coreNodes(), other]);
  await connect({ "ws-connect": "/ws" });
  const pending = otherResolve({ "ws-connect": "/ws" }, {}) as Promise<unknown>;
  FakeSocket.last().accept();
  await pending;

  assert.equal(wsNode.connections.size, 1);
  assert.equal(other.connections.size, 1);
  assert.notEqual(wsNode.connections.get("default"), other.connections.get("default"));

  other.dispose();
  assert.equal(other.connections.size, 0);
  assert.equal(resolve({ "ws-status": true }, {}), "open");
});
