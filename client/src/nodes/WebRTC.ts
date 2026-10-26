import { Node, Context, NodeValue, childContext, runStepsDetached } from "@jexs/core";
import { resolve, resolveAll, isObject } from "@jexs/core";
import type { JexsNodeSchema, JexsPropertySchema } from "@jexs/core";

const FAST_BUFFERED_AMOUNT_LIMIT = 128 * 1024;
const FAST_COALESCE_FLUSH_MS = 16;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_ICE_SERVERS: readonly RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const DEFAULT_MESH = "default";

/** A handler registered by `listen`, kept with the step that registered it so a
 *  `$catch` on that step still applies when it fires long after it returned. */
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

/**
 * One peer in a mesh: its connection, the channels the browser hands out once
 * and never lists again, and what the node knows of it that the browser does
 * not keep. One record, so a peer is looked up once and closed in one place.
 */
interface Peer {
  id: string;
  pc: RTCPeerConnection;
  data?: RTCDataChannel;
  fast?: RTCDataChannel;
  /** A dial waiting for both channels to open. */
  pending?: PendingOpen;
  /** Whether both channels have opened, so `onClose` fires only for a peer that did. */
  opened: boolean;
  /** Whether the peer dialed us, for `inbound`. */
  inbound: boolean;
}

/**
 * One mesh: the handlers and ICE settings its `listen` gave, and the peers in
 * it. Each is separate, so a page can run a game mesh and a voice mesh with
 * their own handlers and TURN servers, and a peer id names a peer per mesh.
 */
interface Mesh {
  name: string;
  /** Registered by `listen`, replaced wholesale by the next one. */
  handlers: Map<HandlerKey, Handler>;
  iceServers: readonly RTCIceServer[];
  timeout: number;
  trickle: boolean;
  peers: Map<string, Peer>;
  /** Candidates that arrived before the peer or its remote description did,
   *  by peer id: one can come before the peer exists at all. */
  pendingIce: Map<string, RTCIceCandidateInit[]>;
  pendingFastCoalescedByKey: Map<string, { peerId: string; data: unknown }>;
  fastCoalesceFlushScheduled: boolean;
  fastCoalesceProcessing: boolean;
}

// Shared sibling defs, declared before the class so the static schema
// initializer can read them (a `const` is not hoisted).

/** The operations that take no primary value, so they fold into the bare `rtc`
 *  key rather than each claiming one, the way StorageNode and CacheNode split
 *  theirs. Everything peer-scoped names its peer, so it gets its own key.
 *
 *  Shared by the schema `enum` and the runtime check, so neither can drift. */
const RTC_OPS = ["listen", "closeAll"] as const;

const RTC_CHANNELS = ["data", "fast"] as const;
type ChannelKind = typeof RTC_CHANNELS[number];

const HANDLER_KEYS = ["onSignal", "onPeer", "onOpen", "onMessage", "onClose"] as const;
type HandlerKey = typeof HANDLER_KEYS[number];

const RTC_CHANNEL = {
  type: "string" as const,
  enum: RTC_CHANNELS,
  description: "Data channel: `\"data\"` (reliable) or `\"fast\"` (unreliable, low-latency).",
};

export class WebRTCNode extends Node {
  static commonSiblings: Record<string, JexsPropertySchema> = {
    mesh: {
      type: "string",
      description: "The mesh: its own peers, handlers and ICE settings, set up by its `listen` (default `\"default\"`). A peer id names a peer within one mesh.",
    },
  };

