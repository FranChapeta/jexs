/**
 * Collision detection and resolution.
 *
 * Pure functions operating on EntityStore Float64Array data.
 * Supports: rect-vs-rect (AABB + OBB/SAT), circle-vs-circle,
 * circle-vs-rect, ramp-vs-rect. 3D Z-overlap tests included.
 */

import {
  EntityStore,
  STRIDE,
  F_X, F_Y, F_W, F_H, F_Z, F_D,
  F_VX, F_VY, F_VZ,
  F_INV_MASS, F_RESTITUTION, F_FRICTION,
  F_FLAGS, F_RX, F_RY, F_ANGLE,
  FLAG_TRIGGER, FLAG_SLEEPING,
} from "./EntityStore.js";
import type { Contact, PhysicsConfig } from "./Physics.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function shapeOf(meta: { type: string }): "circle" | "rect" {
  return meta.type === "circle" ? "circle" : "rect";
}

const DEG2RAD = Math.PI / 180;

/** Check if entity has any rotation. */
export function isRotated(d: Float64Array, base: number): boolean {
  return d[base + F_RX] !== 0 || d[base + F_RY] !== 0 || d[base + F_ANGLE] !== 0;
}

/**
 * Compute 3x3 rotation matrix from Euler angles (degrees).
 * Order: R = Rz * Rx * Ry (ZXY) -- matches GlNode mat4Model.
 */
function rotMatrix(rxDeg: number, ryDeg: number, rzDeg: number, out: Float32Array): void {
  const cx = Math.cos(rxDeg * DEG2RAD), sx = Math.sin(rxDeg * DEG2RAD);
  const cy = Math.cos(ryDeg * DEG2RAD), sy = Math.sin(ryDeg * DEG2RAD);
  const cz = Math.cos(rzDeg * DEG2RAD), sz = Math.sin(rzDeg * DEG2RAD);
  out[0] = cz*cy + sz*sx*sy;   out[1] = sz*cx;   out[2] = -cz*sy + sz*sx*cy;
  out[3] = -sz*cy + cz*sx*sy;  out[4] = cz*cx;   out[5] = sz*sy + cz*sx*cy;
  out[6] = cx*sy;               out[7] = -sx;     out[8] = cx*cy;
}

const _rotIdentity = new Float32Array([1,0,0, 0,1,0, 0,0,1]);

// ─── Detection primitives ───────────────────────────────────────────────────

/** Check Z-axis overlap. Returns overlap amount, or 0 if both have zero depth (2D mode). */
function zOverlap(d: Float64Array, ba: number, bb: number): number {
  const az = d[ba + F_Z], ad = d[ba + F_D];
  const bz = d[bb + F_Z], bd = d[bb + F_D];
  if (ad === 0 && bd === 0) return 0;
  const adEff = ad || 0.01, bdEff = bd || 0.01;
  const oz = Math.min(az + adEff, bz + bdEff) - Math.max(az, bz);
  return oz > 0 ? oz : -1;
}

function rectVsRect(d: Float64Array, slotA: number, slotB: number): Contact | null {
  const ba = slotA * STRIDE, bb = slotB * STRIDE;
  const ax = d[ba+F_X], ay = d[ba+F_Y], aw = d[ba+F_W], ah = d[ba+F_H];
  const bx = d[bb+F_X], by = d[bb+F_Y], bw = d[bb+F_W], bh = d[bb+F_H];

  const overlapX = Math.min(ax+aw, bx+bw) - Math.max(ax, bx);
  const overlapY = Math.min(ay+ah, by+bh) - Math.max(ay, by);
  if (overlapX <= 0 || overlapY <= 0) return null;

  const oz = zOverlap(d, ba, bb);
  if (oz < 0) return null;

  const acx = ax + aw/2, acy = ay + ah/2;
  const bcx = bx + bw/2, bcy = by + bh/2;

  if (oz > 0 && oz < overlapX && oz < overlapY) {
    const acz = d[ba+F_Z] + (d[ba+F_D] || 0.01) / 2;
    const bcz = d[bb+F_Z] + (d[bb+F_D] || 0.01) / 2;
    return { slotA, slotB, nx: 0, ny: 0, nz: acz < bcz ? 1 : -1, depth: oz, trigger: false };
  }
  if (overlapX < overlapY) {
    return { slotA, slotB, nx: acx < bcx ? 1 : -1, ny: 0, nz: 0, depth: overlapX, trigger: false };
  }
  return { slotA, slotB, nx: 0, ny: acy < bcy ? 1 : -1, nz: 0, depth: overlapY, trigger: false };
}

