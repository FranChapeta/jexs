/**
 * TimerNode — steps repeated at an interval, and pauses.
 *
 * Interval: a drift-compensating loop, for frame loops and scheduled tasks alike.
 * - { "$interval": "start", "id": "poll", "every": "30s", "do": [...] }
 * - { "$interval": "start", "id": "game", "rate": 16, "do": [...] }
 * - { "$interval": "stop", "id": "poll" }
 * - { "$interval": "pause", "id": "poll" }
 * - { "$interval": "resume", "id": "poll" }
 * Each run's scope: count, and dt, elapsed, lastRun in ms
 * Period: `every` as a duration ("500ms", "30s", "5m", "1h", "1d"), or `rate` in milliseconds.
 */

import { Node, Context, NodeValue, childContext } from "./Node.js";
import { resolve, resolveAll, runStepsDetached } from "../Resolver.js";
import type { JexsNodeSchema, JexsMethodSchema, JexsPropertySchema } from "../schema.js";

const TIMER_ID: JexsPropertySchema = {
  type: "string",
  required: true,
  description: "The timer's name, unique among this resolver's timers; `stop`, `pause` and `resume` find it by this.",
};

// `start` takes the timer's inputs; stop/pause/resume take only `id`, and inherit
// the method's `output: "null"`.
const LIFECYCLE_OPS: Record<string, JexsMethodSchema> = {
  stop:   { output: "boolean", markdownDescription: "Stops the timer and clears its state.", outputDescription: "`true` if a timer by that id was running, otherwise `false`." },
  pause:  { output: "null", markdownDescription: "Pauses the timer; its state is kept so `resume` continues where it left off. An unknown id is an error." },
  resume: { output: "null", markdownDescription: "Resumes a paused timer. An unknown id is an error." },
};

// ─── Shared state ───────────────────────────────────────────────────────────

interface TimerState {
  id: string;
  intervalMs: number;
  steps: unknown;
  context: Context;
  /** The originating step, so a deferred failure can honor its `$catch`. */
  def: Record<string, unknown>;
  detach: boolean;
  timerId: ReturnType<typeof setTimeout> | null;
  count: number;
  startTime: number;
  lastTime: number;
  paused: boolean;
  pausedAt: number | null;
  pausedTotal: number;
  registry: Map<string, TimerState>;
}

// ─── TimerNode ──────────────────────────────────────────────────────────────

export class TimerNode extends Node {
  static schema: JexsNodeSchema = {
    interval: {
      type: "string",
      enum: [
        "start",
        "stop",
        "pause",
        "resume",
      ],
      output: "null",
      markdownDescription: "Repeats steps at a fixed interval, compensating for drift, from a frame loop (`rate: 16`) to a scheduled task (`every: \"5m\"`). Each run waits for the last one's steps unless `detach` is set. Each run has a scope of its own, holding `count` (runs so far, this one included), `dt` (milliseconds since the last run), `elapsed` (milliseconds since start, pauses excluded) and `lastRun` (the run's time, in Unix milliseconds); a write that later runs or the caller read needs `$bubble`.",
      examples: [
        "{ \"$interval\": \"start\", \"id\": \"poll\", \"every\": \"30s\", \"do\": [{ \"$fetch\": \"/api/status\" }] }",
        "{ \"$interval\": \"start\", \"id\": \"game\", \"rate\": 16, \"detach\": true, \"do\": [{ \"$var\": \"dt\" }] }",
      ],
      siblings: {
        id: TIMER_ID,
      },
      variants: {
        start: {
          output: "string",
          markdownDescription: "Begins the timer, returning its `id`. Give its period with `every` or `rate`. The `do` steps run in the background, so their values are not returned here.",
          // The period is `every` or `rate`, each a variant selected by its presence,
          // and exactly one of them is given.
          requireVariant: true,
          exclusive: true,
          variants: {
            every: {
              type: "string",
              pattern: "^\\d+(\\.\\d+)?\\s*(ms|s|m|h|d)$",
              description: "Time between runs as a duration: `\"500ms\"`, `\"30s\"`, `\"5m\"`, `\"1h\"`, `\"1d\"`. Give this or `rate`.",
            },
            rate: {
              type: "number",
              description: "Time between runs in milliseconds, e.g. `16` for about 60 runs per second. Give this or `every`.",
            },
          },
          siblings: {
            detach: {
              type: "boolean",
              description: "Start each run on schedule without waiting for the previous run's steps to finish (default `false`).",
            },
            do: {
              steps: true,
              required: true,
              description: "Steps to run each time. An array runs as a sequence; a single expression is run on its own.",
            },
          },
        },
        ...LIFECYCLE_OPS,
      },
    },
    sleep: {
      type: "number",
      output: "null",
      markdownDescription: "Pauses execution for the given number of milliseconds.",
      outputDescription: "Always `null`, after the delay elapses (a value ≤ 0 resolves immediately).",
      examples: [
        "{ \"$sleep\": 500 }",
      ],
    },
  };

  readonly timers = new Map<string, TimerState>();