  static schema: JexsNodeSchema = {
    rtc: {
      type: "string",
      enum: RTC_OPS,
      markdownDescription: "The two WebRTC operations that name no peer. Everything peer-scoped has its own key: `rtcConnect`, `rtcSignal`, `rtcSend`, `rtcBroadcast`, `rtcClose`, `rtcStatus`.\nThe node never touches a socket: it hands each signalling payload to your `onSignal` steps to deliver however you like (a WebSocket, `fetch`, `windowRun`, even a copy-paste box), and you hand replies back with `rtcSignal`.\nEvery op works in one `mesh`, `\"default\"` unless it names another, so a page can keep separate meshes, each with its own handlers and ICE servers.",
      examples: [
        "{ \"$rtc\": \"listen\", \"onSignal\": { \"$wsSend\": { \"$var\": \"signal\" } } }",
        "{ \"$rtc\": \"closeAll\" }",
      ],
      variants: {
        listen: {
          output: "null",
          markdownDescription: "Sets up the mesh: registers its signalling sink and peer handlers, and configures its ICE. Run by **both** sides: the answering peer never calls `rtcConnect`, so this is its only chance to supply them.\nCreates no peer by itself. A second `listen` on the same mesh replaces its handlers and settings; its peers stay.",
          examples: [
            "{ \"$rtc\": \"listen\", \"onSignal\": { \"$wsSend\": { \"type\": \"peer-signal\", \"to\": { \"$var\": \"peer\" }, \"sig\": { \"$var\": \"signal\" } } } }",
            "{ \"$rtc\": \"listen\", \"mesh\": \"voice\", \"iceServers\": [{ \"urls\": \"turn:turn.example.com:3478\", \"username\": \"u\", \"credential\": \"c\" }], \"onSignal\": { \"$wsSend\": { \"mesh\": \"voice\", \"to\": { \"$var\": \"peer\" }, \"sig\": { \"$var\": \"signal\" } } } }",
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
            onSignal: {
              steps: true,
              required: true,
              markdownDescription: "Steps that deliver one signalling payload, with `signal` (the payload, opaque) and `peer` (who it is for) in scope. Required: without it an offer has nowhere to go.",
            },
            onPeer: {
              steps: true,
              markdownDescription: "Steps run when a peer offers us a connection, **before** anything is answered, with `peer` in scope. Resolve to a falsy value to refuse: nothing is signalled back and the peer is dropped. This is the only point at which refusing is still possible.",
            },
            onOpen: {
              steps: true,
              markdownDescription: "Steps run when a peer's channels are open and `send` is safe, with `peer` and `inbound` (whether the peer dialed us) in scope. Fires for peers arriving from either direction, which makes it the answering side's only way to learn this.",
            },
            onMessage: {
              steps: true,
              markdownDescription: "Steps run on each incoming message, with `message`, `peer` and `channel` (`\"data\"` or `\"fast\"`) in scope.",
            },
            onClose: {
              steps: true,
              markdownDescription: "Steps run when a peer that had opened goes away, with `peer` in scope. A refused offer or a dial that timed out never opened, and is reported by that step instead.",
            },
          },
        },
        closeAll: {
          output: "null",
          markdownDescription: "Closes every peer connection in the mesh.",
        },
      },
    },

    rtcConnect: {
      type: "string",
      output: "string",
      outputDescription: "The peer id, once **both** channels are open, so a `send` on either is safe immediately. Most templates put their \"peer is usable\" logic in `onOpen` instead, since that covers peers arriving from either direction; what `rtcConnect` adds is carrying a failed dial to `$catch`.",
      markdownDescription: "Dials the given peer: creates the connection and both data channels, emits an offer through the mesh's `onSignal`, and waits for the channels to open. Rejects on `timeout`, on a failed connection, and if the peer closes while waiting.\nUse `$then` for the non-blocking version.",
      examples: [
        "{ \"$rtcConnect\": { \"$var\": \"peerId\" } }",
      ],
      siblings: {
        timeout: {
          type: "number",
          description: "Milliseconds to wait for the channels to open before giving up. Defaults to the mesh's `listen` value.",
        },
      },
    },

    rtcSignal: {
      type: "string",
      output: "null",
      markdownDescription: "Feeds one received signalling payload back in. **The value is the peer it came FROM**, not one to send to: this is the counterpart to `onSignal`, and the only way anything reaches the node from another peer.\nThat peer is read only from here and never from inside `data`, so a relay that stamps it from the connection stays the authority on identity. `data` is the payload verbatim: a session description (`{ type, sdp }`) or an ICE candidate (`{ candidate, sdpMid, sdpMLineIndex }`).",
      examples: [
        "{ \"$rtcSignal\": { \"$var\": \"message.from\" }, \"data\": { \"$var\": \"message.sig\" } }",
      ],
      siblings: {
        data: { required: true, description: "The signalling payload, exactly as it was emitted." },
      },
    },

    rtcSend: {
      type: "string",
      output: "null",
      markdownDescription: "Sends `data` to the given peer over the chosen channel. Throws when there is no such channel or it is not open.",
      examples: [
        "{ \"$rtcSend\": { \"$var\": \"peer\" }, \"data\": { \"$var\": \"state\" }, \"channel\": \"fast\" }",
      ],
      siblings: {
        data: { required: true, description: "Data to send. Non-string values are JSON-encoded." },
        channel: RTC_CHANNEL,
      },
    },

    rtcBroadcast: {
      output: "null",
      markdownDescription: "Sends the value to every connected peer in the mesh. The one operation with no peer to name, so the data takes the value slot.\nUnlike `rtcSend`, a peer that is not ready is skipped rather than refused: a broadcast addresses whoever is currently there.",
      examples: [
        "{ \"$rtcBroadcast\": { \"$var\": \"state\" }, \"channel\": \"fast\" }",
      ],
      siblings: { channel: RTC_CHANNEL },
    },

    rtcClose: {
      type: "string",
      output: "null",
      markdownDescription: "Closes one peer connection. Use `{ \"$rtc\": \"closeAll\" }` for every peer in the mesh at once.",
    },

    rtcStatus: {
      type: "string",
      output: "string",
      outputDescription: "`\"open\"`, `\"connecting\"`, `\"closed\"`, or `\"none\"` when there is no such peer.",
      markdownDescription: "Reports the state of one peer, for showing whether it is reachable.",
      examples: [
        "{ \"$rtcStatus\": { \"$var\": \"peer\" } }",
      ],
    },
  };

