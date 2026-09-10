import { Node, Context, NodeValue, childContext, runStepsDetached } from "@jexs/core";
import { resolve, resolveAll } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";

const FAST_BUFFERED_AMOUNT_LIMIT = 128 * 1024;
const FAST_COALESCE_FLUSH_MS = 16;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_ICE_SERVERS: readonly RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

/** A handler registered by `listen`, kept with the step that registered it so a
 *  `catch` on that step still applies when it fires long after it returned. */
interface Handler {
  body: unknown;
  context: Context;
  def: Record<string, unknown>;
}

/** A dial waiting for its peer's channels to open. */
interface PendingOpen {
  settle: (peerId: string) => void;
  fail: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Shared sibling defs, declared before the class so the static schema
// initializer can read them (a `const` is not hoisted).

/** The operations that take no primary value, so they fold into the bare `rtc`
 *  key rather than each claiming one, the way StorageNode and CacheNode split
 *  theirs. Everything peer-scoped names its peer, so it gets its own key.
 *
 *  Shared by the schema `enum` and the runtime check, so neither can drift. */
const RTC_OPS = ["listen", "close-all"] as const;

const RTC_CHANNELS = ["data", "fast"] as const;
type ChannelKind = typeof RTC_CHANNELS[number];

const HANDLER_KEYS = ["on-signal", "on-peer", "on-open", "on-message", "on-close"] as const;
type HandlerKey = typeof HANDLER_KEYS[number];

const RTC_CHANNEL = {
  type: "string" as const,
  enum: RTC_CHANNELS,
  description: "Data channel: `\"data\"` (reliable) or `\"fast\"` (unreliable, low-latency).",
};

export class WebRTCNode extends Node {
  static schema: JexsNodeSchema = {
    rtc: {
      type: "string",
      enum: RTC_OPS,
      markdownDescription: "The two WebRTC operations that name no peer. Everything peer-scoped has its own key: `rtc-connect`, `rtc-signal`, `rtc-send`, `rtc-broadcast`, `rtc-close`, `rtc-status`.\nThe node never touches a socket: it hands each signalling payload to your `on-signal` steps to deliver however you like (a WebSocket, `fetch`, `window-run`, even a copy-paste box), and you hand replies back with `rtc-signal`.",
      examples: [
        "{ \"rtc\": \"listen\", \"on-signal\": { \"ws-send\": { \"var\": \"$rtcSignal\" } } }",
        "{ \"rtc\": \"close-all\" }",
      ],
      variants: {
        listen: {
          output: "null",
          markdownDescription: "Registers the signalling sink and the peer handlers, and configures ICE. Run by **both** sides: the answering peer never calls `rtc-connect`, so this is its only chance to supply them.\nCreates nothing by itself. A second `listen` replaces the first.",
          examples: [
            "{ \"rtc\": \"listen\", \"on-signal\": { \"ws-send\": { \"type\": \"peer-signal\", \"to\": { \"var\": \"$rtcPeerId\" }, \"sig\": { \"var\": \"$rtcSignal\" } } } }",
          ],
          siblings: {
            iceServers: {
              type: "array",
              markdownDescription: "ICE servers to gather candidates from. Defaults to a public STUN server, which is **not** enough for peers behind a symmetric NAT: those need a TURN entry with credentials.",
              items: {
                properties: {
                  urls: {
                    type: ["string", "array"],
                    description: "One server URL, or several: `stun:host:port` or `turn:host:port`.",
                  },
                  username: { type: "string", description: "TURN username." },
                  credential: { type: "string", description: "TURN credential." },
                },
              },
            },
            timeout: {
              type: "number",
              description: "Default milliseconds a `connect` waits for its peer to open. Defaults to 15000.",
            },
            trickle: {
              type: "boolean",
              markdownDescription: "Whether ICE candidates are signalled as they are found (the default). Set `false` to emit nothing until gathering completes, then one description carrying every candidate inline: slower to connect, but it reduces the exchange to a single payload each way, which is what a human-carried transport needs.",
            },
            "on-signal": {
              steps: true,
              required: true,
              markdownDescription: "Steps that deliver one signalling payload, with `$rtcSignal` (the payload, opaque) and `$rtcPeerId` (who it is for) in scope. Required: without it an offer has nowhere to go.",
            },
            "on-peer": {
              steps: true,
              markdownDescription: "Steps run when a peer offers us a connection, **before** anything is answered, with `$rtcPeerId` in scope. Resolve to a falsy value to refuse: nothing is signalled back and the peer is dropped. This is the only point at which refusing is still possible.",
            },
            "on-open": {
              steps: true,
              markdownDescription: "Steps run when a peer's channels are open and `send` is safe, with `$rtcPeerId` and `$rtcInbound` in scope. Fires for peers arriving from either direction, which makes it the answering side's only way to learn this.",
            },
            "on-message": {
              steps: true,
              markdownDescription: "Steps run on each incoming message, with `$rtcMessage`, `$rtcPeerId` and `$rtcChannel` (`\"data\"` or `\"fast\"`) in scope.",
            },
            "on-close": {
              steps: true,
              markdownDescription: "Steps run when a peer that had opened goes away, with `$rtcPeerId` in scope. A refused offer or a dial that timed out never opened, and is reported by that step instead.",
            },
          },
        },
        "close-all": {
          output: "null",
          markdownDescription: "Closes every peer connection.",
        },
      },
    },

    "rtc-connect": {
      type: "string",
      output: "string",
      outputDescription: "The peer id, once **both** channels are open, so a `send` on either is safe immediately. Most templates put their \"peer is usable\" logic in `on-open` instead, since that covers peers arriving from either direction; what `rtc-connect` adds is carrying a failed dial to `catch`.",
      markdownDescription: "Dials the given peer: creates the connection and both data channels, emits an offer through `on-signal`, and waits for the channels to open. Rejects on `timeout`, on a failed connection, and if the peer closes while waiting.\nUse `then` for the non-blocking version.",
      examples: [
        "{ \"rtc-connect\": { \"var\": \"$peerId\" } }",
      ],
      siblings: {
        timeout: {
          type: "number",
          description: "Milliseconds to wait for the channels to open before giving up. Defaults to the `listen` value.",
        },
      },
    },

    "rtc-signal": {
      type: "string",
      output: "null",
      markdownDescription: "Feeds one received signalling payload back in. **The value is the peer it came FROM**, not one to send to: this is the counterpart to `on-signal`, and the only way anything reaches the node from another peer.\nThat peer is read only from here and never from inside `data`, so a relay that stamps it from the connection stays the authority on identity. `data` is the payload verbatim: a session description (`{ type, sdp }`) or an ICE candidate (`{ candidate, sdpMid, sdpMLineIndex }`).",
      examples: [
        "{ \"rtc-signal\": { \"var\": \"$wsMessage.from\" }, \"data\": { \"var\": \"$wsMessage.sig\" } }",
      ],
      siblings: {
        data: { required: true, description: "The signalling payload, exactly as it was emitted." },
      },
    },

    "rtc-send": {
      type: "string",
      output: "null",
      markdownDescription: "Sends `data` to the given peer over the chosen channel. Throws when there is no such channel or it is not open.",
      examples: [
        "{ \"rtc-send\": { \"var\": \"$peer\" }, \"data\": { \"var\": \"$state\" }, \"channel\": \"fast\" }",
      ],
      siblings: {
        data: { required: true, description: "Data to send. Non-string values are JSON-encoded." },
        channel: RTC_CHANNEL,
      },
    },

    "rtc-broadcast": {
      output: "null",
      markdownDescription: "Sends the value to every connected peer. The one operation with no peer to name, so the data takes the value slot.\nUnlike `rtc-send`, a peer that is not ready is skipped rather than refused: a broadcast addresses whoever is currently there.",
      examples: [
        "{ \"rtc-broadcast\": { \"var\": \"$state\" }, \"channel\": \"fast\" }",
      ],
      siblings: { channel: RTC_CHANNEL },
    },

    "rtc-close": {
      type: "string",
      output: "null",
      markdownDescription: "Closes one peer connection. Use `{ \"rtc\": \"close-all\" }` for every peer at once.",
    },

    "rtc-status": {
      type: "string",
      output: "string",
      outputDescription: "`\"open\"`, `\"connecting\"`, `\"closed\"`, or `\"none\"` when there is no such peer.",
      markdownDescription: "Reports the state of one peer, for showing whether it is reachable.",
      examples: [
        "{ \"rtc-status\": { \"var\": \"$peer\" } }",
      ],
    },
  };

