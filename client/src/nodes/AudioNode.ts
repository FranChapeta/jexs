import { Node, Context, NodeValue } from "@jexs/core";
import { resolve, resolveAll } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";

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
  static schema: JexsNodeSchema = {
    "audio-load": {
      type: "string",
      output: "null",
      markdownDescription: "Fetches and decodes an audio file, storing it under `name` for later playback with `audio-play`.",
      examples: [
        "{ \"audio-load\": \"shoot\", \"url\": \"/audio/shoot.wav\" }",
      ],
      siblings: {
        url: {
          type: "string",
          description: "URL of the audio file to load.",
        },
      },
    },
    "audio-play": {
      type: "string",
      output: "null",
      markdownDescription: "Plays a previously loaded audio buffer. Set `volume` (0–1) and `loop: true` for looping.\nStops any currently playing instance of the same name before starting.",
      examples: [
        "{ \"audio-play\": \"shoot\", \"volume\": 0.5, \"loop\": false }",
      ],
      siblings: {
        volume: {
          type: "number",
          description: "Playback volume 0–1 (default `1`).",
        },
        loop: {
          type: "boolean",
          description: "Whether to loop the audio (default `false`).",
        },
      },
    },
    "audio-stop": {
      type: "string",
      output: "null",
      markdownDescription: "Stops a playing audio buffer by name.",
      examples: [
        "{ \"audio-stop\": \"shoot\" }",
      ],
    },
    "audio-volume": {
      type: "string",
      output: "null",
      markdownDescription: "Adjusts the volume of a currently playing audio source without restarting it.",
      examples: [
        "{ \"audio-volume\": \"shoot\", \"volume\": 0.3 }",
      ],
      siblings: {
        volume: {
          type: "number",
          description: "New gain value 0–1.",
        },
      },
    },
    "audio-master": {
      type: "number",
      output: "null",
      markdownDescription: "Sets the master gain for all audio output in this context (0–1).",
      examples: [
        "{ \"audio-master\": 0.5 }",
      ],
    },
  };


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

  ["audio-volume"](def: Record<string, unknown>, context: Context): NodeValue {
    const inst = getInst(context);
    if (!inst) return null;
    return resolveAll([def["audio-volume"], def["volume"]], context, ([name, vol]: unknown[]) => {
      const existing = inst.sources.get(String(name));
      if (existing) existing.gain.gain.value = Number(vol);
      return null;
    });
  }

  ["audio-master"](def: Record<string, unknown>, context: Context): NodeValue {
    const inst = getInst(context);
    if (!inst) return null;
    return resolve(def["audio-master"], context, volume => {
      inst.masterGain.gain.value = Number(volume);
      return null;
    });
  }
}