  // Everything below belongs to this node, so it belongs to one resolver: two
  // apps on a page get their own meshes rather than sharing a process-wide
  // table, and `resolver.destroy()` has something it can reach. There is no
  // socket here and no identity, because signalling is a seam the template
  // fills: the node never learns how a payload travelled or who it decided the
  // sender was.

  /** The meshes their `listen` set up, by name. */
  readonly meshes = new Map<string, Mesh>();

  // Values are resolved and coerced in these methods rather than in the helpers
  // below, because the coercion helpers are members and every member of a Node
  // is a dispatch key: only the ops and `dispose` can be methods.

  rtc(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$rtc, def.mesh ?? null], context, ([raw, meshRaw]) => {
      const name = meshRaw == null ? DEFAULT_MESH : this.toString(meshRaw);
      switch (this.getOption(raw, RTC_OPS, "rtc operation")) {
        case "listen":
          return resolveAll([def.iceServers, def.timeout, def.trickle], context, ([ice, ms, trickle]) =>
            doListen(this, name, def, context, {
              iceServers: iceServersFrom(ice),
              timeout: ms == null ? DEFAULT_TIMEOUT_MS : this.toNumber(ms),
              trickle: trickle == null ? true : this.toBoolean(trickle),
            }));

        case "closeAll": {
          const mesh = this.meshes.get(name);
          if (mesh) closeAll(mesh);
          return null;
        }

        default:
          // `getOption` has already refused anything unlisted, so this is the
          // absent case: `{ "$rtc": null }` names no operation at all.
          throw new Error(`rtc needs an operation: expected ${RTC_OPS.join(", ")}`);
      }
    });
  }

  rtcConnect(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$rtcConnect, def.timeout, def.mesh ?? null], context, ([id, ms, meshRaw]) => {
      const mesh = requireMesh(this, meshRaw, "rtcConnect");
      return doConnect(mesh, this.toString(id), ms == null ? mesh.timeout : this.toNumber(ms));
    });
  }

  rtcSignal(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$rtcSignal, def.data, def.mesh ?? null], context, ([from, data, meshRaw]) => {
      // The peer is the primary value, not a field of the payload, and that
      // placement is the security rule made visible: the node cannot see who
      // sent anything, so whatever the transport vouched for is the only
      // identity there is.
      if (from == null || this.toString(from) === "") {
        throw new Error("rtcSignal needs the peer the payload came from as its value");
      }
      const payload = signalPayload(data);
      return doSignal(requireMesh(this, meshRaw, "rtcSignal"), payload, this.toString(from));
    });
  }

  // `channel` is checked with getOption rather than compared: an unlisted name
  // used to fall through to the reliable channel, which is not what the step said.
  rtcSend(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$rtcSend, def.data, def.channel, def.mesh ?? null], context, ([id, data, ch, meshRaw]) => {
      const kind = this.getOption(ch, RTC_CHANNELS, "rtc channel") ?? "data";
      return doSend(this.meshes.get(meshName(meshRaw)), this.toString(id), data, kind);
    });
  }

  rtcBroadcast(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$rtcBroadcast, def.channel, def.mesh ?? null], context, ([data, ch, meshRaw]) => {
      const kind = this.getOption(ch, RTC_CHANNELS, "rtc channel") ?? "data";
      const mesh = this.meshes.get(meshName(meshRaw));
      return mesh ? doBroadcast(mesh, data, kind) : null;
    });
  }

  rtcClose(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$rtcClose, def.mesh ?? null], context, ([id, meshRaw]) => {
      const mesh = this.meshes.get(meshName(meshRaw));
      if (mesh) closePeer(mesh, this.toString(id));
      return null;
    });
  }

  rtcStatus(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$rtcStatus, def.mesh ?? null], context, ([id, meshRaw]) => {
      const mesh = this.meshes.get(meshName(meshRaw));
      return mesh ? statusOf(mesh, this.toString(id)) : "none";
    });
  }

  /** Closes every peer connection in every mesh. Called by `resolver.destroy()`. */
  dispose(): void {
    for (const mesh of this.meshes.values()) {
      // Handlers first, so a teardown does not run steps against a resolver that
      // is going away. Pending dials are still rejected, by closePeer.
      mesh.handlers.clear();
      closeAll(mesh);
    }
    this.meshes.clear();
  }
}