  // Everything below belongs to this node, so it belongs to one resolver: two
  // apps on a page get their own peers rather than sharing a process-wide table,
  // and `resolver.destroy()` has something it can reach. There is no socket here
  // and no identity, because signalling is a seam the template fills: the node
  // never learns how a payload travelled or who it decided the sender was.

  readonly peers = new Map<string, RTCPeerConnection>();
  readonly channels = new Map<string, RTCDataChannel>();
  readonly fastChannels = new Map<string, RTCDataChannel>();

  /** Candidates that arrived before the peer or its remote description did. */
  readonly pendingIce = new Map<string, RTCIceCandidateInit[]>();

  /** Dials blocked until their channels open. */
  readonly pendingOpens = new Map<string, PendingOpen>();

  /** Peers that actually reached open, so `on-close` fires only for those. */
  readonly opened = new Set<string>();

  /** Peers that dialed us, for `$rtcInbound`. */
  readonly inbound = new Set<string>();

  /** Registered by `listen`, replaced wholesale by the next one. */
  readonly handlers = new Map<HandlerKey, Handler>();

  readonly pendingFastCoalescedByKey = new Map<string, { peerId: string; data: unknown }>();
  fastCoalesceFlushScheduled = false;
  fastCoalesceProcessing = false;

  iceServers: readonly RTCIceServer[] = DEFAULT_ICE_SERVERS;
  timeout = DEFAULT_TIMEOUT_MS;
  trickle = true;
  listening = false;

