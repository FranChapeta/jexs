import { Node, Context, NodeValue, runSteps } from "@jexs/core";
import { resolve, resolveAll } from "@jexs/core";
import { WsNode } from "./WsNode.js";

// Module-level state
const peers: Map<string, RTCPeerConnection> = new Map();
const channels: Map<string, RTCDataChannel> = new Map();
const fastChannels: Map<string, RTCDataChannel> = new Map();
let ws: WebSocket | null = null;
let localId: string | null = null;
let onMessageSteps: unknown[] | null = null;
let onMessageContext: Context | null = null;
const FAST_BUFFERED_AMOUNT_LIMIT = 128 * 1024;
const pendingFastCoalescedByKey: Map<string, { peerId: string; data: unknown }> = new Map();
let fastCoalesceFlushScheduled = false;
let fastCoalesceProcessing = false;
const FAST_COALESCE_FLUSH_MS = 16;

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
  /**
   * Manages WebRTC peer connections. Signaling is done over the active `WsNode` WebSocket connection.
   * Operations: `"connect"`, `"answer"`, `"accept"`, `"ice"`, `"send"`, `"broadcast"`, `"close"`, `"close-all"`, `"on-message"`.
   * Use `"channel": "fast"` for unreliable (low-latency) delivery; default channel is reliable.
   * @param {"connect"|"answer"|"accept"|"ice"|"send"|"broadcast"|"close"|"close-all"|"on-message"} rtc Operation to perform.
   * @param {string} id Peer connection ID (used with `"connect"`, `"send"`, `"close"`).
   * @param {expr} data Data to send (used with `"send"`, `"broadcast"`).
   * @param {"data"|"fast"} channel Data channel: `"data"` (reliable) or `"fast"` (unreliable, low-latency).
   * @param {steps} do Steps to run on incoming messages, with `$rtcMessage` and `$rtcPeerId` in context (used with `"on-message"`).
   * @example
   * { "rtc": "connect", "id": { "var": "$peerId" } }
   */
  rtc(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.rtc, context, operation => {
      switch (operation) {
        case "connect":   return doConnect(def, context);
        case "answer":    return doAnswer(def, context);
        case "accept":    return doAccept(def, context);
        case "ice":       return doIce(def, context);
        case "send":      return doSend(def, context);
        case "broadcast": return doBroadcast(def, context);
        case "close":     return doClose(def, context);
        case "close-all": return closeAll();
        case "set-ws":    return doSetWs(def, context);
        case "on-message": return doOnMessage(def, context);
        default:
          console.error(`[WebRTC] Unknown operation: ${operation}`);
          return null;
      }
    });
  }

  static closeAll = closeAll;
  static setOnMessage(fn: (peerId: string, data: unknown) => void): void {
    onMessageFn = fn;
  }
}

// Callback set via static setOnMessage (programmatic)
let onMessageFn: ((peerId: string, data: unknown) => void) | null = null;

function doSetWs(def: Record<string, unknown>, context: Context): unknown {
  return resolveAll([def.ws, def.id], context, ([wsRaw, idRaw]: unknown[]) => {
    ws = wsRaw as WebSocket;
    localId = String(idRaw);
    return null;
  });
}

function doOnMessage(def: Record<string, unknown>, _context: Context): unknown {
  if (Array.isArray(def.do)) {
    onMessageSteps = def.do as unknown[];
    onMessageContext = { ..._context };
  }
  return null;
}

function doConnect(def: Record<string, unknown>, context: Context): unknown {
  return resolve(def.id, context, async id => {
    const peerId = String(id);
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
  });
}

function doAnswer(def: Record<string, unknown>, context: Context): unknown {
  return resolveAll([def.offer, def.from], context, async ([offerRaw, fromRaw]: unknown[]) => {
    const from = String(fromRaw);
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

    const offerObj = offerRaw as Record<string, unknown>;
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
  });
}

