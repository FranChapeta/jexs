import { Node, Context, NodeValue } from "@jexs/core";
import { resolve, resolveAll } from "@jexs/core";

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

  /**
   * Fetches and decodes an audio file, storing it under `name` for later playback with `audio-play`.
   * @param {string} audio-load Name to register the audio buffer under.
   * @param {string} url URL of the audio file to load.
   * @example
   * { "audio-load": "shoot", "url": "/audio/shoot.wav" }
   */
  ["audio-load"](def: Record<string, unknown>, context: Context): NodeValue {
    const inst = getInst(context);
    if (!inst) return null;
    return resolveAll([def["audio-load"], def["url"]], context, async ([nameRaw, urlRaw]) => {
      const name = String(nameRaw);
      const url = String(urlRaw);
      try {
        const resp = await fetch(url);
        const arrayBuf = await resp.arrayBuffer();
        const audioBuf = await inst.ctx.decodeAudioData(arrayBuf);
        inst.buffers.set(name, audioBuf);
      } catch (e) {
        console.error("[Audio] Failed to load:", name, e);
      }
      return null;
    });
  }

  /**
   * Plays a previously loaded audio buffer. Set `volume` (0–1) and `loop: true` for looping.
   * Stops any currently playing instance of the same name before starting.
   * @param {string} audio-play Name of the buffer to play (must be loaded via `audio-load`).
   * @param {number} volume Playback volume 0–1 (default `1`).
   * @param {boolean} loop Whether to loop the audio (default `false`).
   * @example
   * { "audio-play": "shoot", "volume": 0.5, "loop": false }
   */
  ["audio-play"](def: Record<string, unknown>, context: Context): NodeValue {
    const inst = getInst(context);
    if (!inst) return null;
    return resolveAll(
      [def["audio-play"], def["volume"] ?? 1, def["loop"] ?? false],
      context,
      ([nameRaw, volumeRaw, loopRaw]: unknown[]) => {
        const name = String(nameRaw);
        const buffer = inst.buffers.get(name);
        if (!buffer) { console.warn("[Audio] Buffer not loaded:", name); return null; }

        const volume = Number(volumeRaw);
        const loop = this.toBoolean(loopRaw);

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

        source.onended = () => {
          const cur = inst.sources.get(name);
          if (cur?.source === source) inst.sources.delete(name);
        };

        return null;
      },
    );
  }

  /**
   * Stops a playing audio buffer by name.
   * @param {string} audio-stop Name of the buffer to stop.
   * @example
   * { "audio-stop": "shoot" }
   */
  ["audio-stop"](def: Record<string, unknown>, context: Context): NodeValue {
    const inst = getInst(context);
    if (!inst) return null;
    return resolve(def["audio-stop"], context, name => {
      const existing = inst.sources.get(String(name));
      if (existing) {
        try { existing.source.stop(); } catch { /* already stopped */ }
        inst.sources.delete(String(name));
      }
      return null;
    });
  }

  /**
   * Adjusts the volume of a currently playing audio source without restarting it.
   * @param {string} audio-volume Name of the buffer to adjust.
   * @param {number} volume New gain value 0–1.
   * @example
   * { "audio-volume": "shoot", "volume": 0.3 }
   */
  ["audio-volume"](def: Record<string, unknown>, context: Context): NodeValue {
    const inst = getInst(context);
    if (!inst) return null;
    return resolveAll([def["audio-volume"], def["volume"]], context, ([name, vol]: unknown[]) => {
      const existing = inst.sources.get(String(name));
      if (existing) existing.gain.gain.value = Number(vol);
      return null;
    });
  }

  /**
   * Sets the master gain for all audio output in this context (0–1).
   * @param {number} audio-master Master gain value 0–1.
   * @example
   * { "audio-master": 0.5 }
   */
  ["audio-master"](def: Record<string, unknown>, context: Context): NodeValue {
    const inst = getInst(context);
    if (!inst) return null;
    return resolve(def["audio-master"], context, volume => {
      inst.masterGain.gain.value = Number(volume);
      return null;
    });
  }
}
