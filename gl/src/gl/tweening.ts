/**
 * Tween system for animating entity properties over time.
 * Extracted from GlNode.ts for modularity.
 */

import { STRIDE, F_CR, F_CG, F_CB, F_CA } from "@jexs/physics";
import type { GlInstance, GlTween } from "./types.js";
import { EASINGS, TWEENABLE_KEYS } from "./easing.js";
import type { Context } from "@jexs/core";

/** Completed tween callback info, returned for the caller to execute. */
export interface TweenCallback {
  then: unknown[];
  context: Context;
}

/**
 * Tick all active tweens. Returns completed `then` callbacks for the caller to dispatch.
 * Marks inst.dirty = true if any tweens were active.
 */
export function tickTweens(inst: GlInstance, dt: number): TweenCallback[] | null {
  if (inst.tweens.length === 0) return null;
  const d = inst.store.data;
  let callbacks: TweenCallback[] | null = null;

  for (let i = inst.tweens.length - 1; i >= 0; i--) {
    const tw = inst.tweens[i];
    tw.elapsed += dt;
    const done = tw.elapsed >= tw.duration;
    const t = done ? 1 : tw.easing(tw.elapsed / tw.duration);
    const b = tw.slot * STRIDE;
    for (let j = 0; j < tw.fields.length; j++) {
      d[b + tw.fields[j]] = tw.starts[j] + (tw.ends[j] - tw.starts[j]) * t;
    }
    if (done) {
      inst.tweens[i] = inst.tweens[inst.tweens.length - 1]; inst.tweens.pop();
      if (tw.then && tw.context) {
        if (!callbacks) callbacks = [];
        callbacks.push({ then: tw.then, context: tw.context });
      }
    }
  }
  inst.dirty = true;
  return callbacks;
}

/**
 * Build tween field arrays from a definition object.
 * Returns null if no tweenable fields were found.
 */
export function buildTweenFields(
  d: Float64Array, b: number,
  def: Record<string, unknown>,
  resolvedValues: Map<string, number>,
  resolvedColor: number[] | null,
): { fields: number[]; starts: number[]; ends: number[] } | null {
  const fields: number[] = [];
  const starts: number[] = [];
  const ends: number[] = [];

  for (const [key, offset] of Object.entries(TWEENABLE_KEYS)) {
    if (resolvedValues.has(key)) {
      fields.push(offset);
      starts.push(d[b + offset]);
      ends.push(resolvedValues.get(key)!);
    }
  }

  if (resolvedColor) {
    const colorFields = [F_CR, F_CG, F_CB, F_CA];
    for (let i = 0; i < 4; i++) {
      fields.push(colorFields[i]);
      starts.push(d[b + colorFields[i]]);
      ends.push(resolvedColor[i]);
    }
  }

  return fields.length > 0 ? { fields, starts, ends } : null;
}

/**
 * Cancel existing tweens on the same fields for an entity (conflict resolution).
 */
export function cancelConflictingTweens(tweens: GlTween[], slot: number, fields: number[]): void {
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    if (tw.slot !== slot) continue;
    const keptF: number[] = [], keptS: number[] = [], keptE: number[] = [];
    for (let j = 0; j < tw.fields.length; j++) {
      if (!fields.includes(tw.fields[j])) {
        keptF.push(tw.fields[j]);
        keptS.push(tw.starts[j]);
        keptE.push(tw.ends[j]);
      }
    }
    if (keptF.length === 0) { tweens[i] = tweens[tweens.length - 1]; tweens.pop(); continue; }
    tw.fields = keptF; tw.starts = keptS; tw.ends = keptE;
  }
}