// The helpers below take the node or a mesh rather than living on the node:
// every method on a Node registers as a dispatch key, so only the ops and
// `dispose` can be methods.

/** A resolved `mesh` sibling's name: absent means the default mesh. */
function meshName(raw: unknown): string {
  return raw == null ? DEFAULT_MESH : String(raw);
}

/** The mesh an op that signals works in, which its `listen` must have set up. */
function requireMesh(node: WebRTCNode, raw: unknown, op: string): Mesh {
  const name = meshName(raw);
  const mesh = node.meshes.get(name);
  if (!mesh) {
    throw new Error(`${op} needs a prior rtc "listen" on mesh "${name}": that is what supplies onSignal, so there is nowhere to send anything`);
  }
  return mesh;
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
    const urls = isObject(entry) ? entry.urls : undefined;
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
  name: string,
  def: Record<string, unknown>,
  context: Context,
  config: { iceServers: readonly RTCIceServer[]; timeout: number; trickle: boolean },
): null {
  const handlers = new Map<HandlerKey, Handler>();
  for (const key of HANDLER_KEYS) {
    const body = def[key];
    // A lone expression is a one-step sequence, the same normalization the
    // `steps` schema def accepts, so a handler that does one thing needs no array.
    if (body !== undefined) handlers.set(key, { body, context, def });
  }
  if (!handlers.has("onSignal")) {
    throw new Error('rtc "listen" needs "onSignal": it is the only way a payload reaches the other peer');
  }
  // A second `listen` on a mesh replaces its handlers and settings; its peers stay.
  const mesh = node.meshes.get(name) ?? newMesh(name);
  mesh.handlers = handlers;
  mesh.iceServers = config.iceServers;
  mesh.timeout = config.timeout;
  mesh.trickle = config.trickle;
  node.meshes.set(name, mesh);
  return null;
}

function newMesh(name: string): Mesh {
  return {
    name,
    handlers: new Map(),
    iceServers: DEFAULT_ICE_SERVERS,
    timeout: DEFAULT_TIMEOUT_MS,
    trickle: true,
    peers: new Map(),
    pendingIce: new Map(),
    pendingFastCoalescedByKey: new Map(),
    fastCoalesceFlushScheduled: false,
    fastCoalesceProcessing: false,
  };
}

/** Run a registered handler, handing back its result for the callers that read
 *  one. Null when nothing is registered, which is not the same as a falsy result. */
function runHandler(mesh: Mesh, key: HandlerKey, extra: Record<string, unknown>): Promise<unknown> | null {
  const handler = mesh.handlers.get(key);
  if (!handler) return null;
  // Detached: these fire long after the `listen` step returned, so its own
  // `$catch` is the last handler left and anything past it reaches the console.
  return runStepsDetached(handler.body, childContext(handler.context, extra), { step: handler.def });
}

function fireHandler(mesh: Mesh, key: HandlerKey, extra: Record<string, unknown>): void {
  const running = runHandler(mesh, key, extra);
  if (running) running.catch((e: unknown) => console.error(`[WebRTC] ${key} error:`, e));
}