  // Values are resolved and coerced in these methods rather than in the helpers
  // below, because the coercion helpers are members and every member of a Node
  // is a dispatch key: only the ops and `dispose` can be methods.

  rtc(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.rtc, context, raw => {
      switch (this.getOption(raw, RTC_OPS, "rtc operation")) {
        case "listen":
          return resolveAll([def.iceServers, def.timeout, def.trickle], context, ([ice, ms, trickle]) =>
            doListen(this, def, context, {
              iceServers: iceServersFrom(ice),
              timeout: ms == null ? DEFAULT_TIMEOUT_MS : this.toNumber(ms),
              trickle: trickle == null ? true : this.toBoolean(trickle),
            }));

        case "close-all":
          return closeAll(this);

        default:
          // `getOption` has already refused anything unlisted, so this is the
          // absent case: `{ "rtc": null }` names no operation at all.
          throw new Error(`rtc needs an operation: expected ${RTC_OPS.join(", ")}`);
      }
    });
  }

  ["rtc-connect"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def["rtc-connect"], def.timeout], context, ([id, ms]) =>
      doConnect(this, this.toString(id), ms == null ? this.timeout : this.toNumber(ms)));
  }

  ["rtc-signal"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def["rtc-signal"], def.data], context, ([from, data]) => {
      // The peer is the primary value, not a field of the payload, and that
      // placement is the security rule made visible: the node cannot see who
      // sent anything, so whatever the transport vouched for is the only
      // identity there is.
      if (from == null || this.toString(from) === "") {
        throw new Error("rtc-signal needs the peer the payload came from as its value");
      }
      return doSignal(this, data, this.toString(from));
    });
  }

  // `channel` is checked with getOption rather than compared: an unlisted name
  // used to fall through to the reliable channel, which is not what the step said.
  ["rtc-send"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def["rtc-send"], def.data, def.channel], context, ([id, data, ch]) =>
      doSend(this, this.toString(id), data, this.getOption(ch, RTC_CHANNELS, "rtc channel") ?? "data"));
  }

  ["rtc-broadcast"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def["rtc-broadcast"], def.channel], context, ([data, ch]) =>
      doBroadcast(this, data, this.getOption(ch, RTC_CHANNELS, "rtc channel") ?? "data"));
  }

  ["rtc-close"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["rtc-close"], context, id => {
      closePeer(this, this.toString(id));
      return null;
    });
  }

  ["rtc-status"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["rtc-status"], context, id => statusOf(this, this.toString(id)));
  }

  /** Closes every peer connection. Called by `resolver.destroy()`. */
  dispose(): void {
    // Handlers first, so a teardown does not run steps against a resolver that
    // is going away. Pending dials are still rejected, by closePeer.
    this.handlers.clear();
    this.listening = false;
    closeAll(this);
  }
}