function doAccept(def: Record<string, unknown>, context: Context): unknown {
  return resolveAll([def.answer, def.from], context, async ([answerRaw, fromRaw]: unknown[]) => {
    const answer = answerRaw as Record<string, unknown>;
    const from = String(fromRaw);

    const pc = peers.get(from);
    if (!pc) return null;

    const answerDesc: RTCSessionDescriptionInit = {
      type: (answer.sdpType ?? answer.type ?? "answer") as RTCSdpType,
      sdp: (answer.sdp ?? "") as string,
    };
    await pc.setRemoteDescription(answerDesc);
    flushIceCandidates(from);
    return null;
  });
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

function doIce(def: Record<string, unknown>, context: Context): unknown {
  return resolveAll([def.candidate, def.from], context, async ([candidateRaw, fromRaw]: unknown[]) => {
    const candidate = candidateRaw as RTCIceCandidateInit;
    const from = String(fromRaw);

    const pc = peers.get(from);
    if (!pc) return null;

    if (!pc.remoteDescription) {
      if (!pendingIce.has(from)) pendingIce.set(from, []);
      pendingIce.get(from)!.push(candidate);
      return null;
    }

    await pc.addIceCandidate(new RTCIceCandidate(candidate));
    return null;
  });
}

function doSend(def: Record<string, unknown>, context: Context): unknown {
  return resolveAll([def.id, def.data, def.channel ?? "data"], context, ([idRaw, data, chRaw]: unknown[]) => {
    const isFast = String(chRaw) === "fast";
    const channel = (isFast ? fastChannels : channels).get(String(idRaw));
    if (!channel || channel.readyState !== "open") return null;
    if (isFast && channel.bufferedAmount > FAST_BUFFERED_AMOUNT_LIMIT) return null;
    channel.send(typeof data === "string" ? data : JSON.stringify(data));
    return null;
  });
}

function doBroadcast(def: Record<string, unknown>, context: Context): unknown {
  return resolveAll([def.data, def.channel ?? "data"], context, ([data, chRaw]: unknown[]) => {
    const isFast = String(chRaw) === "fast";
    const map = isFast ? fastChannels : channels;
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    for (const [, channel] of map) {
      if (channel.readyState !== "open") continue;
      if (isFast && channel.bufferedAmount > FAST_BUFFERED_AMOUNT_LIMIT) continue;
      channel.send(payload);
    }
    return null;
  });
}

function doClose(def: Record<string, unknown>, context: Context): unknown {
  return resolve(def.id, context, id => {
    closePeer(String(id));
    return null;
  });
}

function getLocalId(): string | null {
  return localId ?? WsNode.getId();
}

function getWs(): WebSocket | null {
  return ws ?? WsNode.getConnection();
}

function createPeer(peerId: string): RTCPeerConnection {
  if (peers.has(peerId)) closePeer(peerId);

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
    if (pc.connectionState === "failed" || pc.connectionState === "closed") closePeer(peerId);
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

    if (_label === "fast") {
      const coalesceKey = getFastCoalesceKey(peerId, data);
      if (coalesceKey) {
        pendingFastCoalescedByKey.set(coalesceKey, { peerId, data });
        scheduleFastCoalesceFlush();
        return;
      }
    }

    dispatchRtcMessage(peerId, data);
  };

  channel.onclose = () => {
    channels.delete(peerId);
    for (const [key, entry] of pendingFastCoalescedByKey) {
      if (entry.peerId === peerId) pendingFastCoalescedByKey.delete(key);
    }
  };
}

function getFastCoalesceKey(peerId: string, data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const message = data as Record<string, unknown>;
  if (message.__coalesce !== true) return null;

  const customKey = typeof message.__coalesceKey === "string" ? message.__coalesceKey.trim() : "";
  if (customKey) return `${peerId}:${customKey}`;

  const type = typeof message.type === "string" ? message.type : "message";
  return `${peerId}:${type}`;
}

function scheduleFastCoalesceFlush(): void {
  if (fastCoalesceFlushScheduled) return;
  fastCoalesceFlushScheduled = true;
  setTimeout(() => {
    fastCoalesceFlushScheduled = false;
    if (pendingFastCoalescedByKey.size === 0) return;
    if (fastCoalesceProcessing) {
      scheduleFastCoalesceFlush();
      return;
    }

    const batch = Array.from(pendingFastCoalescedByKey.values());
    pendingFastCoalescedByKey.clear();

    fastCoalesceProcessing = true;
    Promise.allSettled(batch.map(entry => Promise.resolve(dispatchRtcMessage(entry.peerId, entry.data))))
      .finally(() => {
        fastCoalesceProcessing = false;
        if (pendingFastCoalescedByKey.size > 0) scheduleFastCoalesceFlush();
      });
  }, FAST_COALESCE_FLUSH_MS);
}

function dispatchRtcMessage(peerId: string, data: unknown): unknown {
  if (onMessageFn) onMessageFn(peerId, data);

  if (onMessageSteps && onMessageContext) {
    return Promise.resolve(runSteps(onMessageSteps, { ...onMessageContext, rtcMessage: data, rtcPeerId: peerId }))
      .catch(e => console.error("[WebRTC] on-message error:", e));
  }

  return null;
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
  if (channel) { channel.close(); channels.delete(peerId); }
  const fast = fastChannels.get(peerId);
  if (fast) { fast.close(); fastChannels.delete(peerId); }
  const pc = peers.get(peerId);
  if (pc) { pc.close(); peers.delete(peerId); }
}

function closeAll(): null {
  for (const peerId of peers.keys()) closePeer(peerId);
  return null;
}