/** Hand one payload to the template to deliver. `peer` addresses it, so an
 *  envelope can be routed without the payload being opened. */
function emitSignal(mesh: Mesh, peerId: string, payload: unknown): void {
  fireHandler(mesh, "onSignal", { signal: payload, peer: peerId });
}

function createPeer(mesh: Mesh, peerId: string, inbound: boolean): Peer {
  if (mesh.peers.has(peerId)) closePeer(mesh, peerId);

  const pc = new RTCPeerConnection({ iceServers: [...mesh.iceServers] });

  pc.onicecandidate = (event) => {
    // Under `trickle: false` nothing goes out per candidate: the description
    // emitted once gathering finishes already carries them all.
    if (!mesh.trickle || !event.candidate) return;
    emitSignal(mesh, peerId, event.candidate.toJSON());
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") closePeer(mesh, peerId);
  };

  const peer: Peer = { id: peerId, pc, opened: false, inbound };
  mesh.peers.set(peerId, peer);
  return peer;
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
  mesh: Mesh,
  pc: RTCPeerConnection,
  desc: RTCSessionDescriptionInit,
): Promise<RTCSessionDescriptionInit> {
  await pc.setLocalDescription(desc);
  if (mesh.trickle) return { type: desc.type, sdp: desc.sdp };
  await waitForGathering(pc);
  const local = pc.localDescription;
  return local ? { type: local.type, sdp: local.sdp } : { type: desc.type, sdp: desc.sdp };
}

async function doConnect(mesh: Mesh, peerId: string, timeout: number): Promise<string> {
  const peer = createPeer(mesh, peerId, false);

  peer.data = peer.pc.createDataChannel("data");
  setupChannel(mesh, peer, peer.data, "data");

  peer.fast = peer.pc.createDataChannel("fast", { ordered: false, maxRetransmits: 0 });
  setupChannel(mesh, peer, peer.fast, "fast");

  try {
    const offer = await peer.pc.createOffer();
    emitSignal(mesh, peerId, await describeLocal(mesh, peer.pc, offer));
  } catch (err) {
    // Nothing is waiting yet, so this tears down without rejecting a promise
    // the caller has not been handed.
    closePeer(mesh, peerId);
    throw err;
  }

  return waitForOpen(mesh, peer, timeout);
}

function waitForOpen(mesh: Mesh, peer: Peer, timeout: number): Promise<string> {
  if (peer.opened) return Promise.resolve(peer.id);
  return new Promise<string>((settle, fail) => {
    const timer = setTimeout(() => {
      // Dropped before closePeer, so the teardown does not reject this twice.
      peer.pending = undefined;
      closePeer(mesh, peer.id);
      fail(new Error(`rtcConnect to "${peer.id}" timed out after ${timeout}ms: no answer came back, or no network path was found`));
    }, timeout);
    peer.pending = { settle, fail, timer };
  });
}

/**
 * A channel reported open. The peer counts as usable only once BOTH are, so a
 * `send` on either is safe the moment `connect` returns.
 */
function channelOpened(mesh: Mesh, peer: Peer): void {
  if (peer.data?.readyState !== "open" || peer.fast?.readyState !== "open") return;
  if (peer.opened) return;
  peer.opened = true;

  const pending = peer.pending;
  if (pending) {
    clearTimeout(pending.timer);
    peer.pending = undefined;
    pending.settle(peer.id);
  }
  fireHandler(mesh, "onOpen", { peer: peer.id, inbound: peer.inbound });
}

/** One of the two native signalling shapes. A description carries `type`; a
 *  candidate carries `candidate` and no `type`, which is exactly how the
 *  browser's own objects serialize. */
type SignalPayload =
  | { kind: "offer" | "answer"; description: RTCSessionDescriptionInit }
  | { kind: "ice"; candidate: RTCIceCandidateInit };

function signalPayload(data: unknown): SignalPayload {
  if (!isObject(data)) {
    throw new Error(
      `rtcSignal data must be a session description or an ICE candidate, got ${data === null ? "null" : typeof data}`,
    );
  }
  if (data.type === "offer" || data.type === "answer") {
    if (typeof data.sdp !== "string") {
      throw new Error(`rtcSignal ${data.type} carries no sdp`);
    }
    return { kind: data.type, description: { type: data.type, sdp: data.sdp } };
  }
  if (typeof data.candidate === "string") {
    return { kind: "ice", candidate: data as RTCIceCandidateInit };
  }
  throw new Error(
    'rtcSignal data must be a session description ({ type: "offer" | "answer", sdp }) or an ICE candidate ({ candidate, sdpMid, sdpMLineIndex })',
  );
}