// The helpers below take the node rather than living on it: every method
// on a Node registers as a dispatch key, so only the ops and `dispose` can be
// methods.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the `iceServers` sibling. Anything that is not a list of `{ urls }`
 * entries throws rather than falling back to the default: a mistyped TURN entry
 * that quietly reverted to STUN would fail only for the users behind a symmetric
 * NAT, which is the hardest kind of failure to notice.
 */
function iceServersFrom(value: unknown): readonly RTCIceServer[] {
  if (value === null || value === undefined) return DEFAULT_ICE_SERVERS;
  if (!Array.isArray(value)) {
    throw new Error("rtc iceServers must be an array of { urls, username, credential } entries");
  }
  return value.map(entry => {
    const urls = isPlainObject(entry) ? entry.urls : undefined;
    if (typeof urls !== "string" && !Array.isArray(urls)) {
      throw new Error("rtc iceServers entries need a `urls` string, or an array of them");
    }
    const server: RTCIceServer = { urls: typeof urls === "string" ? urls : urls.map(String) };
    if (typeof entry.username === "string") server.username = entry.username;
    if (typeof entry.credential === "string") server.credential = entry.credential;
    return server;
  });
}

function doListen(
  node: WebRTCNode,
  def: Record<string, unknown>,
  context: Context,
  config: { iceServers: readonly RTCIceServer[]; timeout: number; trickle: boolean },
): null {
  node.handlers.clear();
  for (const key of HANDLER_KEYS) {
    const body = def[key];
    // A lone expression is a one-step sequence, the same normalization the
    // `steps` schema def accepts, so a handler that does one thing needs no array.
    if (body !== undefined) node.handlers.set(key, { body, context, def });
  }
  if (!node.handlers.has("on-signal")) {
    throw new Error('rtc "listen" needs "on-signal": it is the only way a payload reaches the other peer');
  }
  node.iceServers = config.iceServers;
  node.timeout = config.timeout;
  node.trickle = config.trickle;
  node.listening = true;
  return null;
}

function requireListening(node: WebRTCNode, op: string): void {
  if (!node.listening) {
    throw new Error(`${op} needs a prior rtc "listen": that is what supplies on-signal, so there is nowhere to send anything`);
  }
}

/** Run a registered handler, handing back its result for the callers that read
 *  one. Null when nothing is registered, which is not the same as a falsy result. */
function runHandler(node: WebRTCNode, key: HandlerKey, extra: Record<string, unknown>): Promise<unknown> | null {
  const handler = node.handlers.get(key);
  if (!handler) return null;
  const steps = Array.isArray(handler.body) ? handler.body : [handler.body];
  // Detached: these fire long after the `listen` step returned, so its own
  // `catch` is the last handler left and anything past it reaches the console.
  return runStepsDetached(steps, childContext(handler.context, extra), handler.def);
}

function fireHandler(node: WebRTCNode, key: HandlerKey, extra: Record<string, unknown>): void {
  const running = runHandler(node, key, extra);
  if (running) running.catch((e: unknown) => console.error(`[WebRTC] ${key} error:`, e));
}

/** Hand one payload to the template to deliver. `$rtcPeerId` addresses it, so an
 *  envelope can be routed without the payload being opened. */
function emitSignal(node: WebRTCNode, peerId: string, payload: unknown): void {
  fireHandler(node, "on-signal", { rtcSignal: payload, rtcPeerId: peerId });
}

function createPeer(node: WebRTCNode, peerId: string): RTCPeerConnection {
  if (node.peers.has(peerId)) closePeer(node, peerId);

  const pc = new RTCPeerConnection({ iceServers: [...node.iceServers] });

  pc.onicecandidate = (event) => {
    // Under `trickle: false` nothing goes out per candidate: the description
    // emitted once gathering finishes already carries them all.
    if (!node.trickle || !event.candidate) return;
    emitSignal(node, peerId, event.candidate.toJSON());
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") closePeer(node, peerId);
  };

  node.peers.set(peerId, pc);
  return pc;
}

/** Resolve once ICE gathering finishes, so the local description carries every
 *  candidate inline. Only reached under `trickle: false`. */
function waitForGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise<void>(done => {
    const check = (): void => {
      if (pc.iceGatheringState !== "complete") return;
      pc.removeEventListener("icegatheringstatechange", check);
      done();
    };
    pc.addEventListener("icegatheringstatechange", check);
  });
}

