/**
 * TimerNode — fixed-rate loops and scheduled recurring tasks.
 *
 * Tick: compensating setTimeout loop for drift-free high-frequency timing.
 * - { "tick": "start", "id": "game", "rate": 60, "do": [...] }
 * - { "tick": "stop", "id": "game" }
 * - { "tick": "pause", "id": "game" }
 * - { "tick": "resume", "id": "game" }
 * Context: tick.count, tick.dt, tick.elapsed
 *
 * Cron: setInterval for human-readable scheduled tasks.
 * - { "cron": "start", "id": "cleanup", "every": "5m", "do": [...] }
 * - { "cron": "stop", "id": "cleanup" }
 * - { "cron": "pause", "id": "cleanup" }
 * - { "cron": "resume", "id": "cleanup" }
 * Context: cron.runCount, cron.lastRun, cron.elapsed
 * Interval formats: "500ms", "30s", "5m", "1h", "1d"
 */

import { Node, Context, NodeValue } from "./Node.js";
import { resolve, resolveAll, runSteps, runStepsDetached } from "../Resolver.js";
import type { JexsNodeSchema, JexsMethodSchema } from "../schema.js";

// Lifecycle ops shared by `tick` and `cron`. `start` differs per timer kind (its
// extra inputs), so each method supplies its own; stop/pause/resume are identical
// and take only `id` (the common sibling), inheriting the method's `output: "null"`.
const LIFECYCLE_OPS: Record<string, JexsMethodSchema> = {
  stop:   { markdownDescription: "Stops the timer and clears its state." },
  pause:  { markdownDescription: "Pauses the timer; its state is kept so `resume` continues where it left off." },
  resume: { markdownDescription: "Resumes a paused timer." },
};
// ─── Shared state ───────────────────────────────────────────────────────────

interface TimerState {
  id: string;
  intervalMs: number;
  steps: unknown[];
  context: Context;
  /** The originating step, so a deferred failure can honor its `catch`. */
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
    tick: {
      type: "string",
      enum: [
        "start",
        "stop",
        "pause",
        "resume",
      ],
      output: "null",
      markdownDescription: "Drift-compensating fixed-rate loop. Steps receive `tick.count`, `tick.dt`, `tick.elapsed` in context.",
      examples: [
        "{ \"tick\": \"start\", \"id\": \"game\", \"rate\": 60, \"detach\": true, \"do\": [{ \"var\": \"tick.dt\" }] }",
      ],
      siblings: {
        id: {
          type: "string",
          description: "Unique timer identifier.",
        },
      },
      variants: {
        start: {
          output: "string",
          markdownDescription: "Begins the loop, returning the timer `id`. The `do` steps run in the background, so their values are not returned here.",
          siblings: {
            rate: {
              type: "number",
              description: "Tick rate in Hz (default `60`).",
            },
            detach: {
              type: "boolean",
              description: "Run `do` steps fire-and-forget each tick without waiting for completion.",
            },
            do: {
              steps: true,
              required: true,
              description: "Steps to execute on each tick. An array runs as a sequence; a single expression is run on its own.",
            },
          },
        },
        ...LIFECYCLE_OPS,
      },
    },
    cron: {
      type: "string",
      enum: [
        "start",
        "stop",
        "pause",
        "resume",
      ],
      output: "null",
      markdownDescription: "Interval-based scheduled task. Steps receive `cron.runCount`, `cron.lastRun`, `cron.elapsed` in context.\r\nInterval formats: `\"500ms\"`, `\"30s\"`, `\"5m\"`, `\"1h\"`, `\"1d\"`.",
      examples: [
        "{ \"cron\": \"start\", \"id\": \"poll\", \"every\": \"30s\", \"do\": [{ \"fetch\": \"/api/status\" }] }",
      ],
      siblings: {
        id: {
          type: "string",
          description: "Unique timer identifier.",
        },
      },
      variants: {
        start: {
          output: "string",
          markdownDescription: "Begins the scheduled task, returning the timer `id`. The `do` steps run in the background, so their values are not returned here.",
          siblings: {
            every: {
              type: "string",
              description: "Interval string (e.g. `\"5m\"`, `\"30s\"`).",
            },
            do: {
              steps: true,
              required: true,
              description: "Steps to execute on each interval. An array runs as a sequence; a single expression is run on its own.",
            },
          },
        },
        ...LIFECYCLE_OPS,
      },
    },
  };

  readonly ticks = new Map<string, TimerState>();
  readonly crons = new Map<string, TimerState>();

  tick(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.tick, context, op => dispatch(this, String(op), def, context, "tick"));
  }

  cron(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.cron, context, op => dispatch(this, String(op), def, context, "cron"));
  }

  /** Timers outlive their resolver unless stopped, so tear them down with it. */
  dispose(): void {
    stopAll(this);
  }
}