/**
 * Feed in one received payload. `from` comes from the sibling and never from
 * inside `data`: the node cannot see who sent anything, so whatever the
 * transport can vouch for is the only identity there is, and reading one out of
 * the payload would let a sender name itself.
 */
async function doSignal(mesh: Mesh, payload: SignalPayload, from: string): Promise<null> {
  if (payload.kind === "ice") {
    const peer = mesh.peers.get(from);
    // A candidate can beat the description it belongs to, and it can beat the
    // peer itself: both are ordinary trickle ordering rather than a fault, so
    // queue until a remote description arrives and flushes.
    if (!peer || !peer.pc.remoteDescription) {
      const queued = mesh.pendingIce.get(from);
      if (queued) queued.push(payload.candidate);
      else mesh.pendingIce.set(from, [payload.candidate]);
      return null;
    }
    await peer.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
    return null;
  }

  if (payload.kind === "offer") {
    await acceptOffer(mesh, from, payload.description);
    return null;
  }

  const peer = mesh.peers.get(from);
  if (!peer) {
    throw new Error(`rtcSignal has no pending connection to "${from}": it was never dialed, or it has since closed`);
  }
  await peer.pc.setRemoteDescription(payload.description);
  flushIceCandidates(mesh, peer);
  return null;
}

async function acceptOffer(mesh: Mesh, from: string, description: RTCSessionDescriptionInit): Promise<void> {
  // The gate runs before anything is answered: once an answer is out, refusing
  // would cost a connection the other side already believes in.
  const verdict = runHandler(mesh, "onPeer", { peer: from });
  if (verdict && !Node.toBooleanValue(await verdict)) return;

  const peer = createPeer(mesh, from, true);

  // The dialer created both channels, so this side adopts them as they arrive.
  peer.pc.ondatachannel = (event) => {
    const kind: ChannelKind = event.channel.label === "fast" ? "fast" : "data";
    peer[kind] = event.channel;
    setupChannel(mesh, peer, event.channel, kind);
    // An adopted channel can already be open, in which case no onopen follows.
    channelOpened(mesh, peer);
  };

  await peer.pc.setRemoteDescription(description);
  flushIceCandidates(mesh, peer);
  const answer = await peer.pc.createAnswer();
  emitSignal(mesh, from, await describeLocal(mesh, peer.pc, answer));
}

function flushIceCandidates(mesh: Mesh, peer: Peer): void {
  const queued = mesh.pendingIce.get(peer.id);
  if (!queued) return;
  mesh.pendingIce.delete(peer.id);
  for (const candidate of queued) {
    peer.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => { /* a stale candidate is not a fault */ });
  }
}

function doSend(mesh: Mesh | undefined, peerId: string, data: unknown, kind: ChannelKind): null {
  const isFast = kind === "fast";
  const channel = mesh?.peers.get(peerId)?.[kind];
  if (!channel) {
    throw new Error(`rtcSend has no ${kind} channel to "${peerId}": run rtcConnect first`);
  }
  if (channel.readyState !== "open") {
    throw new Error(`rtcSend cannot use the ${kind} channel to "${peerId}": it is ${channel.readyState}`);
  }
  // The one drop that stays silent, because it is the point of an unreliable
  // channel: a backed-up fast lane sheds the update rather than queueing a
  // position the receiver would render late anyway.
  if (isFast && channel.bufferedAmount > FAST_BUFFERED_AMOUNT_LIMIT) return null;
  channel.send(typeof data === "string" ? data : JSON.stringify(data));
  return null;
}

function doBroadcast(mesh: Mesh, data: unknown, kind: ChannelKind): null {
  const isFast = kind === "fast";
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  // Unlike `send`, a peer that is not ready is skipped rather than refused: a
  // broadcast addresses whoever is currently there.
  for (const peer of mesh.peers.values()) {
    const channel = peer[kind];
    if (!channel || channel.readyState !== "open") continue;
    if (isFast && channel.bufferedAmount > FAST_BUFFERED_AMOUNT_LIMIT) continue;
    channel.send(payload);
  }
  return null;
}