/**
 * Apply a local description and produce the payload to signal. The browser's own
 * `{ type, sdp }` goes out verbatim, so any non-Jexs peer or off-the-shelf
 * signalling server understands it without unwrapping.
 */
async function describeLocal(
  node: WebRTCNode,
  pc: RTCPeerConnection,
  desc: RTCSessionDescriptionInit,
): Promise<RTCSessionDescriptionInit> {
  await pc.setLocalDescription(desc);
  if (node.trickle) return { type: desc.type, sdp: desc.sdp };
  await waitForGathering(pc);
  const local = pc.localDescription;
  return local ? { type: local.type, sdp: local.sdp } : { type: desc.type, sdp: desc.sdp };
}

async function doConnect(node: WebRTCNode, peerId: string, timeout: number): Promise<string> {
  requireListening(node, "rtc-connect");
  const pc = createPeer(node, peerId);

  const channel = pc.createDataChannel("data");
  setupChannel(node, channel, peerId, "data");
  node.channels.set(peerId, channel);

  const fast = pc.createDataChannel("fast", { ordered: false, maxRetransmits: 0 });
  setupChannel(node, fast, peerId, "fast");
  node.fastChannels.set(peerId, fast);

  try {
    const offer = await pc.createOffer();
    emitSignal(node, peerId, await describeLocal(node, pc, offer));
  } catch (err) {
    // Nothing is waiting yet, so this tears down without rejecting a promise
    // the caller has not been handed.
    closePeer(node, peerId);
    throw err;
  }

  return waitForOpen(node, peerId, timeout);
}

function waitForOpen(node: WebRTCNode, peerId: string, timeout: number): Promise<string> {
  if (node.opened.has(peerId)) return Promise.resolve(peerId);
  return new Promise<string>((settle, fail) => {
    const timer = setTimeout(() => {
      // Dropped before closePeer, so the teardown does not reject this twice.
      node.pendingOpens.delete(peerId);
      closePeer(node, peerId);
      fail(new Error(`rtc-connect to "${peerId}" timed out after ${timeout}ms: no answer came back, or no network path was found`));
    }, timeout);
    node.pendingOpens.set(peerId, { settle, fail, timer });
  });
}

/**
 * A channel reported open. The peer counts as usable only once BOTH are, so a
 * `send` on either is safe the moment `connect` returns.
 */
function channelOpened(node: WebRTCNode, peerId: string): void {
  const data = node.channels.get(peerId);
  const fast = node.fastChannels.get(peerId);
  if (!data || data.readyState !== "open") return;
  if (!fast || fast.readyState !== "open") return;
  if (node.opened.has(peerId)) return;
  node.opened.add(peerId);

  const pending = node.pendingOpens.get(peerId);
  if (pending) {
    clearTimeout(pending.timer);
    node.pendingOpens.delete(peerId);
    pending.settle(peerId);
  }
  fireHandler(node, "on-open", { rtcPeerId: peerId, rtcInbound: node.inbound.has(peerId) });
}

/** One of the two native signalling shapes. A description carries `type`; a
 *  candidate carries `candidate` and no `type`, which is exactly how the
 *  browser's own objects serialize. */
type SignalPayload =
  | { kind: "offer" | "answer"; description: RTCSessionDescriptionInit }
  | { kind: "ice"; candidate: RTCIceCandidateInit };

function signalPayload(data: unknown): SignalPayload {
  if (!isPlainObject(data)) {
    throw new Error(
      `rtc-signal data must be a session description or an ICE candidate, got ${data === null ? "null" : typeof data}`,
    );
  }
  if (data.type === "offer" || data.type === "answer") {
    if (typeof data.sdp !== "string") {
      throw new Error(`rtc-signal ${data.type} carries no sdp`);
    }
    return { kind: data.type, description: { type: data.type, sdp: data.sdp } };
  }
  if (typeof data.candidate === "string") {
    return { kind: "ice", candidate: data as RTCIceCandidateInit };
  }
  throw new Error(
    'rtc-signal data must be a session description ({ type: "offer" | "answer", sdp }) or an ICE candidate ({ candidate, sdpMid, sdpMLineIndex })',
  );
}

/**
 * Feed in one received payload. `from` comes from the sibling and never from
 * inside `data`: the node cannot see who sent anything, so whatever the
 * transport can vouch for is the only identity there is, and reading one out of
 * the payload would let a sender name itself.
 */