/** Stop and forget every timer this node owns. */
function stopAll(self: TimerNode): void {
  for (const s of self.ticks.values()) { if (s.timerId != null) clearTimeout(s.timerId); }
  for (const s of self.crons.values()) { if (s.timerId != null) clearInterval(s.timerId); }
  self.ticks.clear();
  self.crons.clear();
}


// ─── Dispatch ───────────────────────────────────────────────────────────────

function dispatch(
  self: TimerNode, op: string, def: Record<string, unknown>, context: Context, kind: "tick" | "cron",
): unknown {
  const registry = kind === "tick" ? self.ticks : self.crons;

  switch (op) {
    case "start": return kind === "tick"
      ? startTick(def, context, registry)
      : startCron(def, context, registry);
    case "stop":  return stop(def, context, registry, kind);
    case "pause": return pause(def, context, registry);
    case "resume": return resume(def, context, registry, kind);
    default:
      console.error(`[${kind}] Unknown operation: ${op}`);
      return null;
  }
}

// ─── Shared stop / pause / resume ───────────────────────────────────────────

function stop(
  def: Record<string, unknown>, context: Context,
  registry: Map<string, TimerState>, kind: "tick" | "cron",
): unknown {
  return resolve(def.id, context, id => {
    const state = registry.get(String(id));
    if (!state) return null;
    if (state.timerId != null) {
      kind === "tick" ? clearTimeout(state.timerId) : clearInterval(state.timerId);
    }
    registry.delete(String(id));
    return null;
  });
}

function pause(
  def: Record<string, unknown>, context: Context,
  registry: Map<string, TimerState>,
): unknown {
  return resolve(def.id, context, id => {
    const state = registry.get(String(id));
    if (!state || state.paused) return null;
    state.paused = true;
    state.pausedAt = Date.now();
    return null;
  });
}

function resume(
  def: Record<string, unknown>, context: Context,
  registry: Map<string, TimerState>, kind: "tick" | "cron",
): unknown {
  return resolve(def.id, context, id => {
    const state = registry.get(String(id));
    if (!state || !state.paused) return null;
    if (state.pausedAt != null) state.pausedTotal += Date.now() - state.pausedAt;
    state.paused = false;
    state.pausedAt = null;
    if (kind === "tick") state.lastTime = Date.now();
    return null;
  });
}

// ─── Tick: compensating setTimeout loop ─────────────────────────────────────

