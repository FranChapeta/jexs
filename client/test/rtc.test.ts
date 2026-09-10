import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import { WebRTCNode } from "../src/nodes/WebRTCNode.js";

/**
 * WebRTC stand-ins. The node is written against the browser API, so the tests
 * drive that API rather than a transport: `open()` brings a channel up,
 * `receiveChannels()` plays the remote opening channels toward us, `trickle()`
 * emits a candidate.
 *
 * There is no socket stub anywhere in this file. Signalling is just steps now,
 * so an `on-signal` that records into the context is the whole transport.
 */
class FakeChannel {
  readyState = "connecting";
  bufferedAmount = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly label: string) {}

  send(frame: unknown): void { this.sent.push(frame); }
  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.onclose?.();
  }

  open(): void { this.readyState = "open"; this.onopen?.(); }
  deliver(data: unknown): void {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }
}

interface Description { type: string; sdp: string }

class FakePeer {
  static live: FakePeer[] = [];

  connectionState = "new";
  iceGatheringState = "new";
  localDescription: Description | null = null;
  remoteDescription: Description | null = null;
  channels: FakeChannel[] = [];
  added: Record<string, unknown>[] = [];
  closed = false;
  onicecandidate: ((e: { candidate: { toJSON(): Record<string, unknown> } | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((e: { channel: FakeChannel }) => void) | null = null;
  private gathering = new Set<() => void>();

  constructor(readonly config: { iceServers: unknown[] }) { FakePeer.live.push(this); }

  createDataChannel(label: string): FakeChannel {
    const channel = new FakeChannel(label);
    this.channels.push(channel);
    return channel;
  }
  createOffer(): Promise<Description> { return Promise.resolve({ type: "offer", sdp: "v=0 offer" }); }
  createAnswer(): Promise<Description> { return Promise.resolve({ type: "answer", sdp: "v=0 answer" }); }
  setLocalDescription(d: Description): Promise<void> { this.localDescription = { ...d }; return Promise.resolve(); }
  setRemoteDescription(d: Description): Promise<void> { this.remoteDescription = { ...d }; return Promise.resolve(); }
  addIceCandidate(c: Record<string, unknown>): Promise<void> { this.added.push(c); return Promise.resolve(); }
  close(): void { this.closed = true; }
  addEventListener(type: string, fn: () => void): void {
    if (type === "icegatheringstatechange") this.gathering.add(fn);
  }
  removeEventListener(_type: string, fn: () => void): void { this.gathering.delete(fn); }

  channel(label: string): FakeChannel {
    const found = this.channels.find(c => c.label === label);
    assert.ok(found, `expected a "${label}" channel`);
    return found;
  }
  openChannels(): void { for (const c of this.channels) c.open(); }

  /** The dialer's channels arriving at the answering side, already open. */
  receiveChannels(): void {
    for (const label of ["data", "fast"]) {
      const channel = new FakeChannel(label);
      channel.readyState = "open";
      this.channels.push(channel);
      this.ondatachannel?.({ channel });
    }
  }

  trickle(candidate: string): void {
    this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate, sdpMid: "0", sdpMLineIndex: 0 }) } });
  }

  /** Gathering finished; a non-trickle description carries the candidates inline. */
  finishGathering(): void {
    this.iceGatheringState = "complete";
    if (this.localDescription) this.localDescription.sdp += "\na=candidate:1 udp";
    for (const fn of [...this.gathering]) fn();
  }

  fail(): void { this.connectionState = "failed"; this.onconnectionstatechange?.(); }

  static last(): FakePeer {
    const peer = FakePeer.live[FakePeer.live.length - 1];
    assert.ok(peer, "expected a peer connection to have been created");
    return peer;
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
globals.RTCPeerConnection = FakePeer;
globals.RTCIceCandidate = class {
  constructor(init: Record<string, unknown>) { Object.assign(this, init); }
};

const rtcNode = new WebRTCNode();
const resolve = createResolver([...coreNodes(), rtcNode]);

const tick = (): Promise<void> => new Promise(done => { setTimeout(done, 0); });

/** The whole transport: append every emitted payload to `$sent`, in place. */
const RECORD = { push: [{ var: "$sent" }, { var: "$rtcSignal" }] };

interface Ctx extends Record<string, unknown> { sent: unknown[]; seen: unknown[] }
const base = (): Ctx => ({ sent: [], seen: [] });

/** Register with the recording sink, plus any extra siblings under test. */
async function listen(ctx: Ctx, extra: Record<string, unknown> = {}): Promise<void> {
  await resolve({ rtc: "listen", "on-signal": RECORD, ...extra }, ctx);
}

const OFFER = { type: "offer", sdp: "v=0 remote offer" };
const ANSWER = { type: "answer", sdp: "v=0 remote answer" };
const CANDIDATE = { candidate: "candidate:1 1 udp 1 10.0.0.1 5000 typ host", sdpMid: "0", sdpMLineIndex: 0 };

afterEach(() => {
  rtcNode.dispose();
  FakePeer.live = [];
});

test("connect blocks until both channels are open, then yields the peer id", async () => {
  const ctx = base();
  await listen(ctx);

  let settled = false;
  const dialing = resolve({ "rtc-connect": "B" }, ctx) as Promise<unknown>;
  void dialing.then(() => { settled = true; }, () => { settled = true; });

  await tick();
  assert.equal(settled, false, "connect returned before anything opened");

  const peer = FakePeer.last();
  peer.channel("data").open();
  await tick();
  assert.equal(settled, false, "one open channel is not a usable peer");

  peer.channel("fast").open();
  assert.equal(await dialing, "B");
});

test("connect emits an offer through on-signal, in the browser's own shape", async () => {
  const ctx = base();
  await listen(ctx);
  const dialing = resolve({ "rtc-connect": "B", timeout: 40 }, ctx) as Promise<unknown>;
  dialing.catch(() => { /* left to time out */ });
  await tick();

  assert.deepEqual(ctx.sent, [{ type: "offer", sdp: "v=0 offer" }]);
  // No `sdpType` rename and no addressing: a non-Jexs peer takes this verbatim.
  const offer = ctx.sent[0] as Record<string, unknown>;
  assert.deepEqual(Object.keys(offer).sort(), ["sdp", "type"]);
});

test("connect rejects on timeout, where catch can see it", async () => {
  const ctx = base();
  await listen(ctx);
  const message = await resolve(
    { "rtc-connect": "B", timeout: 20, catch: [{ var: "$error.message" }] },
    ctx,
  );
  assert.match(String(message), /rtc-connect to "B" timed out after 20ms/);
  assert.equal(FakePeer.last().closed, true, "a timed-out dial should not leave the peer open");
});

test("connect refuses without a prior listen, since an offer would have nowhere to go", async () => {
  await assert.rejects(
    async () => { await resolve({ "rtc-connect": "B" }, base()); },
    /rtc-connect needs a prior rtc "listen"/,
  );
});

test("an inbound offer is answered with no signalling logic in the template", async () => {
  const ctx = base();
  await listen(ctx);

  await resolve({ "rtc-signal": "A", data: OFFER }, ctx);
  await tick();

  assert.deepEqual(ctx.sent, [{ type: "answer", sdp: "v=0 answer" }]);
  assert.deepEqual(FakePeer.last().remoteDescription, OFFER);
});

test("on-peer refuses by resolving falsy: nothing is signalled back", async () => {
  const ctx = base();
  await listen(ctx, { "on-peer": { push: [{ var: "$seen" }, { var: "$rtcPeerId" }] } });
  // `push` returns the array, which is truthy, so the peer above is admitted.
  await resolve({ "rtc-signal": "A", data: OFFER }, ctx);
  await tick();
  assert.equal(ctx.sent.length, 1, "a truthy on-peer should have answered");

  await listen(ctx, { "on-peer": { not: true } });
  ctx.sent.length = 0;
  await resolve({ "rtc-signal": "B", data: OFFER }, ctx);
  await tick();
  assert.deepEqual(ctx.sent, [], "a refused peer must not be answered");
  assert.equal(await resolve({ "rtc-status": "B" }, ctx), "none");
});

// The security argument in one test: a payload can say whatever it likes, and
// the node still believes only the `from` its transport vouched for.
test("from comes from the sibling, never from inside the payload", async () => {
  const ctx = base();
  await listen(ctx, { "on-open": { push: [{ var: "$seen" }, { var: "$rtcPeerId" }] } });

  const forged = { ...OFFER, from: "victim", to: "victim" };
  await resolve({ "rtc-signal": "attacker", data: forged }, ctx);
  await tick();

  FakePeer.last().receiveChannels();
  await tick();
  assert.deepEqual(ctx.seen, ["attacker"]);
  assert.equal(await resolve({ "rtc-status": "victim" }, ctx), "none");
});

test("signal refuses what is neither a description nor a candidate", async () => {
  const ctx = base();
  await listen(ctx);
  await assert.rejects(
    async () => { await resolve({ "rtc-signal": "A", data: { hello: "there" } }, ctx); },
    /must be a session description .* or an ICE candidate/,
  );
  await assert.rejects(
    async () => { await resolve({ "rtc-signal": "A", data: "nope" }, ctx); },
    /must be a session description or an ICE candidate, got string/,
  );
  await assert.rejects(
    async () => { await resolve({ "rtc-signal": "A", data: { type: "offer" } }, ctx); },
    /rtc-signal offer carries no sdp/,
  );
});

test("signal names its peer as the value, and refuses without one", async () => {
  const ctx = base();
  await listen(ctx);
  await assert.rejects(
    async () => { await resolve({ "rtc-signal": undefined, data: OFFER }, ctx); },
    /rtc-signal needs the peer the payload came from/,
  );
});

test("signal refuses before any listen", async () => {
  await assert.rejects(
    async () => { await resolve({ "rtc-signal": "A", data: OFFER }, base()); },
    /rtc-signal needs a prior rtc "listen"/,
  );
});

test("an answer for a peer that was never dialed is a failure, not a silent drop", async () => {
  const ctx = base();
  await listen(ctx);
  await assert.rejects(
    async () => { await resolve({ "rtc-signal": "ghost", data: ANSWER }, ctx); },
    /rtc-signal has no pending connection to "ghost"/,
  );
});

// Whichever side signals first loses its candidates unless they are queued
// against a peer that does not exist yet.
test("a candidate arriving before the offer is queued, then applied", async () => {
  const ctx = base();
  await listen(ctx);

  await resolve({ "rtc-signal": "A", data: CANDIDATE }, ctx);
  assert.equal(FakePeer.live.length, 0, "a candidate must not conjure a peer");

  await resolve({ "rtc-signal": "A", data: OFFER }, ctx);
  await tick();

  const peer = FakePeer.last();
  assert.equal(peer.added.length, 1);
  assert.equal((peer.added[0] as { candidate: string }).candidate, CANDIDATE.candidate);
});

test("on-message binds the message, the peer and the channel it came over", async () => {
  const ctx = base();
  await listen(ctx, {
    "on-message": {
      push: [{ var: "$seen" }, { concat: [
        { var: "$rtcPeerId" }, "/", { var: "$rtcChannel" }, "/", { var: "$rtcMessage.n" },
      ] }],
    },
  });

  const dialing = resolve({ "rtc-connect": "B", timeout: 200 }, ctx) as Promise<unknown>;
  await tick();
  const peer = FakePeer.last();
  peer.openChannels();
  await dialing;

  peer.channel("data").deliver({ n: 1 });
  peer.channel("fast").deliver({ n: 2 });
  await tick();
  assert.deepEqual(ctx.seen, ["B/data/1", "B/fast/2"]);
});

test("send refuses an unknown peer and an unlisted channel", async () => {
  const ctx = base();
  await listen(ctx);
  await assert.rejects(
    async () => { await resolve({ "rtc-send": "nobody", data: { a: 1 } }, ctx); },
    /rtc-send has no data channel to "nobody"/,
  );
  await assert.rejects(
    async () => { await resolve({ "rtc-send": "nobody", data: { a: 1 }, channel: "reliable" }, ctx); },
    /Invalid rtc channel "reliable"/,
  );
});

test("status reports none, connecting and open", async () => {
  const ctx = base();
  await listen(ctx);
  assert.equal(await resolve({ "rtc-status": "B" }, ctx), "none");

  const dialing = resolve({ "rtc-connect": "B", timeout: 200 }, ctx) as Promise<unknown>;
  await tick();
  assert.equal(await resolve({ "rtc-status": "B" }, ctx), "connecting");

  FakePeer.last().openChannels();
  await dialing;
  assert.equal(await resolve({ "rtc-status": "B" }, ctx), "open");
});

test("a second listen replaces the handlers of the first", async () => {
  const first = base();
  await listen(first, { "on-peer": { push: [{ var: "$seen" }, "first"] } });

  const second = base();
  await listen(second, { "on-peer": { push: [{ var: "$seen" }, "second"] } });

  await resolve({ "rtc-signal": "A", data: OFFER }, second);
  await tick();
  assert.deepEqual(first.seen, []);
  assert.deepEqual(second.seen, ["second"]);
  assert.deepEqual(first.sent, [], "the replaced sink should be silent too");
});

test("listen without on-signal is refused: an offer would have nowhere to go", async () => {
  await assert.rejects(
    async () => { await resolve({ rtc: "listen" }, base()); },
    /rtc "listen" needs "on-signal"/,
  );
});

test("iceServers reach the connection, and a malformed entry throws", async () => {
  const ctx = base();
  const servers = [{ urls: "turn:turn.test:3478", username: "u", credential: "p" }];
  await listen(ctx, { iceServers: servers });

  const dialing = resolve({ "rtc-connect": "B", timeout: 40 }, ctx) as Promise<unknown>;
  dialing.catch(() => { /* left to time out */ });
  await tick();
  assert.deepEqual(FakePeer.last().config.iceServers, servers);

  await assert.rejects(
    async () => { await listen(base(), { iceServers: [{ url: "turn:typo" }] }); },
    /rtc iceServers entries need a `urls` string/,
  );
});

// One payload each way is what a human can carry; fifteen trickled candidates
// is not.
test("trickle false emits no candidates, and one description carrying them all", async () => {
  const ctx = base();
  await listen(ctx, { trickle: false });

  const dialing = resolve({ "rtc-connect": "B", timeout: 200 }, ctx) as Promise<unknown>;
  await tick();

  const peer = FakePeer.last();
  peer.trickle("candidate:1 1 udp 1 10.0.0.1 5000 typ host");
  await tick();
  assert.deepEqual(ctx.sent, [], "nothing goes out until gathering completes");

  peer.finishGathering();
  await tick();
  assert.equal(ctx.sent.length, 1);
  assert.match(String((ctx.sent[0] as Description).sdp), /a=candidate:1 udp/);

  peer.openChannels();
  await dialing;
});

test("trickle on by default emits each candidate as it is found", async () => {
  const ctx = base();
  await listen(ctx);
  const dialing = resolve({ "rtc-connect": "B", timeout: 40 }, ctx) as Promise<unknown>;
  dialing.catch(() => { /* left to time out */ });
  await tick();

  FakePeer.last().trickle("candidate:2 1 udp 1 10.0.0.2 5000 typ host");
  await tick();
  assert.equal(ctx.sent.length, 2, "the offer, then the candidate");
  assert.equal((ctx.sent[1] as { candidate: string }).candidate, "candidate:2 1 udp 1 10.0.0.2 5000 typ host");
});

test("on-close fires for a peer that opened, and not for one that never did", async () => {
  const ctx = base();
  await listen(ctx, { "on-close": { push: [{ var: "$seen" }, { var: "$rtcPeerId" }] } });

  // Never opened: the rejected dial is the report, so nothing is announced.
  await resolve({ "rtc-connect": "doomed", timeout: 20, catch: [{ var: "$error.message" }] }, ctx);
  await tick();
  assert.deepEqual(ctx.seen, []);

  const dialing = resolve({ "rtc-connect": "B", timeout: 200 }, ctx) as Promise<unknown>;
  await tick();
  FakePeer.last().openChannels();
  await dialing;

  await resolve({ "rtc-close": "B" }, ctx);
  await tick();
  assert.deepEqual(ctx.seen, ["B"]);
});

test("a failed connection tears the peer down", async () => {
  const ctx = base();
  await listen(ctx);
  const dialing = resolve({ "rtc-connect": "B", timeout: 200 }, ctx) as Promise<unknown>;
  await tick();
  const peer = FakePeer.last();
  peer.fail();
  await assert.rejects(dialing, /was closed before it opened/);
  assert.equal(peer.closed, true);
});

test("dispose closes peers, rejects pending dials and forgets the handlers", async () => {
  const node = new WebRTCNode();
  const own = createResolver([...coreNodes(), node]);
  const ctx = base();
  await own({ rtc: "listen", "on-signal": RECORD }, ctx);

  const dialing = own({ "rtc-connect": "B", timeout: 5000 }, ctx) as Promise<unknown>;
  await tick();
  const peer = FakePeer.last();

  node.dispose();
  await assert.rejects(dialing, /was closed before it opened/);
  assert.equal(peer.closed, true);
  assert.equal(node.peers.size, 0);
  assert.equal(node.handlers.size, 0);
  await assert.rejects(
    async () => { await own({ "rtc-connect": "C" }, ctx); },
    /needs a prior rtc "listen"/,
  );
});

// The property the whole design buys: negotiation with no transport at all,
// the two sinks feeding each other's `signal` by hand.
test("two nodes negotiate end to end with nothing between them", async () => {
  const a = new WebRTCNode();
  const b = new WebRTCNode();
  const runA = createResolver([...coreNodes(), a]);
  const runB = createResolver([...coreNodes(), b]);
  const ctxA = base();
  const ctxB = base();
  const OPENED = { push: [{ var: "$seen" }, { concat: [{ var: "$rtcPeerId" }, "/", { var: "$rtcInbound" }] }] };

  await runA({ rtc: "listen", "on-signal": RECORD, "on-open": OPENED }, ctxA);
  await runB({ rtc: "listen", "on-signal": RECORD, "on-open": OPENED }, ctxB);

  const dialing = runA({ "rtc-connect": "b", timeout: 2000 }, ctxA) as Promise<unknown>;
  await tick();

  // A's offer, carried by the test instead of a socket.
  await runB({ "rtc-signal": "a", data: ctxA.sent.shift() }, ctxB);
  await tick();
  // B's answer, carried back.
  await runA({ "rtc-signal": "b", data: ctxB.sent.shift() }, ctxA);
  await tick();

  const [peerA, peerB] = FakePeer.live;
  peerB.receiveChannels();
  peerA.openChannels();

  assert.equal(await dialing, "b");
  assert.deepEqual(ctxA.seen, ["b/false"], "a dialed peer is not inbound");
  assert.deepEqual(ctxB.seen, ["a/true"], "and the answering side sees the mirror");

  a.dispose();
  b.dispose();
});