async function doSignal(node: WebRTCNode, data: unknown, from: string): Promise<null> {
  const payload = signalPayload(data);
  requireListening(node, "rtc-signal");

  if (payload.kind === "ice") {
    const pc = node.peers.get(from);
    // A candidate can beat the description it belongs to, and it can beat the
    // peer itself: both are ordinary trickle ordering rather than a fault, so
    // queue until a remote description arrives and flushes.
    if (!pc || !pc.remoteDescription) {
      const queued = node.pendingIce.get(from);
      if (queued) queued.push(payload.candidate);
      else node.pendingIce.set(from, [payload.candidate]);
      return null;
    }
    await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
    return null;
  }

  if (payload.kind === "offer") {
    await acceptOffer(node, from, payload.description);
    return null;
  }

  const pc = node.peers.get(from);
  if (!pc) {
    throw new Error(`rtc-signal has no pending connection to "${from}": it was never dialed, or it has since closed`);
  }
  await pc.setRemoteDescription(payload.description);
  flushIceCandidates(node, from);
  return null;
}

async function acceptOffer(node: WebRTCNode, from: string, description: RTCSessionDescriptionInit): Promise<void> {
  // The gate runs before anything is answered: once an answer is out, refusing
  // would cost a connection the other side already believes in.
  const verdict = runHandler(node, "on-peer", { rtcPeerId: from });
  if (verdict && !Node.toBooleanValue(await verdict)) return;

  const pc = createPeer(node, from);
  node.inbound.add(from);

  // The dialer created both channels, so this side adopts them as they arrive.
  pc.ondatachannel = (event) => {
    const label = event.channel.label;
    setupChannel(node, event.channel, from, label);
    if (label === "fast") node.fastChannels.set(from, event.channel);
    else node.channels.set(from, event.channel);
    // An adopted channel can already be open, in which case no onopen follows.
    channelOpened(node, from);
  };

  await pc.setRemoteDescription(description);
  flushIceCandidates(node, from);
  const answer = await pc.createAnswer();
  emitSignal(node, from, await describeLocal(node, pc, answer));
}

function flushIceCandidates(node: WebRTCNode, peerId: string): void {
  const queued = node.pendingIce.get(peerId);
  const pc = node.peers.get(peerId);
  if (!queued || !pc) return;
  node.pendingIce.delete(peerId);
  for (const candidate of queued) {
    pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => { /* a stale candidate is not a fault */ });
  }
}

function doSend(node: WebRTCNode, peerId: string, data: unknown, kind: ChannelKind): null {
  const isFast = kind === "fast";
  const channel = (isFast ? node.fastChannels : node.channels).get(peerId);
  if (!channel) {
    throw new Error(`rtc-send has no ${kind} channel to "${peerId}": run rtc-connect first`);
  }
  if (channel.readyState !== "open") {
    throw new Error(`rtc-send cannot use the ${kind} channel to "${peerId}": it is ${channel.readyState}`);
  }
  // The one drop that stays silent, because it is the point of an unreliable
  // channel: a backed-up fast lane sheds the update rather than queueing a
  // position the receiver would render late anyway.
  if (isFast && channel.bufferedAmount > FAST_BUFFERED_AMOUNT_LIMIT) return null;
  channel.send(typeof data === "string" ? data : JSON.stringify(data));
  return null;
}

function doBroadcast(node: WebRTCNode, data: unknown, kind: ChannelKind): null {
  const isFast = kind === "fast";
  const map = isFast ? node.fastChannels : node.channels;
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  // Unlike `send`, a peer that is not ready is skipped rather than refused: a
  // broadcast addresses whoever is currently there.
  for (const [, channel] of map) {
    if (channel.readyState !== "open") continue;
    if (isFast && channel.bufferedAmount > FAST_BUFFERED_AMOUNT_LIMIT) continue;
    channel.send(payload);
  }
  return null;
}

function statusOf(node: WebRTCNode, peerId: string): string {
  const pc = node.peers.get(peerId);
  if (!pc) return "none";
  if (node.opened.has(peerId)) return "open";
  if (pc.connectionState === "failed" || pc.connectionState === "closed") return "closed";
  return "connecting";
}

