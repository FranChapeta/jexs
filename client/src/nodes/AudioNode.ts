import { Node, Context, NodeValue, createHttpError } from "@jexs/core";
import { resolve, resolveAll } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";

// ─── Audio state per instance ────────────────────────────────────────────────

/** One playing copy of a buffer. A name can have several at once. */
interface Sound {
  source: AudioBufferSourceNode;
  gain: GainNode;
  loop: boolean;
}

/** The context and the gain everything ends at, created together or not at all. */
interface AudioGraph {
  ctx: AudioContext;
  master: GainNode;
}

/**
 * The node's context and master gain, built on first use. A module function
 * rather than a method because every method on a Node is a dispatch key, so a
 * helper declared there would register as an op named after it.
 */
function audioGraph(node: AudioNode): AudioGraph {
  if (!node.graph) {
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.connect(ctx.destination);
    node.graph = { ctx, master };
  }
  // Browsers start a context suspended until a user gesture.
  if (node.graph.ctx.state === "suspended") node.graph.ctx.resume();
  return node.graph;
}

/** The gain every sound under a name passes through, created on first use. */
function levelFor(node: AudioNode, name: string): GainNode {
  const existing = node.levels.get(name);
  if (existing) return existing;
  const { ctx, master } = audioGraph(node);
  const level = ctx.createGain();
  level.connect(master);
  node.levels.set(name, level);
  return level;
}

async function fetchAudio(name: string, url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw createHttpError(
      response.status,
      `Audio "${name}" failed to load from ${url}: ${response.status} ${response.statusText}`,
    );
  }
  return response.arrayBuffer();
}

/**
 * Bytes handed in rather than fetched. `decodeAudioData` takes an ArrayBuffer and
 * detaches it, so a typed array's buffer is copied rather than passed: the caller
 * may still be holding that view.
 */
async function audioBytes(name: string, content: unknown): Promise<ArrayBuffer> {
  if (content instanceof ArrayBuffer) return content;
  if (ArrayBuffer.isView(content)) {
    return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
  }
  if (typeof Blob !== "undefined" && content instanceof Blob) return content.arrayBuffer();
  throw new Error(
    `Audio "${name}" content must be bytes: an ArrayBuffer, a typed array or a Blob, ` +
    `e.g. { "fetch": "/audio/${name}.wav", "as": "bytes" } then { "content": { "var": "$bytes" } }`,
  );
}

/** Stop every sound playing under a name. Their `onended` clears the entry. */
function stopSounds(node: AudioNode, name: string): void {
  const playing = node.sources.get(name);
  if (!playing) return;
  for (const sound of playing) {
    try { sound.source.stop(); } catch { /* already stopped */ }
  }
  node.sources.delete(name);
}

// ─── AudioNode ───────────────────────────────────────────────────────────────

export class AudioNode extends Node {
  /** Decoded buffers by name, held until `audio-unload` or `dispose`. */
  readonly buffers = new Map<string, AudioBuffer>();

  /**
   * Playing sounds by name, plural: an effect fired twice in quick succession
   * overlaps, rather than the second cutting the first off. Pass `restart: true`
   * to `audio-play` for the one-at-a-time behavior.
   */
  readonly sources = new Map<string, Set<Sound>>();

  /**
   * One gain per name, which is what makes `audio-volume` a level rather than a
   * live nudge: sounds route through their name's gain, so a level set before
   * anything plays still applies to what plays later, and one set during
   * playback carries to the next shot. Same arrangement as the master, one layer
   * down.
   */
  readonly levels = new Map<string, GainNode>();

  /**
   * The context and master gain, which unlike the maps cannot exist yet: the
   * node is constructed wherever it is registered, including in Node.js by the
   * schema generator, where `AudioContext` does not exist. `audioGraph` builds
   * the pair on first use, and the two are absent or present together.
   *
   * All of it lives on the node, so it belongs to one resolver: two apps on a
   * page get their own buffers and levels rather than sharing a process-wide
   * registry, and `resolver.destroy()` has something it can reach.
   */
  graph: AudioGraph | null = null;