function circleVsCircle(d: Float64Array, slotA: number, slotB: number): Contact | null {
  const ba = slotA * STRIDE, bb = slotB * STRIDE;

  const oz = zOverlap(d, ba, bb);
  if (oz < 0) return null;

  const acx = d[ba+F_X]+d[ba+F_W]/2, acy = d[ba+F_Y]+d[ba+F_H]/2;
  const bcx = d[bb+F_X]+d[bb+F_W]/2, bcy = d[bb+F_Y]+d[bb+F_H]/2;
  const ar = Math.min(d[ba+F_W], d[ba+F_H])/2;
  const br = Math.min(d[bb+F_W], d[bb+F_H])/2;

  const dx = bcx-acx, dy = bcy-acy;
  let dz = 0;
  const ad = d[ba+F_D], bd = d[bb+F_D];
  if (ad > 0 || bd > 0) {
    const acz = d[ba+F_Z] + (ad || 0.01) / 2;
    const bcz = d[bb+F_Z] + (bd || 0.01) / 2;
    dz = bcz - acz;
  }
  const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
  const sumR = ar+br;
  if (dist >= sumR) return null;
  if (dist === 0) return { slotA, slotB, nx: 0, ny: -1, nz: 0, depth: sumR, trigger: false };
  return { slotA, slotB, nx: dx/dist, ny: dy/dist, nz: dz/dist, depth: sumR-dist, trigger: false };
}

function circleVsRect(
  d: Float64Array, circleSlot: number, rectSlot: number, swapped: boolean,
): Contact | null {
  const bc = circleSlot * STRIDE, br = rectSlot * STRIDE;

  const oz = zOverlap(d, bc, br);
  if (oz < 0) return null;

  const cx = d[bc+F_X]+d[bc+F_W]/2, cy = d[bc+F_Y]+d[bc+F_H]/2;
  const r = Math.min(d[bc+F_W], d[bc+F_H])/2;

  const rx = d[br+F_X], ry = d[br+F_Y], rw = d[br+F_W], rh = d[br+F_H];
  const closestX = Math.max(rx, Math.min(cx, rx+rw));
  const closestY = Math.max(ry, Math.min(cy, ry+rh));

  const dx = cx-closestX, dy = cy-closestY;
  const dist = Math.sqrt(dx*dx + dy*dy);
  if (dist >= r) return null;

  let nx: number, ny: number;
  if (dist === 0) {
    const left = cx-rx, right = rx+rw-cx;
    const top = cy-ry, bottom = ry+rh-cy;
    const m = Math.min(left, right, top, bottom);
    if (m === left)       { nx =  1; ny =  0; }
    else if (m === right) { nx = -1; ny =  0; }
    else if (m === top)   { nx =  0; ny =  1; }
    else                  { nx =  0; ny = -1; }
  } else {
    nx = (closestX-cx)/dist;
    ny = (closestY-cy)/dist;
  }

  if (swapped) return { slotA: rectSlot, slotB: circleSlot, nx: -nx, ny: -ny, nz: 0, depth: r-dist, trigger: false };
  return { slotA: circleSlot, slotB: rectSlot, nx, ny, nz: 0, depth: r-dist, trigger: false };
}

