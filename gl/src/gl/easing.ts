/**
 * Easing functions and tweenable field mappings.
 * Extracted from GlNode.ts for modularity.
 */

import {
  F_TX, F_TY, F_TZ,
  F_SX, F_SY, F_SZ,
  F_QX, F_QY, F_QZ, F_QW,
  F_VX, F_VY, F_OPACITY,
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
  tx: F_TX, ty: F_TY, tz: F_TZ,
  sx: F_SX, sy: F_SY, sz: F_SZ,
  qx: F_QX, qy: F_QY, qz: F_QZ, qw: F_QW,
  vx: F_VX, vy: F_VY, opacity: F_OPACITY,
};
