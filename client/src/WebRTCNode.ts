import { Node, Context, NodeValue } from "@jexs/core";
import { resolve } from "@jexs/core";
import { WsNode } from "./WsNode.js";

// Module-level state
const peers: Map<string, RTCPeerConnection> = new Map();
const channels: Map<string, RTCDataChannel> = new Map();
const fastChannels: Map<string, RTCDataChannel> = new Map();
let ws: WebSocket | null = null;
let localId: string | null = null;
let onMessageSteps: unknown[] | null = null;
let onMessageContext: Context | null = null;

/**
 * WebRTCNode — Client-side WebRTC peer connection management.
 *
 * Operations:
 * - { "rtc": "connect", "id": "peer-id" }              — create peer connection and send offer via WS
 * - { "rtc": "answer", "offer": {...}, "from": "id" }   — accept offer, create answer, send back via WS
 * - { "rtc": "accept", "answer": {...}, "from": "id" }  — apply received answer to pending connection
 * - { "rtc": "ice", "candidate": {...}, "from": "id" }  — add ICE candidate from remote peer
 * - { "rtc": "send", "id": "peer-id", "data": {...}, "channel": "fast" }   — send data ("data"=reliable, "fast"=unreliable)
 * - { "rtc": "broadcast", "data": {...}, "channel": "fast" }              — broadcast to all peers
 * - { "rtc": "close", "id": "peer-id" }                 — close a peer connection
 * - { "rtc": "close-all" }                               — close all peer connections
 * - { "rtc": "on-message", "do": [...] }                 — register handler for incoming data channel messages
 */
export class WebRTCNode extends Node {
  async rtc(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const operation = await resolve(def.rtc, context);

    switch (operation) {
      case "connect":
        return doConnect(def, context);
      case "answer":
        return doAnswer(def, context);
      case "accept":
        return doAccept(def, context);
      case "ice":
        return doIce(def, context);
      case "send":
        return doSend(def, context);
      case "broadcast":
        return doBroadcast(def, context);
      case "close":
        return doClose(def, context);
      case "close-all":
        return closeAll();
      case "set-ws":
        return doSetWs(def, context);
      case "on-message":
        return doOnMessage(def, context);
      default:
        console.error(`[WebRTC] Unknown operation: ${operation}`);
        return null;
    }
  }

  static closeAll = closeAll;
  static setOnMessage(fn: (peerId: string, data: unknown) => void): void {
    onMessageFn = fn;
  }
}

// Callback set via static setOnMessage (programmatic)
let onMessageFn: ((peerId: string, data: unknown) => void) | null = null;

async function doSetWs(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
  ws = await resolve(def.ws, context) as WebSocket;
  localId = await resolve(def.id, context) as string;
  return null;
}

async function doOnMessage(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
  if (Array.isArray(def.do)) {
    onMessageSteps = def.do as unknown[];
    onMessageContext = { ...context };
  }
  return null;
}

async function doConnect(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
  const peerId = String(await resolve(def.id, context));
  const pc = createPeer(peerId);

  const channel = pc.createDataChannel("data");
  setupChannel(channel, peerId, "data");
  channels.set(peerId, channel);

  const fast = pc.createDataChannel("fast", { ordered: false, maxRetransmits: 0 });
  setupChannel(fast, peerId, "fast");
  fastChannels.set(peerId, fast);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  signal({
    type: "rtc:offer",
    to: peerId,
    from: getLocalId(),
    offer: { sdpType: offer.type, sdp: offer.sdp },
  });

  return { peerId, status: "connecting" };
}

async function doAnswer(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
  const offer = await resolve(def.offer, context) as RTCSessionDescriptionInit;
  const from = String(await resolve(def.from, context));
  const pc = createPeer(from);

  pc.ondatachannel = (event) => {
    const label = event.channel.label;
    setupChannel(event.channel, from, label);
    if (label === "fast") {
      fastChannels.set(from, event.channel);
    } else {
      channels.set(from, event.channel);
    }
  };

  const offerObj = offer as unknown as Record<string, unknown>;
  const offerDesc: RTCSessionDescriptionInit = {
    type: (offerObj.sdpType ?? offerObj.type ?? "offer") as RTCSdpType,
    sdp: (offerObj.sdp ?? "") as string,
  };
  await pc.setRemoteDescription(offerDesc);
  flushIceCandidates(from);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  signal({
    type: "rtc:answer",
    to: from,
    from: getLocalId(),
    answer: { sdpType: answer.type, sdp: answer.sdp },
  });

  return null;
}