function rampVsRect(d: Float64Array, slotR: number, slotE: number, swapped: boolean): Contact | null {
  const br = slotR * STRIDE, be = slotE * STRIDE;
  const rpx = d[br+F_X], rpy = d[br+F_Y], rpw = d[br+F_W], rph = d[br+F_H], rpd = d[br+F_D] || 0.01;
  const ex = d[be+F_X], ey = d[be+F_Y], ew = d[be+F_W], eh = d[be+F_H];
  const ez = d[be+F_Z];

  const overlapX = Math.min(rpx+rpw, ex+ew) - Math.max(rpx, ex);
  if (overlapX <= 0) return null;
  const overlapY = Math.min(rpy+rph, ey+eh) - Math.max(rpy, ey);
  if (overlapY <= 0) return null;

  const entityCenterY = ey + eh / 2;
  let t = (entityCenterY - rpy) / rph;
  t = Math.max(0, Math.min(1, t));
  const rampZ = d[br+F_Z];
  const slopeHeight = rampZ + rpd * (1 - t);

  const penetration = slopeHeight - ez;
  if (penetration <= 0) return null;
  if (ez > rampZ + rpd) return null;

  const sign = swapped ? 1 : -1;
  let nx = 0, ny = 0, nz = 0, depth: number;

  if (overlapX <= overlapY && overlapX <= penetration) {
    const rCx = rpx + rpw / 2, eCx = ex + ew / 2;
    nx = (eCx > rCx ? 1 : -1) * sign;
    depth = overlapX;
  } else if (overlapY <= overlapX && overlapY <= penetration) {
    const rCy = rpy + rph / 2, eCy = ey + eh / 2;
    ny = (eCy > rCy ? 1 : -1) * sign;
    depth = overlapY;
  } else {
    nz = sign;
    depth = penetration;
  }

  return {
    slotA: swapped ? slotR : slotE,
    slotB: swapped ? slotE : slotR,
    nx, ny, nz, depth, trigger: false,
  };
}

// ─── OBB-vs-OBB (SAT, 15 axes) ─────────────────────────────────────────────