  static schema: JexsNodeSchema = {
    "audio-load": {
      type: "string",
      output: "null",
      markdownDescription: "Decodes an audio file and stores it under `name` for later playback with `audio-play`. The audio arrives one of two ways: a `url` to fetch, or `content` already in hand.\n\nA file that cannot be fetched or decoded throws, so `catch` sees it at the point of loading rather than leaving `audio-play` to warn about a missing buffer much later.",
      examples: [
        "{ \"audio-load\": \"shoot\", \"url\": \"/audio/shoot.wav\" }",
        "[{ \"fetch\": \"/audio/theme.ogg\", \"headers\": { \"Authorization\": { \"var\": \"$auth\" } }, \"as\": \"bytes\" },\n { \"audio-load\": \"theme\", \"content\": { \"var\": \"$bytes\" } }]",
      ],
      variants: {
        url: {
          type: "string",
          markdownDescription: "URL of the audio file to fetch and decode. Under Electron a relative url resolves against the `app://` scheme and is served from `dist/browser`, so the audio has to ship there like any other asset.",
        },
        content: {
          markdownDescription: "The encoded audio bytes, when something else already loaded them: an ArrayBuffer, a typed array or a Blob. A `fetch` step returns exactly this for a known audio extension, which is the way to load audio that needs headers, credentials or a timeout.",
        },
      },
    },
    "audio-unload": {
      type: "string",
      output: "null",
      markdownDescription: "Forgets a name: stops whatever is playing under it, drops the decoded buffer, and drops any level set for it.\n\nNothing else frees them. A decoded buffer is the expensive thing a page holds, and both it and the level live until this runs or the resolver is destroyed, so a game loading per-level sounds wants this on the way out.",
      examples: [
        "{ \"audio-unload\": \"shoot\" }",
      ],
    },
    "audio-play": {
      type: "string",
      output: "null",
      markdownDescription: "Plays a previously loaded audio buffer. Set `volume` (0-1) and `loop: true` for looping.\n\nPlaying the same name again overlaps it, which is what a sound effect fired twice in quick succession should do. Pass `restart: true` for the one-at-a-time behavior, which is what music or a voice line wants.",
      examples: [
        "{ \"audio-play\": \"shoot\", \"volume\": 0.5 }",
        "{ \"audio-play\": \"music\", \"loop\": true, \"restart\": true }",
      ],
      siblings: {
        volume: {
          type: "number",
          description: "Playback volume 0-1 (default `1`).",
        },
        loop: {
          type: "boolean",
          description: "Whether to loop the audio (default `false`).",
        },
        restart: {
          type: "boolean",
          description: "Stop any sounds already playing under this name first, instead of overlapping them.",
        },
      },
    },
    "audio-stop": {
      type: "string",
      output: "null",
      markdownDescription: "Stops every sound playing under a name.",
      examples: [
        "{ \"audio-stop\": \"shoot\" }",
      ],
    },
    "audio-volume": {
      type: "string",
      output: "null",
      markdownDescription: "Sets the level for a name: what is playing under it changes without restarting, and so does everything played under it afterwards. That makes it the thing to wire a settings slider to, and it works before anything has played.\n\nIt multiplies rather than replaces: the level, the `volume` on each `audio-play`, and `audio-master` all apply, so a deliberately quiet shot stays quiet relative to whatever level the player chose.",
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
    const { ctx } = audioGraph(this);
    return resolveAll([def["audio-load"], def["url"] ?? null, def["content"] ?? null], context,
      async ([nameRaw, urlRaw, contentRaw]) => {
        const name = String(nameRaw);
        if (urlRaw == null && contentRaw == null) {
          throw new Error(`Audio "${name}" needs a url to fetch or content to decode`);
        }
        const from = urlRaw == null ? "the content given" : String(urlRaw);
        // A miss used to be a console line, leaving the template to find out later
        // when audio-play warned about a buffer that was never there.
        const bytes = contentRaw == null
          ? await fetchAudio(name, String(urlRaw))
          : await audioBytes(name, contentRaw);

        let decoded: AudioBuffer;
        try {
          decoded = await ctx.decodeAudioData(bytes);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`Audio "${name}" from ${from} could not be decoded: ${reason}`);
        }
        this.buffers.set(name, decoded);
        return null;
      },
    );
  }

  ["audio-play"](def: Record<string, unknown>, context: Context): NodeValue {
    const { ctx } = audioGraph(this);
    return resolveAll(
      [def["audio-play"], def["volume"] ?? 1, def["loop"] ?? false, def["restart"] ?? false],
      context,
      ([nameRaw, volumeRaw, loopRaw, restartRaw]: unknown[]) => {
        const name = String(nameRaw);
        const buffer = this.buffers.get(name);
        if (!buffer) { console.warn("[Audio] Buffer not loaded:", name); return null; }

        const volume = Number(volumeRaw);
        const loop = this.toBoolean(loopRaw);

        if (this.toBoolean(restartRaw)) stopSounds(this, name);

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = loop;

        // Per-shot volume, under the name's level, under the master: the three
        // multiply, so a quiet distant gunshot stays relative to whatever the
        // player set the effects level to.
        const gain = ctx.createGain();
        gain.gain.value = volume;
        source.connect(gain);
        gain.connect(levelFor(this, name));

        source.start(0);
        const sound: Sound = { source, gain, loop };
        const playing = this.sources.get(name);
        if (playing) playing.add(sound);
        else this.sources.set(name, new Set([sound]));

        source.onended = () => {
          const current = this.sources.get(name);
          if (!current) return;
          current.delete(sound);
          if (current.size === 0) this.sources.delete(name);
        };

        return null;
      },
    );
  }

  ["audio-stop"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["audio-stop"], context, name => {
      stopSounds(this, this.toString(name));
      return null;
    });
  }

  ["audio-volume"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def["audio-volume"], def["volume"]], context, ([name, vol]: unknown[]) => {
      levelFor(this, this.toString(name)).gain.value = Number(vol);
      return null;
    });
  }

  ["audio-master"](def: Record<string, unknown>, context: Context): NodeValue {
    const { master } = audioGraph(this);
    return resolve(def["audio-master"], context, volume => {
      master.gain.value = Number(volume);
      return null;
    });
  }

  ["audio-unload"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["audio-unload"], context, nameRaw => {
      // No `audioGraph(this)`: forgetting a name never needs a context, so
      // unloading before anything loaded does not build one.
      const name = this.toString(nameRaw);
      stopSounds(this, name);
      this.buffers.delete(name);
      const level = this.levels.get(name);
      if (level) {
        level.disconnect();
        this.levels.delete(name);
      }
      return null;
    });
  }

  /**
   * Release the whole graph, called by `resolver.destroy()`. Without it a torn
   * down resolver left its AudioContext open and every decoded buffer reachable,
   * which is the expensive half of what this node holds.
   */
  dispose(): void {
    for (const name of [...this.sources.keys()]) stopSounds(this, name);
    for (const level of this.levels.values()) level.disconnect();
    this.levels.clear();
    this.buffers.clear();
    if (!this.graph) return;
    this.graph.master.disconnect();
    // Closing is async and nothing waits on it; a context already closed by the
    // page rejects, which is not a failure worth reporting from teardown.
    void Promise.resolve(this.graph.ctx.close()).catch(() => { /* already closed */ });
    this.graph = null;
  }
}