async function doAccept(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
  const answer = await resolve(def.answer, context) as unknown as Record<string, unknown>;
  const from = String(await resolve(def.from, context));

  const pc = peers.get(from);
  if (!pc) return null;

  const answerDesc: RTCSessionDescriptionInit = {
    type: (answer.sdpType ?? answer.type ?? "answer") as RTCSdpType,
    sdp: (answer.sdp ?? "") as string,
  };
  await pc.setRemoteDescription(answerDesc);
  flushIceCandidates(from);
  return null;
}

// Queue ICE candidates that arrive before remote description is set
const pendingIce: Map<string, RTCIceCandidateInit[]> = new Map();

function flushIceCandidates(peerId: string): void {
  const queued = pendingIce.get(peerId);
  const pc = peers.get(peerId);
  if (!queued || !pc) return;
  pendingIce.delete(peerId);
  for (const candidate of queued) {
    pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
  }
}

async function doIce(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
  const candidate = await resolve(def.candidate, context) as RTCIceCandidateInit;
  const from = String(await resolve(def.from, context));

  const pc = peers.get(from);
  if (!pc) return null;

  if (!pc.remoteDescription) {
    if (!pendingIce.has(from)) pendingIce.set(from, []);
    pendingIce.get(from)!.push(candidate);
    return null;
  }

  await pc.addIceCandidate(new RTCIceCandidate(candidate));
  return null;
}

async function doSend(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
  const peerId = String(await resolve(def.id, context));
  const data = await resolve(def.data, context);
  const chName = def.channel ? String(await resolve(def.channel, context)) : "data";
  const channel = (chName === "fast" ? fastChannels : channels).get(peerId);
  if (!channel || channel.readyState !== "open") return null;
  channel.send(typeof data === "string" ? data : JSON.stringify(data));
  return null;
}

async function doBroadcast(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
  const data = await resolve(def.data, context);
  const chName = def.channel ? String(await resolve(def.channel, context)) : "data";
  const map = chName === "fast" ? fastChannels : channels;
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  for (const [, channel] of map) {
    if (channel.readyState === "open") {
      channel.send(payload);
    }
  }
  return null;
}

async function doClose(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
  const peerId = String(await resolve(def.id, context));
  closePeer(peerId);
  return null;
}

function getLocalId(): string | null {
  return localId ?? WsNode.getId();
}

function getWs(): WebSocket | null {
  return ws ?? WsNode.getConnection();
}

function createPeer(peerId: string): RTCPeerConnection {
  if (peers.has(peerId)) {
    closePeer(peerId);
  }

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      signal({
        type: "rtc:ice",
        to: peerId,
        from: getLocalId(),
        candidate: event.candidate,
      });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") {
      closePeer(peerId);
    }
  };

  peers.set(peerId, pc);
  return pc;
}

function setupChannel(channel: RTCDataChannel, peerId: string, _label: string): void {
  channel.onopen = () => {};

  channel.onmessage = (event) => {
    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      data = event.data;
    }

    // Programmatic callback
    if (onMessageFn) {
      onMessageFn(peerId, data);
    }

    // JSON template callback via { "rtc": "on-message", "do": [...] }
    if (onMessageSteps && onMessageContext) {
      runSteps(onMessageSteps, { ...onMessageContext, rtcMessage: data, rtcPeerId: peerId });
    }
  };

  channel.onclose = () => {
    channels.delete(peerId);
  };
}

function signal(message: Record<string, unknown>): void {
  const socket = getWs();
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  } else {
    console.warn("[WebRTC] signal: no open socket");
  }
}

function closePeer(peerId: string): void {
  const channel = channels.get(peerId);
  if (channel) {
    channel.close();
    channels.delete(peerId);
  }
  const fast = fastChannels.get(peerId);
  if (fast) {
    fast.close();
    fastChannels.delete(peerId);
  }
  const pc = peers.get(peerId);
  if (pc) {
    pc.close();
    peers.delete(peerId);
  }
}

function closeAll(): null {
  for (const peerId of peers.keys()) {
    closePeer(peerId);
  }
  return null;
}

async function runSteps(steps: unknown[], context: Context): Promise<void> {
  try {
    for (const step of steps) {
      const result = await resolve(step, context);
      if (step && typeof step === "object" && !Array.isArray(step) && "as" in step) {
        const varName = String((step as Record<string, unknown>).as).replace(/^\$/, "");
        context[varName] = result;
      }
    }
  } catch (error) {
    console.error("[WebRTC] Error in step execution:", error);
  }
}
