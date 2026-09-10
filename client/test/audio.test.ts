import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import { AudioNode } from "../src/nodes/AudioNode.js";

const resolve = createResolver([...coreNodes(), new AudioNode()]);

/**
 * Web Audio stand-ins. The node only ever creates a buffer source and a gain and
 * wires them to the master, so the graph is stubbed at that level and the tests
 * assert on what started, stopped, and at what gain.
 */
class FakeParam { constructor(public value = 1) {} }

class FakeGain {
  gain = new FakeParam();
  connectedTo: FakeGain | null = null;
  disconnected = false;
  connect(target: FakeGain): void { this.connectedTo = target; }
  disconnect(): void { this.disconnected = true; }
}

class FakeSource {
  buffer: unknown = null;
  loop = false;
  started = false;
  stopped = false;
  gain: FakeGain | null = null;
  onended: (() => void) | null = null;
  connect(target: FakeGain): void { this.gain = target; }
  start(): void { this.started = true; FakeSource.live.push(this); }
  stop(): void {
    if (this.stopped) throw new Error("already stopped");
    this.stopped = true;
    this.onended?.();
  }
  static live: FakeSource[] = [];
  static playing(): FakeSource[] { return FakeSource.live.filter(s => !s.stopped); }
}

class FakeAudioContext {
  state = "running";
  destination = {};
  createGain(): FakeGain { return new FakeGain(); }
  createBufferSource(): FakeSource { return new FakeSource(); }
  decodeAudioData(bytes: ArrayBuffer): Promise<unknown> {
    // A wav-ish header decodes; anything else is treated as corrupt.
    const header = new TextDecoder().decode(new Uint8Array(bytes).subarray(0, 4));
    return header === "RIFF" ? Promise.resolve({ duration: 1 }) : Promise.reject(new Error("bad header"));
  }
  resume(): void { this.state = "running"; }
  close(): Promise<void> { this.state = "closed"; return Promise.resolve(); }
}

const globals = globalThis as unknown as Record<string, unknown>;
globals.AudioContext = FakeAudioContext;

const realFetch = globalThis.fetch;
function stubFetch(body: string, status = 200): void {
  globalThis.fetch = (() => Promise.resolve(new Response(status === 200 ? body : null, {
    status,
    statusText: status === 404 ? "Not Found" : "",
  }))) as typeof fetch;
}

beforeEach(() => { FakeSource.live = []; });
afterEach(() => { globalThis.fetch = realFetch; });

/** Load a name into the shared instance, so the play tests have a buffer. */
async function load(name: string): Promise<void> {
  stubFetch("RIFFdata");
  await resolve({ "audio-load": name, url: `/audio/${name}.wav` }, {});
}

test("audio-load: a missing file throws with the status, rather than a console line", async () => {
  stubFetch("", 404);
  await assert.rejects(
    async () => { await resolve({ "audio-load": "shoot", url: "/audio/shoot.wav" }, {}); },
    (err: Error & { status?: number }) => {
      assert.equal(err.status, 404);
      assert.match(err.message, /Audio "shoot" failed to load from \/audio\/shoot\.wav: 404/);
      return true;
    },
  );
});

test("audio-load: an undecodable file says so, and catch can see it", async () => {
  stubFetch("not audio at all");
  const out = await resolve(
    { "audio-load": "broken", url: "/audio/broken.wav", catch: [{ var: "$error.message" }] },
    {},
  );
  assert.match(out as string, /Audio "broken" from \/audio\/broken\.wav could not be decoded: bad header/);
});

// A second play used to stop the first, which is wrong for a sound effect fired
// twice in quick succession.
test("audio-play: the same name overlaps by default", async () => {
  await load("shoot");
  await resolve({ "audio-play": "shoot" }, {});
  await resolve({ "audio-play": "shoot" }, {});
  assert.equal(FakeSource.playing().length, 2);
});

test("audio-play: restart stops what was already playing", async () => {
  await load("music");
  await resolve({ "audio-play": "music", loop: true }, {});
  await resolve({ "audio-play": "music", loop: true, restart: true }, {});
  assert.equal(FakeSource.playing().length, 1);
  assert.equal(FakeSource.live[0].stopped, true);
  assert.equal(FakeSource.live[1].loop, true);
});

test("audio-stop: stops every sound under the name", async () => {
  await load("shoot");
  await resolve({ "audio-play": "shoot" }, {});
  await resolve({ "audio-play": "shoot" }, {});
  await resolve({ "audio-play": "shoot" }, {});
  await resolve({ "audio-stop": "shoot" }, {});
  assert.equal(FakeSource.playing().length, 0);
});

/** The gain node a playing source routes through for its name's level. */
function levelOf(source: FakeSource): FakeGain {
  const level = source.gain?.connectedTo;
  assert.ok(level, "expected the sound to route through a level gain");
  return level;
}

test("audio-volume: one level for the name, shared by every sound under it", async () => {
  await load("shoot");
  await resolve({ "audio-play": "shoot", volume: 1 }, {});
  await resolve({ "audio-play": "shoot", volume: 1 }, {});
  await resolve({ "audio-volume": "shoot", volume: 0.25 }, {});

  const [first, second] = FakeSource.playing();
  assert.equal(levelOf(first), levelOf(second));
  assert.equal(levelOf(first).gain.value, 0.25);
});