function startTick(
  def: Record<string, unknown>, context: Context, registry: Map<string, TimerState>,
): unknown {
  return resolveAll([def.id, def.rate ?? 60, def.detach ?? false], context, ([idRaw, rateRaw, detachRaw]: unknown[]) => {
    const id = String(idRaw);
    const rate = Number(rateRaw);
    // No steps means a timer that ticks forever doing nothing, which looks like a
    // hung app rather than a mistake, so it is an error rather than a no-op. A
    // lone expression is normalized here because TimerState.steps is an array;
    // runSteps would take it either way.
    if (def.do === undefined) throw new Error("timer needs `do` steps");
    const steps = Array.isArray(def.do) ? def.do : [def.do];
    const detach = detachRaw === true || detachRaw === 1 || detachRaw === "1" || detachRaw === "true";

    const prev = registry.get(id);
    if (prev?.timerId != null) clearTimeout(prev.timerId);

    const now = Date.now();
    const state: TimerState = {
      id, intervalMs: 1000 / rate, steps, context, def, detach,
      timerId: null, count: 0, startTime: now, lastTime: now,
      paused: false, pausedAt: null, pausedTotal: 0, registry,
    };

    registry.set(id, state);
    scheduleTick(state);
    return id;
  });
}

function scheduleTick(state: TimerState): void {
  const now = Date.now();
  const drift = now - state.lastTime - state.intervalMs;
  const delay = Math.max(0, state.intervalMs - (drift > 0 ? drift : 0));

  state.timerId = setTimeout(() => {
    if (!state.registry.has(state.id)) return;

    if (state.paused) {
      scheduleTick(state);
      return;
    }

    const now = Date.now();
    const dt = (now - state.lastTime) / 1000;
    state.lastTime = now;
    state.count++;

    state.context.tick = {
      count: state.count,
      dt,
      elapsed: (now - state.startTime - state.pausedTotal) / 1000,
    };

    if (state.detach) {
      // Fire-and-forget: reschedule immediately without waiting for the steps.
      void runStepsDetached(state.steps, state.context, state.def)
        .catch(err => {
          console.error(`[tick] Error in "${state.id}":`, err);
        });

      if (state.registry.has(state.id)) scheduleTick(state);
      return;
    }

    runStepsDetached(state.steps, state.context, state.def)
      .catch(err => {
        console.error(`[tick] Error in "${state.id}":`, err);
      })
      .finally(() => {
        if (state.registry.has(state.id)) scheduleTick(state);
      });
  }, delay);
}

// ─── Cron: setInterval with human-readable intervals ────────────────────────

const MULTIPLIERS: Record<string, number> = {
  ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000,
};

/** Parse a human-readable interval like "5m", "1h", "30s" to milliseconds. */
export function parseInterval(value: string): number {
  const match = value.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/);
  if (!match) throw new Error(`Invalid interval: "${value}"`);
  return Math.round(parseFloat(match[1]) * MULTIPLIERS[match[2]]);
}

function startCron(
  def: Record<string, unknown>, context: Context, registry: Map<string, TimerState>,
): unknown {
  return resolveAll([def.id, def.every], context, ([id, every]: unknown[]) => {
    const intervalMs = parseInterval(String(every));
    // No steps means a timer that ticks forever doing nothing, which looks like a
    // hung app rather than a mistake, so it is an error rather than a no-op. A
    // lone expression is normalized here because TimerState.steps is an array;
    // runSteps would take it either way.
    if (def.do === undefined) throw new Error("timer needs `do` steps");
    const steps = Array.isArray(def.do) ? def.do : [def.do];

    const prev = registry.get(String(id));
    if (prev?.timerId != null) clearInterval(prev.timerId);

    const now = Date.now();
    const state: TimerState = {
      id: String(id), intervalMs, steps, context, def, detach: false,
      timerId: null, count: 0, startTime: now, lastTime: now,
      paused: false, pausedAt: null, pausedTotal: 0, registry,
    };

    state.timerId = setInterval(async () => {
      if (!state.registry.has(state.id) || state.paused) return;

      const now = Date.now();
      state.count++;
      state.lastTime = now;

      state.context.cron = {
        runCount: state.count,
        lastRun: new Date(now).toISOString(),
        elapsed: (now - state.startTime - state.pausedTotal) / 1000,
      };

      try {
        await runSteps(state.steps, state.context);
      } catch (err) {
        console.error(`[cron] Error in "${state.id}":`, err);
      }
    }, intervalMs);

    registry.set(state.id, state);
    return state.id;
  });
}
