import { Node, Context, NodeValue } from "@jexs/core";
import { resolve } from "@jexs/core";

// ─── Audio state per instance ────────────────────────────────────────────────

interface AudioInstance {
  ctx: AudioContext;
  buffers: Map<string, AudioBuffer>;
  sources: Map<string, { source: AudioBufferSourceNode; gain: GainNode; loop: boolean }>;
  masterGain: GainNode;
}

const instances = new Map<string, AudioInstance>();

function getInst(context: Context): AudioInstance | null {
  const id = (context.__glId as string) ?? "default";
  let inst = instances.get(id);
  if (!inst) {
    const ctx = new AudioContext();
    const masterGain = ctx.createGain();
    masterGain.connect(ctx.destination);
    inst = { ctx, buffers: new Map(), sources: new Map(), masterGain };
    instances.set(id, inst);
  }
  // Resume if suspended (browsers require user gesture)
  if (inst.ctx.state === "suspended") inst.ctx.resume();
  return inst;
}

// ─── AudioNode ───────────────────────────────────────────────────────────────

export class AudioNode extends Node {

  // { "audio-load": "shoot", "url": "/audio/shoot.wav" }
  async ["audio-load"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const inst = getInst(context);
    if (!inst) return null;

    const name = String(await resolve(def["audio-load"], context));
    const url = String(await resolve(def["url"], context));

    try {
      const resp = await fetch(url);
      const arrayBuf = await resp.arrayBuffer();
      const audioBuf = await inst.ctx.decodeAudioData(arrayBuf);
      inst.buffers.set(name, audioBuf);
    } catch (e) {
      console.error("[Audio] Failed to load:", name, e);
    }
    return null;
  }

  // { "audio-play": "shoot", "volume": 0.5, "loop": false }
  async ["audio-play"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const inst = getInst(context);
    if (!inst) return null;

    const name = String(await resolve(def["audio-play"], context));
    const buffer = inst.buffers.get(name);
    if (!buffer) { console.warn("[Audio] Buffer not loaded:", name); return null; }

    const volume = def["volume"] !== undefined ? Number(await resolve(def["volume"], context)) : 1;
    const loop = def["loop"] !== undefined ? this.toBoolean(await resolve(def["loop"], context)) : false;

    // Stop existing source with same name if playing
    const existing = inst.sources.get(name);
    if (existing) {
      try { existing.source.stop(); } catch { /* already stopped */ }
    }

    const source = inst.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;

    const gain = inst.ctx.createGain();
    gain.gain.value = volume;
    source.connect(gain);
    gain.connect(inst.masterGain);

    source.start(0);
    inst.sources.set(name, { source, gain, loop });

    // Clean up when done (non-looping)
    source.onended = () => {
      const cur = inst.sources.get(name);
      if (cur?.source === source) inst.sources.delete(name);
    };

    return null;
  }

  // { "audio-stop": "shoot" }
  async ["audio-stop"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const inst = getInst(context);
    if (!inst) return null;

    const name = String(await resolve(def["audio-stop"], context));
    const existing = inst.sources.get(name);
    if (existing) {
      try { existing.source.stop(); } catch { /* already stopped */ }
      inst.sources.delete(name);
    }
    return null;
  }

  // { "audio-volume": "shoot", "volume": 0.3 }
  async ["audio-volume"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const inst = getInst(context);
    if (!inst) return null;

    const name = String(await resolve(def["audio-volume"], context));
    const volume = Number(await resolve(def["volume"], context));
    const existing = inst.sources.get(name);
    if (existing) {
      existing.gain.gain.value = volume;
    }
    return null;
  }

  // { "audio-master": 0.5 } — set master volume
  async ["audio-master"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const inst = getInst(context);
    if (!inst) return null;

    const volume = Number(await resolve(def["audio-master"], context));
    inst.masterGain.gain.value = volume;
    return null;
  }
}