function setupChannel(node: WebRTCNode, channel: RTCDataChannel, peerId: string, label: string): void {
  channel.onopen = () => channelOpened(node, peerId);

  channel.onmessage = (event) => {
    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      data = event.data;
    }

    if (label === "fast") {
      const coalesceKey = getFastCoalesceKey(peerId, data);
      if (coalesceKey) {
        node.pendingFastCoalescedByKey.set(coalesceKey, { peerId, data });
        scheduleFastCoalesceFlush(node);
        return;
      }
      dispatchRtcMessage(node, peerId, data, "fast");
      return;
    }

    dispatchRtcMessage(node, peerId, data, "data");
  };

  channel.onclose = () => {
    // The map this channel actually lives in. Closing the fast channel used to
    // evict the reliable one and leave the fast one registered, so `send` went
    // on addressing a dead channel and refused a live one.
    const map = label === "fast" ? node.fastChannels : node.channels;
    if (map.get(peerId) === channel) map.delete(peerId);

    // Only the fast channel fills the coalesce buffer, so only its close clears it.
    if (label !== "fast") return;
    for (const [key, entry] of node.pendingFastCoalescedByKey) {
      if (entry.peerId === peerId) node.pendingFastCoalescedByKey.delete(key);
    }
  };
}

function getFastCoalesceKey(peerId: string, data: unknown): string | null {
  if (!isPlainObject(data)) return null;
  if (data.__coalesce !== true) return null;

  const customKey = typeof data.__coalesceKey === "string" ? data.__coalesceKey.trim() : "";
  if (customKey) return `${peerId}:${customKey}`;

  const type = typeof data.type === "string" ? data.type : "message";
  return `${peerId}:${type}`;
}

function scheduleFastCoalesceFlush(node: WebRTCNode): void {
  if (node.fastCoalesceFlushScheduled) return;
  node.fastCoalesceFlushScheduled = true;
  setTimeout(() => {
    node.fastCoalesceFlushScheduled = false;
    if (node.pendingFastCoalescedByKey.size === 0) return;
    if (node.fastCoalesceProcessing) {
      scheduleFastCoalesceFlush(node);
      return;
    }

    const batch = Array.from(node.pendingFastCoalescedByKey.values());
    node.pendingFastCoalescedByKey.clear();

    node.fastCoalesceProcessing = true;
    for (const entry of batch) dispatchRtcMessage(node, entry.peerId, entry.data, "fast");
    node.fastCoalesceProcessing = false;
    if (node.pendingFastCoalescedByKey.size > 0) scheduleFastCoalesceFlush(node);
  }, FAST_COALESCE_FLUSH_MS);
}

function dispatchRtcMessage(node: WebRTCNode, peerId: string, data: unknown, channel: ChannelKind): void {
  fireHandler(node, "on-message", { rtcMessage: data, rtcPeerId: peerId, rtcChannel: channel });
}

function closePeer(node: WebRTCNode, peerId: string): void {
  const pending = node.pendingOpens.get(peerId);
  if (pending) {
    clearTimeout(pending.timer);
    node.pendingOpens.delete(peerId);
    pending.fail(new Error(`rtc-connect to "${peerId}" was closed before it opened`));
  }

  const channel = node.channels.get(peerId);
  if (channel) { node.channels.delete(peerId); channel.close(); }
  const fast = node.fastChannels.get(peerId);
  if (fast) { node.fastChannels.delete(peerId); fast.close(); }

  const pc = node.peers.get(peerId);
  if (pc) {
    // Dropped from the map and unwired before `close()`, because closing fires
    // the state change that lands back here.
    node.peers.delete(peerId);
    pc.onconnectionstatechange = null;
    pc.onicecandidate = null;
    pc.ondatachannel = null;
    pc.close();
  }

  node.pendingIce.delete(peerId);
  node.inbound.delete(peerId);
  for (const [key, entry] of node.pendingFastCoalescedByKey) {
    if (entry.peerId === peerId) node.pendingFastCoalescedByKey.delete(key);
  }

  // Only a peer that actually opened is announced, so a refused offer or a dial
  // that timed out is reported once, by the step that asked for it.
  if (node.opened.delete(peerId)) fireHandler(node, "on-close", { rtcPeerId: peerId });
}

function closeAll(node: WebRTCNode): null {
  for (const peerId of [...node.peers.keys()]) closePeer(node, peerId);
  return null;
}