  sleep(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$sleep, context, ms => {
      const delay = this.toNumber(ms);
      if (delay <= 0) return null;
      return new Promise<null>(r => setTimeout(r, delay)).then(() => null);
    });
  }

  interval(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$interval, context, op => {
      switch (String(op)) {
        case "start": return start(def, context, this.timers);
        case "stop": return stop(def, context, this.timers);
        case "pause": return pause(def, context, this.timers);
        case "resume": return resume(def, context, this.timers);
        default: throw new Error(`$interval: unknown operation ${JSON.stringify(op)}`);
      }
    });
  }

  /** Timers outlive their resolver unless stopped, so tear them down with it. */
  dispose(): void {
    for (const s of this.timers.values()) { if (s.timerId != null) clearTimeout(s.timerId); }
    this.timers.clear();
  }
}

/** A timer's `id`, which every op needs: a missing one would name every unnamed timer alike. */
function timerId(raw: unknown): string {
  if (raw == null || raw === "") throw new Error("interval needs an `id`");
  return String(raw);
}

// ─── stop / pause / resume ──────────────────────────────────────────────────

/** A timer that `pause` or `resume` acts on, which must be running. */
function running(registry: Map<string, TimerState>, raw: unknown, op: string): TimerState {
  const id = timerId(raw);
  const state = registry.get(id);
  if (!state) throw new Error(`$interval ${op}: no timer "${id}" is running`);
  return state;
}

/** Stopping is a removal, so a timer that is not running is reported, not an error. */
function stop(def: Record<string, unknown>, context: Context, registry: Map<string, TimerState>): unknown {
  return resolve(def.id, context, raw => {
    const id = timerId(raw);
    const state = registry.get(id);
    if (!state) return false;
    if (state.timerId != null) clearTimeout(state.timerId);
    registry.delete(id);
    return true;
  });
}

function pause(def: Record<string, unknown>, context: Context, registry: Map<string, TimerState>): unknown {
  return resolve(def.id, context, raw => {
    const state = running(registry, raw, "pause");
    if (state.paused) return null;
    state.paused = true;
    state.pausedAt = Date.now();
    return null;
  });
}

function resume(def: Record<string, unknown>, context: Context, registry: Map<string, TimerState>): unknown {
  return resolve(def.id, context, raw => {
    const state = running(registry, raw, "resume");
    if (!state.paused) return null;
    if (state.pausedAt != null) state.pausedTotal += Date.now() - state.pausedAt;
    state.paused = false;
    state.pausedAt = null;
    state.lastTime = Date.now();
    return null;
  });
}

// ─── start: a compensating setTimeout loop ──────────────────────────────────

const MULTIPLIERS: Record<string, number> = {
  ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000,
};

/** Parse a human-readable interval like "5m", "1h", "30s" to milliseconds. */
function parseInterval(value: string): number {
  const match = value.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/);
  if (!match) throw new Error(`Invalid interval: "${value}"`);
  return Math.round(parseFloat(match[1]) * MULTIPLIERS[match[2]]);
}

/** The time between runs in milliseconds, from exactly one of `every` (a duration) and `rate` (ms). */
function periodOf(every: unknown, rate: unknown): number {
  if (every != null && rate != null) throw new Error("interval takes `every` or `rate`, not both");
  if (every != null) return parseInterval(String(every));
  if (rate != null) {
    const ms = Number(rate);
    if (!(ms > 0)) throw new Error(`interval rate must be a positive number of milliseconds, not ${JSON.stringify(rate)}`);
    return ms;
  }
  throw new Error("interval needs `every` or `rate`");
}

function start(def: Record<string, unknown>, context: Context, registry: Map<string, TimerState>): unknown {
  return resolveAll([def.id, def.every, def.rate, def.detach ?? false], context, ([idRaw, every, rate, detachRaw]) => {
    const id = timerId(idRaw);
    const intervalMs = periodOf(every, rate);
    // No steps means a timer that runs forever doing nothing, which looks like a
    // hung app rather than a mistake, so it is an error rather than a no-op.
    if (def.do === undefined) throw new Error("interval needs `do` steps");
    const detach = detachRaw === true || detachRaw === 1 || detachRaw === "1" || detachRaw === "true";

    const prev = registry.get(id);
    if (prev?.timerId != null) clearTimeout(prev.timerId);

    const now = Date.now();
    const state: TimerState = {
      id, intervalMs, steps: def.do, context, def, detach,
      timerId: null, count: 0, startTime: now, lastTime: now,
      paused: false, pausedAt: null, pausedTotal: 0, registry,
    };

    registry.set(id, state);
    schedule(state);
    return id;
  });
}

function schedule(state: TimerState): void {
  const now = Date.now();
  const drift = now - state.lastTime - state.intervalMs;
  const delay = Math.max(0, state.intervalMs - (drift > 0 ? drift : 0));

  state.timerId = setTimeout(() => {
    if (state.registry.get(state.id) !== state) return;

    if (state.paused) {
      schedule(state);
      return;
    }

    const now = Date.now();
    const scope = childContext(state.context, {
      count: ++state.count,
      dt: now - state.lastTime,
      elapsed: now - state.startTime - state.pausedTotal,
      lastRun: now,
    });
    state.lastTime = now;

    const run = runStepsDetached(state.steps, scope, state.def, `[interval] Error in "${state.id}":`);
    if (state.detach) {
      // Fire-and-forget: the next run is scheduled without waiting for this one.
      schedule(state);
      return;
    }
    run.finally(() => {
      if (state.registry.get(state.id) === state) schedule(state);
    });
  }, delay);
}
