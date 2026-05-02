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
import { resolve, resolveAll, onResolverDestroy, runSteps } from "../Resolver.js";
// ─── Shared state ───────────────────────────────────────────────────────────

interface TimerState {
  id: string;
  intervalMs: number;
  steps: unknown[];
  context: Context;
  detach: boolean;
  timerId: ReturnType<typeof setTimeout> | null;
  count: number;
  startTime: number;
  lastTime: number;
  paused: boolean;
  pausedAt: number | null;
  pausedTotal: number;
}

const ticks = new Map<string, TimerState>();
const crons = new Map<string, TimerState>();

// Auto-cleanup timers when the resolver is destroyed or replaced
onResolverDestroy(() => TimerNode.stopAll());

// ─── TimerNode ──────────────────────────────────────────────────────────────

export class TimerNode extends Node {
  /**
   * Drift-compensating fixed-rate loop. Steps receive `tick.count`, `tick.dt`, `tick.elapsed` in context.
   *
   * @param {"start"|"stop"|"pause"|"resume"} tick Operation to perform.
   * @param {string} id Unique timer identifier.
   * @param {number} rate Tick rate in Hz (default `60`). Used on `"start"`.
   * @param {boolean} detach Run `do` steps fire-and-forget each tick without waiting for completion.
   * @param {steps} do Steps to execute on each tick. Used on `"start"`.
   * @example
   * { "tick": "start", "id": "game", "rate": 60, "detach": true, "do": [{ "var": "tick.dt" }] }
   */
  tick(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.tick, context, op => dispatch(String(op), def, context, "tick"));
  }

  /**
   * Interval-based scheduled task. Steps receive `cron.runCount`, `cron.lastRun`, `cron.elapsed` in context.
   * Interval formats: `"500ms"`, `"30s"`, `"5m"`, `"1h"`, `"1d"`.
   *
   * @param {"start"|"stop"|"pause"|"resume"} cron Operation to perform.
   * @param {string} id Unique timer identifier.
   * @param {string} every Interval string (e.g. `"5m"`, `"30s"`). Used on `"start"`.
   * @param {steps} do Steps to execute on each interval. Used on `"start"`.
   * @example
   * { "cron": "start", "id": "poll", "every": "30s", "do": [{ "fetch": "/api/status" }] }
   */
  cron(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.cron, context, op => dispatch(String(op), def, context, "cron"));
  }

  static stopAll(): void {
    for (const s of ticks.values()) { if (s.timerId != null) clearTimeout(s.timerId); }
    for (const s of crons.values()) { if (s.timerId != null) clearInterval(s.timerId); }
    ticks.clear();
    crons.clear();
  }
}


// ─── Dispatch ───────────────────────────────────────────────────────────────

function dispatch(
  op: string, def: Record<string, unknown>, context: Context, kind: "tick" | "cron",
): unknown {
  const registry = kind === "tick" ? ticks : crons;

  switch (op) {
    case "start": return kind === "tick" ? startTick(def, context) : startCron(def, context);
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

function startTick(def: Record<string, unknown>, context: Context): unknown {
  return resolveAll([def.id, def.rate ?? 60, def.detach ?? false], context, ([idRaw, rateRaw, detachRaw]: unknown[]) => {
    const id = String(idRaw);
    const rate = Number(rateRaw);
    const steps = Array.isArray(def.do) ? def.do as unknown[] : [];
    const detach = detachRaw === true || detachRaw === 1 || detachRaw === "1" || detachRaw === "true";

    const prev = ticks.get(id);
    if (prev?.timerId != null) clearTimeout(prev.timerId);

    const now = Date.now();
    const state: TimerState = {
      id, intervalMs: 1000 / rate, steps, context, detach,
      timerId: null, count: 0, startTime: now, lastTime: now,
      paused: false, pausedAt: null, pausedTotal: 0,
    };

    ticks.set(id, state);
    scheduleTick(state);
    return id;
  });
}

function scheduleTick(state: TimerState): void {
  const now = Date.now();
  const drift = now - state.lastTime - state.intervalMs;
  const delay = Math.max(0, state.intervalMs - (drift > 0 ? drift : 0));

  state.timerId = setTimeout(() => {
    if (!ticks.has(state.id)) return;

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
      try {
        const result = runSteps(state.steps, state.context);
        if (result instanceof Promise) {
          result.catch(err => {
            console.error(`[tick] Error in "${state.id}":`, err);
          });
        }
      } catch (err) {
        console.error(`[tick] Error in "${state.id}":`, err);
      }

      if (ticks.has(state.id)) scheduleTick(state);
      return;
    }

    Promise.resolve(runSteps(state.steps, state.context))
      .catch(err => {
        console.error(`[tick] Error in "${state.id}":`, err);
      })
      .finally(() => {
        if (ticks.has(state.id)) scheduleTick(state);
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

function startCron(def: Record<string, unknown>, context: Context): unknown {
  return resolveAll([def.id, def.every], context, ([id, every]: unknown[]) => {
    const intervalMs = parseInterval(String(every));
    const steps = Array.isArray(def.do) ? def.do as unknown[] : [];

    const prev = crons.get(String(id));
    if (prev?.timerId != null) clearInterval(prev.timerId);

    const now = Date.now();
    const state: TimerState = {
      id: String(id), intervalMs, steps, context, detach: false,
      timerId: null, count: 0, startTime: now, lastTime: now,
      paused: false, pausedAt: null, pausedTotal: 0,
    };

    state.timerId = setInterval(async () => {
      if (!crons.has(state.id) || state.paused) return;

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

    crons.set(state.id, state);
    return state.id;
  });
}