// The reason it is a level and not a live nudge: a settings slider is moved
// before anything plays, and used to do nothing at all.
test("audio-volume: set before anything plays, and it still applies", async () => {
  await load("music");
  await resolve({ "audio-volume": "music", volume: 0.3 }, {});
  await resolve({ "audio-play": "music" }, {});
  assert.equal(levelOf(FakeSource.playing()[0]).gain.value, 0.3);
});

test("audio-volume: the level and the per-play volume multiply, they do not replace", async () => {
  await load("shoot");
  await resolve({ "audio-volume": "shoot", volume: 0.5 }, {});
  await resolve({ "audio-play": "shoot", volume: 0.8 }, {});
  const source = FakeSource.playing()[0];
  // A deliberately quiet shot stays quiet relative to the chosen level: the
  // graph multiplies 0.8 through 0.5 rather than one winning.
  assert.equal(source.gain?.gain.value, 0.8);
  assert.equal(levelOf(source).gain.value, 0.5);
});

test("audio-volume: a level survives the sounds it was set for", async () => {
  await load("shoot");
  await resolve({ "audio-volume": "shoot", volume: 0.4 }, {});
  await resolve({ "audio-play": "shoot" }, {});
  await resolve({ "audio-stop": "shoot" }, {});
  await resolve({ "audio-play": "shoot" }, {});
  assert.equal(levelOf(FakeSource.playing()[0]).gain.value, 0.4);
});

// The browser has no `file` node, so bytes come from a `fetch` step. Accepting
// them directly is what lets a load carry headers, credentials or a timeout.
test("audio-load: takes bytes already in hand, in any of the byte shapes", async () => {
  const wav = new TextEncoder().encode("RIFFdata");
  await resolve({ "audio-load": "a", content: { var: "$bytes" } }, { bytes: wav.buffer });
  await resolve({ "audio-load": "b", content: { var: "$bytes" } }, { bytes: wav });
  await resolve({ "audio-load": "c", content: { var: "$bytes" } }, { bytes: new Blob([wav]) });
  await resolve({ "audio-play": "a" }, {});
  await resolve({ "audio-play": "b" }, {});
  await resolve({ "audio-play": "c" }, {});
  assert.equal(FakeSource.playing().length, 3);
});

test("audio-load: needs one of url or content, and content must be bytes", async () => {
  await assert.rejects(
    async () => { await resolve({ "audio-load": "nothing" }, {}); },
    /Audio "nothing" needs a url to fetch or content to decode/,
  );
  await assert.rejects(
    async () => { await resolve({ "audio-load": "wrong", content: "/audio/x.wav" }, {}); },
    /Audio "wrong" content must be bytes/,
  );
});

// Nothing else frees a decoded buffer, so without this a page that loads sounds
// under generated names grows for its whole life.
test("audio-unload: forgets the sounds, the buffer and the level", async () => {
  await load("shoot");
  await resolve({ "audio-volume": "shoot", volume: 0.4 }, {});
  await resolve({ "audio-play": "shoot" }, {});
  await resolve({ "audio-unload": "shoot" }, {});
  assert.equal(FakeSource.playing().length, 0);

  // The buffer is gone, so playing again does nothing at all.
  await resolve({ "audio-play": "shoot" }, {});
  assert.equal(FakeSource.playing().length, 0);

  // And the level went with it: a reload starts at full, not at 0.4.
  await load("shoot");
  await resolve({ "audio-play": "shoot" }, {});
  assert.equal(levelOf(FakeSource.playing()[0]).gain.value, 1);
});

test("dispose: closes the context and drops everything it held", async () => {
  const node = new AudioNode();
  const own = createResolver([...coreNodes(), node]);
  stubFetch("RIFFdata");
  await own({ "audio-load": "theme", url: "/audio/theme.wav" }, {});
  await own({ "audio-volume": "theme", volume: 0.5 }, {});
  await own({ "audio-play": "theme", loop: true }, {});

  const graph = node.graph;
  assert.ok(graph, "expected a graph to have been built");
  const playing = FakeSource.playing().length;
  assert.equal(playing > 0, true);

  node.dispose();
  assert.equal(FakeSource.playing().length, 0);
  assert.equal(node.buffers.size, 0);
  assert.equal(node.levels.size, 0);
  assert.equal(node.graph, null);
  assert.equal((graph.ctx as unknown as FakeAudioContext).state, "closed");
});

test("dispose: safe before anything was ever played", () => {
  const node = new AudioNode();
  node.dispose();
  assert.equal(node.graph, null);
});

test("a sound that ends on its own is forgotten", async () => {
  await load("shoot");
  await resolve({ "audio-play": "shoot" }, {});
  const source = FakeSource.live[FakeSource.live.length - 1];
  source.onended?.();
  // Stopping a name whose sounds all ended is a no-op, not a throw.
  await resolve({ "audio-stop": "shoot" }, {});
});
