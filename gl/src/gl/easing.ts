/**
 * Easing functions and tweenable field mappings.
 * Extracted from GlNode.ts for modularity.
 */

import {
  F_X, F_Y, F_W, F_H, F_ANGLE,
  F_VX, F_VY, F_OPACITY,
  F_Z, F_D, F_RX, F_RY,
} from "@jexs/physics";

// ─── Easing functions ────────────────────────────────────────────────────────

export const EASINGS: Record<string, (t: number) => number> = {
  linear: t => t,
  easeInQuad: t => t * t,
  easeOutQuad: t => t * (2 - t),
  easeInOutQuad: t => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
  easeInCubic: t => t * t * t,
  easeOutCubic: t => (--t) * t * t + 1,
  easeInOutCubic: t => t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1,
  easeInBack: t => t * t * (2.70158 * t - 1.70158),
  easeOutBack: t => { const s = 1.70158; return (t -= 1) * t * ((s + 1) * t + s) + 1; },
  easeOutBounce: t => {
    if (t < 1 / 2.75) return 7.5625 * t * t;
    if (t < 2 / 2.75) return 7.5625 * (t -= 1.5 / 2.75) * t + 0.75;
    if (t < 2.5 / 2.75) return 7.5625 * (t -= 2.25 / 2.75) * t + 0.9375;
    return 7.5625 * (t -= 2.625 / 2.75) * t + 0.984375;
  },
};

export const TWEENABLE_KEYS: Record<string, number> = {
  x: F_X, y: F_Y, w: F_W, h: F_H, angle: F_ANGLE,
  vx: F_VX, vy: F_VY, opacity: F_OPACITY,
  z: F_Z, d: F_D, rx: F_RX, ry: F_RY,
};