function statusOf(mesh: Mesh, peerId: string): string {
  const peer = mesh.peers.get(peerId);
  if (!peer) return "none";
  if (peer.opened) return "open";
  if (peer.pc.connectionState === "failed" || peer.pc.connectionState === "closed") return "closed";
  return "connecting";
}

function setupChannel(mesh: Mesh, peer: Peer, channel: RTCDataChannel, label: ChannelKind): void {
  const peerId = peer.id;
  channel.onopen = () => channelOpened(mesh, peer);

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
        mesh.pendingFastCoalescedByKey.set(coalesceKey, { peerId, data });
        scheduleFastCoalesceFlush(mesh);
        return;
      }
      dispatchRtcMessage(mesh, peerId, data, "fast");
      return;
    }

    dispatchRtcMessage(mesh, peerId, data, "data");
  };

  channel.onclose = () => {
    // Only the slot this channel holds: closing the fast channel must leave the
    // reliable one in place, and a replaced peer's old channel touches nothing.
    if (peer[label] === channel) peer[label] = undefined;

    // Only the fast channel fills the coalesce buffer, so only its close clears it.
    if (label !== "fast") return;
    for (const [key, entry] of mesh.pendingFastCoalescedByKey) {
      if (entry.peerId === peerId) mesh.pendingFastCoalescedByKey.delete(key);
    }
  };
}

function getFastCoalesceKey(peerId: string, data: unknown): string | null {
  if (!isObject(data)) return null;
  if (data.__coalesce !== true) return null;

  const customKey = typeof data.__coalesceKey === "string" ? data.__coalesceKey.trim() : "";
  if (customKey) return `${peerId}:${customKey}`;

  const type = typeof data.type === "string" ? data.type : "message";
  return `${peerId}:${type}`;
}

function scheduleFastCoalesceFlush(mesh: Mesh): void {
  if (mesh.fastCoalesceFlushScheduled) return;
  mesh.fastCoalesceFlushScheduled = true;
  setTimeout(() => {
    mesh.fastCoalesceFlushScheduled = false;
    if (mesh.pendingFastCoalescedByKey.size === 0) return;
    if (mesh.fastCoalesceProcessing) {
      scheduleFastCoalesceFlush(mesh);
      return;
    }

    const batch = Array.from(mesh.pendingFastCoalescedByKey.values());
    mesh.pendingFastCoalescedByKey.clear();

    mesh.fastCoalesceProcessing = true;
    for (const entry of batch) dispatchRtcMessage(mesh, entry.peerId, entry.data, "fast");
    mesh.fastCoalesceProcessing = false;
    if (mesh.pendingFastCoalescedByKey.size > 0) scheduleFastCoalesceFlush(mesh);
  }, FAST_COALESCE_FLUSH_MS);
}

function dispatchRtcMessage(mesh: Mesh, peerId: string, data: unknown, channel: ChannelKind): void {
  fireHandler(mesh, "onMessage", { message: data, peer: peerId, channel });
}

function closePeer(mesh: Mesh, peerId: string): void {
  mesh.pendingIce.delete(peerId);
  for (const [key, entry] of mesh.pendingFastCoalescedByKey) {
    if (entry.peerId === peerId) mesh.pendingFastCoalescedByKey.delete(key);
  }
  const peer = mesh.peers.get(peerId);
  if (!peer) return;
  // Dropped from the mesh and unwired before anything closes, because closing
  // fires the state change that lands back here.
  mesh.peers.delete(peerId);
  peer.pc.onconnectionstatechange = null;
  peer.pc.onicecandidate = null;
  peer.pc.ondatachannel = null;

  const pending = peer.pending;
  if (pending) {
    clearTimeout(pending.timer);
    peer.pending = undefined;
    pending.fail(new Error(`rtcConnect to "${peerId}" was closed before it opened`));
  }
  peer.data?.close();
  peer.fast?.close();
  peer.pc.close();

  // Only a peer that actually opened is announced, so a refused offer or a dial
  // that timed out is reported once, by the step that asked for it.
  if (peer.opened) fireHandler(mesh, "onClose", { peer: peerId });
}

function closeAll(mesh: Mesh): null {
  for (const peerId of [...mesh.peers.keys()]) closePeer(mesh, peerId);
  return null;
}