function obbVsObb(d: Float64Array, slotA: number, slotB: number): Contact | null {
  const ba = slotA * STRIDE, bb = slotB * STRIDE;

  const aEx = d[ba+F_W]/2, aEy = d[ba+F_H]/2, aEz = (d[ba+F_D] || 0.01) / 2;
  const bEx = d[bb+F_W]/2, bEy = d[bb+F_H]/2, bEz = (d[bb+F_D] || 0.01) / 2;

  const aCx = d[ba+F_X] + aEx, aCy = d[ba+F_Y] + aEy, aCz = d[ba+F_Z] + aEz;
  const bCx = d[bb+F_X] + bEx, bCy = d[bb+F_Y] + bEy, bCz = d[bb+F_Z] + bEz;

  const rotABuf = isRotated(d, ba) ? new Float32Array(9) : null;
  const rotBBuf = isRotated(d, bb) ? new Float32Array(9) : null;
  const rotARef = rotABuf
    ? (rotMatrix(d[ba+F_RX], d[ba+F_RY], d[ba+F_ANGLE], rotABuf), rotABuf)
    : _rotIdentity;
  const rotBRef = rotBBuf
    ? (rotMatrix(d[bb+F_RX], d[bb+F_RY], d[bb+F_ANGLE], rotBBuf), rotBBuf)
    : _rotIdentity;

  const a0x = rotARef[0], a0y = rotARef[1], a0z = rotARef[2];
  const a1x = rotARef[3], a1y = rotARef[4], a1z = rotARef[5];
  const a2x = rotARef[6], a2y = rotARef[7], a2z = rotARef[8];

  const b0x = rotBRef[0], b0y = rotBRef[1], b0z = rotBRef[2];
  const b1x = rotBRef[3], b1y = rotBRef[4], b1z = rotBRef[5];
  const b2x = rotBRef[6], b2y = rotBRef[7], b2z = rotBRef[8];

  const tx = bCx - aCx, ty = bCy - aCy, tz = bCz - aCz;

  let minOverlap = Infinity;
  let bestNx = 0, bestNy = 0, bestNz = 0;

  const testAxis = (axX: number, axY: number, axZ: number): boolean => {
    const len = Math.sqrt(axX*axX + axY*axY + axZ*axZ);
    if (len < 1e-6) return true;
    const nx = axX/len, ny = axY/len, nz = axZ/len;

    const dist = tx*nx + ty*ny + tz*nz;
    const absDist = Math.abs(dist);

    const rA = aEx * Math.abs(a0x*nx + a0y*ny + a0z*nz)
             + aEy * Math.abs(a1x*nx + a1y*ny + a1z*nz)
             + aEz * Math.abs(a2x*nx + a2y*ny + a2z*nz);

    const rB = bEx * Math.abs(b0x*nx + b0y*ny + b0z*nz)
             + bEy * Math.abs(b1x*nx + b1y*ny + b1z*nz)
             + bEz * Math.abs(b2x*nx + b2y*ny + b2z*nz);

    const overlap = rA + rB - absDist;
    if (overlap <= 0) return false;

    if (overlap < minOverlap) {
      minOverlap = overlap;
      const sign = dist >= 0 ? 1 : -1;
      bestNx = nx * sign;
      bestNy = ny * sign;
      bestNz = nz * sign;
    }
    return true;
  };

  if (!testAxis(a0x, a0y, a0z)) return null;
  if (!testAxis(a1x, a1y, a1z)) return null;
  if (!testAxis(a2x, a2y, a2z)) return null;
  if (!testAxis(b0x, b0y, b0z)) return null;
  if (!testAxis(b1x, b1y, b1z)) return null;
  if (!testAxis(b2x, b2y, b2z)) return null;
  if (!testAxis(a0y*b0z-a0z*b0y, a0z*b0x-a0x*b0z, a0x*b0y-a0y*b0x)) return null;
  if (!testAxis(a0y*b1z-a0z*b1y, a0z*b1x-a0x*b1z, a0x*b1y-a0y*b1x)) return null;
  if (!testAxis(a0y*b2z-a0z*b2y, a0z*b2x-a0x*b2z, a0x*b2y-a0y*b2x)) return null;
  if (!testAxis(a1y*b0z-a1z*b0y, a1z*b0x-a1x*b0z, a1x*b0y-a1y*b0x)) return null;
  if (!testAxis(a1y*b1z-a1z*b1y, a1z*b1x-a1x*b1z, a1x*b1y-a1y*b1x)) return null;
  if (!testAxis(a1y*b2z-a1z*b2y, a1z*b2x-a1x*b2z, a1x*b2y-a1y*b2x)) return null;
  if (!testAxis(a2y*b0z-a2z*b0y, a2z*b0x-a2x*b0z, a2x*b0y-a2y*b0x)) return null;
  if (!testAxis(a2y*b1z-a2z*b1y, a2z*b1x-a2x*b1z, a2x*b1y-a2y*b1x)) return null;
  if (!testAxis(a2y*b2z-a2z*b2y, a2z*b2x-a2x*b2z, a2x*b2y-a2y*b2x)) return null;

  return { slotA, slotB, nx: bestNx, ny: bestNy, nz: bestNz, depth: minOverlap, trigger: false };
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function detectCollision(
  d: Float64Array, slotA: number, slotB: number,
  metaA: { type: string }, metaB: { type: string },
): Contact | null {
  const ta = metaA.type, tb = metaB.type;
  let c: Contact | null;
  if (ta === "ramp" && tb !== "ramp") c = rampVsRect(d, slotA, slotB, true);
  else if (tb === "ramp" && ta !== "ramp") c = rampVsRect(d, slotB, slotA, false);
  else {
    const sa = shapeOf(metaA), sb = shapeOf(metaB);
    if (sa === "rect" && sb === "rect") {
      const ba = slotA * STRIDE, bb = slotB * STRIDE;
      c = (isRotated(d, ba) || isRotated(d, bb)) ? obbVsObb(d, slotA, slotB) : rectVsRect(d, slotA, slotB);
    }
    else if (sa === "circle" && sb === "circle") c = circleVsCircle(d, slotA, slotB);
    else if (sa === "circle" && sb === "rect")   c = circleVsRect(d, slotA, slotB, false);
    else if (sa === "rect"   && sb === "circle") c = circleVsRect(d, slotB, slotA, true);
    else return null;
  }
  if (c) {
    c.trigger = !!(d[slotA * STRIDE + F_FLAGS] & FLAG_TRIGGER) || !!(d[slotB * STRIDE + F_FLAGS] & FLAG_TRIGGER);
  }
  return c;
}

export function resolveCollision(store: EntityStore, { slotA, slotB, nx, ny, nz, depth }: Contact, config?: PhysicsConfig): void {
  const d = store.data;
  const ba = slotA * STRIDE, bb = slotB * STRIDE;
  const invA = d[ba+F_INV_MASS], invB = d[bb+F_INV_MASS];
  const totalInv = invA + invB;
  if (totalInv === 0) return;

  if (invA > 0) wakeBody(store, slotA);
  if (invB > 0) wakeBody(store, slotB);

  const corr = depth / totalInv;
  d[ba+F_X] -= corr*nx*invA;  d[ba+F_Y] -= corr*ny*invA;  d[ba+F_Z] -= corr*nz*invA;
  d[bb+F_X] += corr*nx*invB;  d[bb+F_Y] += corr*ny*invB;  d[bb+F_Z] += corr*nz*invB;

  if ((invA === 0 || invB === 0) && config) {
    const gx = config.gravity[0], gy = config.gravity[1], gz = config.gravity[2] ?? 0;
    const gLen = Math.sqrt(gx*gx + gy*gy + gz*gz);
    if (gLen > 0) {
      const gravN = gx * nx + gy * ny + gz * nz;
      const alignment = Math.abs(gravN) / gLen;
      if (alignment > 0.5) {
        if (invA > 0) {
          const vn = d[ba+F_VX]*nx + d[ba+F_VY]*ny + d[ba+F_VZ]*nz;
          if (Math.abs(vn) < 2.0) {
            d[ba+F_VX] -= vn * nx;
            d[ba+F_VY] -= vn * ny;
            d[ba+F_VZ] -= vn * nz;
            return;
          }
        }
        if (invB > 0) {
          const vn = d[bb+F_VX]*(-nx) + d[bb+F_VY]*(-ny) + d[bb+F_VZ]*(-nz);
          if (Math.abs(vn) < 2.0) {
            d[bb+F_VX] -= vn * (-nx);
            d[bb+F_VY] -= vn * (-ny);
            d[bb+F_VZ] -= vn * (-nz);
            return;
          }
        }
      }
    }
  }

  const dvx = d[bb+F_VX]-d[ba+F_VX], dvy = d[bb+F_VY]-d[ba+F_VY], dvz = d[bb+F_VZ]-d[ba+F_VZ];
  const relN = dvx*nx + dvy*ny + dvz*nz;
  if (relN > 0) return;

  const e = Math.min(d[ba+F_RESTITUTION], d[bb+F_RESTITUTION]);
  const j = -(1+e) * relN / totalInv;
  d[ba+F_VX] -= j*nx*invA;  d[ba+F_VY] -= j*ny*invA;  d[ba+F_VZ] -= j*nz*invA;
  d[bb+F_VX] += j*nx*invB;  d[bb+F_VY] += j*ny*invB;  d[bb+F_VZ] += j*nz*invB;

  const tvx = dvx - relN*nx, tvy = dvy - relN*ny, tvz = dvz - relN*nz;
  const tLen = Math.sqrt(tvx*tvx + tvy*tvy + tvz*tvz);
  if (tLen > 0.001) {
    const tx = tvx/tLen, ty = tvy/tLen, tz = tvz/tLen;
    const mu = Math.sqrt(d[ba+F_FRICTION] * d[bb+F_FRICTION]);
    const jt = Math.max(-j*mu, Math.min(j*mu, -(tvx*tx + tvy*ty + tvz*tz) / totalInv));
    d[ba+F_VX] -= jt*tx*invA;  d[ba+F_VY] -= jt*ty*invA;  d[ba+F_VZ] -= jt*tz*invA;
    d[bb+F_VX] += jt*tx*invB;  d[bb+F_VY] += jt*ty*invB;  d[bb+F_VZ] += jt*tz*invB;
  }
}

/** Sleep motion threshold — bodies with motion below this are considered at rest. */
const SLEEP_MOTION_THRESHOLD = 0.25;

/** Wake a sleeping body (clear sleep flag + counters). */
export function wakeBody(store: EntityStore, slot: number): void {
  const b = slot * STRIDE;
  if (store.data[b + F_FLAGS] & FLAG_SLEEPING) {
    store.data[b + F_FLAGS] &= ~FLAG_SLEEPING;
    store.motion[slot] = SLEEP_MOTION_THRESHOLD * 2; // above threshold so it doesn't immediately re-sleep
    store.sleepFrames[slot] = 0;
  }
}
