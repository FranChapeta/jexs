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
  F_TX, F_TY, F_TZ,
  F_SX, F_SY, F_SZ,
  F_QX, F_QY, F_QZ, F_QW,
  F_VX, F_VY, F_VZ,
  F_INV_MASS, F_RESTITUTION, F_FRICTION,
  F_FLAGS,
  FLAG_TRIGGER, FLAG_SLEEPING,
  type EntityMeta,
} from "./EntityStore.js";
import type { Contact, PhysicsConfig } from "./nodes/Physics.js";
import { buildBvh, queryAabb, readTriangle } from "./Bvh.js";
import type { MeshEntry } from "./Mesh.js";
import { rotateVecByQuat } from "./quat.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Numerical slack added to the adaptive back-side thickness, in world units.
 * Keeps a body that *just* touched the surface (within ~1mm at unit scale)
 * registered as in contact, even with zero velocity.
 */
const MESH_THICKNESS_SLACK = 0.01;

function shapeOf(meta: { type: string }): "circle" | "rect" {
  return meta.type === "circle" ? "circle" : "rect";
}

/**
 * True when this entity should collide as a triangle mesh. An entity must explicitly
 * declare `type: "mesh"` to opt in — `type: "quad" | "circle"` with a mesh id renders
 * the mesh but uses primitive (AABB / sphere) narrowphase, which is much cheaper.
 */
export function usesMeshCollision(meta: EntityMeta): boolean {
  return meta.type === "mesh" && !!meta.meshId;
}

const _rotIdentity = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
// Scratch rotation matrices reused by obbVsObb (single, non-reentrant call site)
// instead of allocating a Float32Array(9) per rotated pair per tick. Never write
// into _rotIdentity — these are the only writable rotation buffers.
const _rotBufA = new Float32Array(9);
const _rotBufB = new Float32Array(9);
export function isRotated(d: Float64Array, base: number): boolean {
  return d[base + F_QX] !== 0 || d[base + F_QY] !== 0 || d[base + F_QZ] !== 0;
}

/** Compute 3x3 rotation matrix from unit quaternion [qx,qy,qz,qw]. */
function rotMatrixQuat(qx: number, qy: number, qz: number, qw: number, out: Float32Array): void {
  const x2 = qx+qx, y2 = qy+qy, z2 = qz+qz;
  const xx = qx*x2, xy = qx*y2, xz = qx*z2;
  const yy = qy*y2, yz = qy*z2, zz = qz*z2;
  const wx = qw*x2, wy = qw*y2, wz = qw*z2;
  out[0] = 1-yy-zz; out[1] = xy+wz;   out[2] = xz-wy;
  out[3] = xy-wz;   out[4] = 1-xx-zz; out[5] = yz+wx;
  out[6] = xz+wy;   out[7] = yz-wx;   out[8] = 1-xx-yy;
}

// ─── Detection primitives ───────────────────────────────────────────────────

/** Check Z-axis overlap. Returns overlap amount, or 0 if both have zero depth (2D mode). */
function zOverlap(d: Float64Array, ba: number, bb: number): number {
  const az = d[ba + F_TZ], ad = d[ba + F_SZ];
  const bz = d[bb + F_TZ], bd = d[bb + F_SZ];
  if (ad === 0 && bd === 0) return 0;
  const adEff = ad || 0.01, bdEff = bd || 0.01;
  const oz = Math.min(az + adEff, bz + bdEff) - Math.max(az, bz);
  return oz > 0 ? oz : -1;
}

function rectVsRect(d: Float64Array, slotA: number, slotB: number): Contact | null {
  const ba = slotA * STRIDE, bb = slotB * STRIDE;
  const ax = d[ba+F_TX], ay = d[ba+F_TY], aw = d[ba+F_SX], ah = d[ba+F_SY];
  const bx = d[bb+F_TX], by = d[bb+F_TY], bw = d[bb+F_SX], bh = d[bb+F_SY];

  const overlapX = Math.min(ax+aw, bx+bw) - Math.max(ax, bx);
  const overlapY = Math.min(ay+ah, by+bh) - Math.max(ay, by);
  if (overlapX <= 0 || overlapY <= 0) return null;

  const oz = zOverlap(d, ba, bb);
  if (oz < 0) return null;

  const acx = ax + aw/2, acy = ay + ah/2;
  const bcx = bx + bw/2, bcy = by + bh/2;

  if (oz > 0 && oz < overlapX && oz < overlapY) {
    const acz = d[ba+F_TZ] + (d[ba+F_SZ] || 0.01) / 2;
    const bcz = d[bb+F_TZ] + (d[bb+F_SZ] || 0.01) / 2;
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

  const acx = d[ba+F_TX]+d[ba+F_SX]/2, acy = d[ba+F_TY]+d[ba+F_SY]/2;
  const bcx = d[bb+F_TX]+d[bb+F_SX]/2, bcy = d[bb+F_TY]+d[bb+F_SY]/2;
  const ar = Math.min(d[ba+F_SX], d[ba+F_SY])/2;
  const br = Math.min(d[bb+F_SX], d[bb+F_SY])/2;

  const dx = bcx-acx, dy = bcy-acy;
  let dz = 0;
  const ad = d[ba+F_SZ], bd = d[bb+F_SZ];
  if (ad > 0 || bd > 0) {
    const acz = d[ba+F_TZ] + (ad || 0.01) / 2;
    const bcz = d[bb+F_TZ] + (bd || 0.01) / 2;
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

  const cx = d[bc+F_TX]+d[bc+F_SX]/2, cy = d[bc+F_TY]+d[bc+F_SY]/2;
  const r = Math.min(d[bc+F_SX], d[bc+F_SY])/2;

  const rx = d[br+F_TX], ry = d[br+F_TY], rw = d[br+F_SX], rh = d[br+F_SY];
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
  const rpx = d[br+F_TX], rpy = d[br+F_TY], rpw = d[br+F_SX], rph = d[br+F_SY], rpd = d[br+F_SZ] || 0.01;
  const ex = d[be+F_TX], ey = d[be+F_TY], ew = d[be+F_SX], eh = d[be+F_SY];
  const ez = d[be+F_TZ];

  const overlapX = Math.min(rpx+rpw, ex+ew) - Math.max(rpx, ex);
  if (overlapX <= 0) return null;
  const overlapY = Math.min(rpy+rph, ey+eh) - Math.max(rpy, ey);
  if (overlapY <= 0) return null;

  const entityCenterY = ey + eh / 2;
  let t = (entityCenterY - rpy) / rph;
  t = Math.max(0, Math.min(1, t));
  const rampZ = d[br+F_TZ];
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

  const aEx = d[ba+F_SX]/2, aEy = d[ba+F_SY]/2, aEz = (d[ba+F_SZ] || 0.01) / 2;
  const bEx = d[bb+F_SX]/2, bEy = d[bb+F_SY]/2, bEz = (d[bb+F_SZ] || 0.01) / 2;

  const aCx = d[ba+F_TX] + aEx, aCy = d[ba+F_TY] + aEy, aCz = d[ba+F_TZ] + aEz;
  const bCx = d[bb+F_TX] + bEx, bCy = d[bb+F_TY] + bEy, bCz = d[bb+F_TZ] + bEz;

  const rotARef = isRotated(d, ba)
    ? (rotMatrixQuat(d[ba+F_QX], d[ba+F_QY], d[ba+F_QZ], d[ba+F_QW], _rotBufA), _rotBufA)
    : _rotIdentity;
  const rotBRef = isRotated(d, bb)
    ? (rotMatrixQuat(d[bb+F_QX], d[bb+F_QY], d[bb+F_QZ], d[bb+F_QW], _rotBufB), _rotBufB)
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

// ─── Triangle-mesh collision (BVH) ──────────────────────────────────────────

const _triBuf = new Float32Array(9);
const _triCandidates: number[] = [];

/**
 * Lazy BVH build. The mesh entry holds positions + indices from `register-mesh`;
 * the BVH is built the first time collision queries it.
 */
function ensureBvh(entry: MeshEntry): void {
  if (entry.bvh) return;
  if (!entry.positions) return;
  entry.bvh = buildBvh(entry.positions, entry.indices ?? null);
  entry.minTriEdge = computeMinTriEdge(entry.positions, entry.indices ?? null);
}

/**
 * Shortest triangle edge in mesh-local space — used as a tunneling threshold:
 * a body moving faster than this distance per step against a mesh face can skip
 * over it entirely, so the narrowphase falls back to sub-stepping.
 */
function computeMinTriEdge(
  positions: Float32Array,
  indices: Uint16Array | Uint32Array | null,
): number {
  const triCount = indices ? indices.length / 3 : positions.length / 9;
  let minSq = Infinity;
  for (let t = 0; t < triCount; t++) {
    const i0 = indices ? indices[t * 3]     : t * 3;
    const i1 = indices ? indices[t * 3 + 1] : t * 3 + 1;
    const i2 = indices ? indices[t * 3 + 2] : t * 3 + 2;
    const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
    const bx = positions[i1 * 3], by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2];
    const cx = positions[i2 * 3], cy = positions[i2 * 3 + 1], cz = positions[i2 * 3 + 2];
    const e0 = (bx-ax)*(bx-ax) + (by-ay)*(by-ay) + (bz-az)*(bz-az);
    const e1 = (cx-bx)*(cx-bx) + (cy-by)*(cy-by) + (cz-bz)*(cz-bz);
    const e2 = (ax-cx)*(ax-cx) + (ay-cy)*(ay-cy) + (az-cz)*(az-cz);
    if (e0 > 0 && e0 < minSq) minSq = e0;
    if (e1 > 0 && e1 < minSq) minSq = e1;
    if (e2 > 0 && e2 < minSq) minSq = e2;
  }
  return minSq === Infinity ? 0 : Math.sqrt(minSq);
}

function worldToMeshLocal(
  x: number, y: number, z: number,
  tx: number, ty: number, tz: number,
  sx: number, sy: number, sz: number,
  iqx: number, iqy: number, iqz: number, iqw: number,
): [number, number, number] {
  const rx = x - tx;
  const ry = y - ty;
  const rz = z - tz;
  const [ux, uy, uz] = rotateVecByQuat(rx, ry, rz, iqx, iqy, iqz, iqw);
  return [ux / sx, uy / sy, uz / sz];
}

function localNormalToWorld(
  nx: number, ny: number, nz: number,
  sx: number, sy: number, sz: number,
  qx: number, qy: number, qz: number, qw: number,
): [number, number, number] {
  const lx = nx / sx;
  const ly = ny / sy;
  const lz = nz / sz;
  const [wx, wy, wz] = rotateVecByQuat(lx, ly, lz, qx, qy, qz, qw);
  const len = Math.hypot(wx, wy, wz) || 1;
  return [wx / len, wy / len, wz / len];
}

/**
 * Triangle mesh (slot M) vs. AABB (slot O) — used when one entity is a registered
 * mesh and the other a rect/quad. The mesh is treated as fixed/static; entity
 * positions are mesh local origins (so triangle world position = entity.pos + tri.local).
 *
 * Returns the deepest single-axis contact found across overlapping triangles.
 */
function triMeshVsAabb(
  store: EntityStore, d: Float64Array, slotM: number, slotO: number, entry: MeshEntry, dt: number,
): Contact | null {
  ensureBvh(entry);
  if (!entry.bvh || !entry.positions) return null;

  const bo = slotO * STRIDE;
  const wt = store.getWorldTransform(slotM);
  const tx = wt[0], ty = wt[1], tz = wt[2];
  const sx = Math.max(Math.abs(wt[3]), 1e-6), sy = Math.max(Math.abs(wt[4]), 1e-6), sz = Math.max(Math.abs(wt[5]), 1e-6);
  const qx = wt[6], qy = wt[7], qz = wt[8], qw = wt[9];
  const iqx = -qx, iqy = -qy, iqz = -qz, iqw = qw;

  // Convert the dynamic body's world velocity into mesh-local space so we can compare
  // it against per-triangle normals (also local). We rotate by the inverse mesh quaternion
  // then divide by mesh scale — the same chain worldToMeshLocal applies, minus translation.
  const vWx = d[bo + F_VX], vWy = d[bo + F_VY], vWz = d[bo + F_VZ];
  const [vRx, vRy, vRz] = rotateVecByQuat(vWx, vWy, vWz, iqx, iqy, iqz, iqw);
  const vLx = vRx / sx, vLy = vRy / sy, vLz = vRz / sz;
  const slackLocal = MESH_THICKNESS_SLACK / Math.min(sx, sy, sz);

  const ax0 = d[bo + F_TX], ay0 = d[bo + F_TY], az0 = d[bo + F_TZ];
  const ax1 = ax0 + d[bo + F_SX], ay1 = ay0 + d[bo + F_SY], az1 = az0 + (d[bo + F_SZ] || 0.01);

  const corners: [number, number, number][] = [
    [ax0, ay0, az0], [ax1, ay0, az0], [ax0, ay1, az0], [ax1, ay1, az0],
    [ax0, ay0, az1], [ax1, ay0, az1], [ax0, ay1, az1], [ax1, ay1, az1],
  ];
  let lMinX = Infinity, lMinY = Infinity, lMinZ = Infinity;
  let lMaxX = -Infinity, lMaxY = -Infinity, lMaxZ = -Infinity;
  for (const c of corners) {
    const [lx, ly, lz] = worldToMeshLocal(c[0], c[1], c[2], tx, ty, tz, sx, sy, sz, iqx, iqy, iqz, iqw);
    if (lx < lMinX) lMinX = lx;
    if (ly < lMinY) lMinY = ly;
    if (lz < lMinZ) lMinZ = lz;
    if (lx > lMaxX) lMaxX = lx;
    if (ly > lMaxY) lMaxY = ly;
    if (lz > lMaxZ) lMaxZ = lz;
  }

  _triCandidates.length = 0;
  queryAabb(entry.bvh, lMinX, lMinY, lMinZ, lMaxX, lMaxY, lMaxZ, _triCandidates);
  if (_triCandidates.length === 0) return null;

  // Box center + half-extents (local).
  const bcx = (lMinX + lMaxX) * 0.5, bcy = (lMinY + lMaxY) * 0.5, bcz = (lMinZ + lMaxZ) * 0.5;
  const bhx = (lMaxX - lMinX) * 0.5, bhy = (lMaxY - lMinY) * 0.5, bhz = (lMaxZ - lMinZ) * 0.5;

  let bestDepth = 0;
  let bestNx = 0, bestNy = 0, bestNz = 0;

  for (let i = 0; i < _triCandidates.length; i++) {
    const triIdx = _triCandidates[i];
    readTriangle(entry.positions, entry.indices ?? null, triIdx, _triBuf);
    const v0x = _triBuf[0], v0y = _triBuf[1], v0z = _triBuf[2];
    const v1x = _triBuf[3], v1y = _triBuf[4], v1z = _triBuf[5];
    const v2x = _triBuf[6], v2y = _triBuf[7], v2z = _triBuf[8];

    // 1. AABB axis tests (separating).
    if (Math.max(v0x, v1x, v2x) < lMinX || Math.min(v0x, v1x, v2x) > lMaxX) continue;
    if (Math.max(v0y, v1y, v2y) < lMinY || Math.min(v0y, v1y, v2y) > lMaxY) continue;
    if (Math.max(v0z, v1z, v2z) < lMinZ || Math.min(v0z, v1z, v2z) > lMaxZ) continue;

    // 2. Triangle-normal SAT.
    const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
    const e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const nLen = Math.hypot(nx, ny, nz);
    if (nLen < 1e-9) continue;
    nx /= nLen; ny /= nLen; nz /= nLen;
    const planeD = nx * v0x + ny * v0y + nz * v0z;
    const r = bhx * Math.abs(nx) + bhy * Math.abs(ny) + bhz * Math.abs(nz);
    const s = nx * bcx + ny * bcy + nz * bcz - planeD;

    // Penetration on the triangle-normal axis. For bodies that crossed the plane
    // this step we extend the test by exactly the distance they could have travelled
    // along -n (plus a small slack), so a body at rest gets ~0 back-side tolerance
    // and only an actually-moving body gets a tunnel-catching extension.
    const vAlongN = vLx * nx + vLy * ny + vLz * nz;
    const backReach = Math.max(0, -vAlongN) * dt + slackLocal;
    let depth: number;
    if (s >= 0) {
      if (s > r) continue;
      depth = r - s;
    } else {
      if (s < -(r + backReach)) continue;
      depth = r + backReach + s;
    }
    if (depth > bestDepth) {
      bestDepth = depth;
      // Always push toward front face for both front and tunneled contacts —
      // the return negates this, so negated-normal points in the separation direction.
      bestNx = nx; bestNy = ny; bestNz = nz;
    }
  }

  if (bestDepth <= 0) return null;
  const [wnx, wny, wnz] = localNormalToWorld(bestNx, bestNy, bestNz, sx, sy, sz, qx, qy, qz, qw);
  const depthWorld = bestDepth * Math.hypot(bestNx * sx, bestNy * sy, bestNz * sz);
  return { slotA: slotM, slotB: slotO, nx: wnx, ny: wny, nz: wnz, depth: depthWorld, trigger: false };
}

/**
 * Triangle mesh vs. circle (sphere). Closest-point-on-triangle vs. sphere center;
 * if the distance is less than the radius, that's a contact.
 */
function triMeshVsSphere(
  store: EntityStore, d: Float64Array, slotM: number, slotO: number, entry: MeshEntry, _dt: number,
): Contact | null {
  ensureBvh(entry);
  if (!entry.bvh || !entry.positions) return null;

  const bo = slotO * STRIDE;
  const wt = store.getWorldTransform(slotM);
  const tx = wt[0], ty = wt[1], tz = wt[2];
  const sx = Math.max(Math.abs(wt[3]), 1e-6), sy = Math.max(Math.abs(wt[4]), 1e-6), sz = Math.max(Math.abs(wt[5]), 1e-6);
  const qx = wt[6], qy = wt[7], qz = wt[8], qw = wt[9];
  const iqx = -qx, iqy = -qy, iqz = -qz, iqw = qw;

  // Sphere = circle entity. Treat F_SX as diameter (existing convention).
  // (Sphere narrowphase relies on closest-point distance, not a back-plane test, so
  // it doesn't take an adaptive thickness. Sub-stepping in Physics.ts is what catches
  // tunneling for fast circles — `_dt` is accepted for signature parity.)
  const radiusWorld = d[bo + F_SX] * 0.5;
  const cxWorld = d[bo + F_TX] + radiusWorld;
  const cyWorld = d[bo + F_TY] + radiusWorld;
  const czWorld = d[bo + F_TZ] + (d[bo + F_SZ] || d[bo + F_SX]) * 0.5;
  const [cx, cy, cz] = worldToMeshLocal(cxWorld, cyWorld, czWorld, tx, ty, tz, sx, sy, sz, iqx, iqy, iqz, iqw);
  const radius = radiusWorld / Math.min(sx, sy, sz);

  _triCandidates.length = 0;
  queryAabb(entry.bvh, cx - radius, cy - radius, cz - radius, cx + radius, cy + radius, cz + radius, _triCandidates);
  if (_triCandidates.length === 0) return null;

  let bestDepth = 0;
  let bestNx = 0, bestNy = 0, bestNz = 0;

  for (let i = 0; i < _triCandidates.length; i++) {
    const triIdx = _triCandidates[i];
    readTriangle(entry.positions, entry.indices ?? null, triIdx, _triBuf);
    const cp = closestPointOnTriangle(
      cx, cy, cz,
      _triBuf[0], _triBuf[1], _triBuf[2],
      _triBuf[3], _triBuf[4], _triBuf[5],
      _triBuf[6], _triBuf[7], _triBuf[8],
    );
    const dx = cx - cp[0], dy = cy - cp[1], dz = cz - cp[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist >= radius) continue;
    const depth = radius - dist;
    if (depth > bestDepth) {
      bestDepth = depth;
      const inv = dist > 1e-9 ? 1 / dist : 0;
      bestNx = dx * inv; bestNy = dy * inv; bestNz = dz * inv;
    }
  }

  if (bestDepth <= 0) return null;
  const [wnx, wny, wnz] = localNormalToWorld(bestNx, bestNy, bestNz, sx, sy, sz, qx, qy, qz, qw);
  const depthWorld = bestDepth * Math.hypot(bestNx * sx, bestNy * sy, bestNz * sz);
  return { slotA: slotM, slotB: slotO, nx: wnx, ny: wny, nz: wnz, depth: depthWorld, trigger: false };
}

/** Closest point on triangle (v0,v1,v2) to point p. Returns [x,y,z]. */
function closestPointOnTriangle(
  px: number, py: number, pz: number,
  v0x: number, v0y: number, v0z: number,
  v1x: number, v1y: number, v1z: number,
  v2x: number, v2y: number, v2z: number,
): [number, number, number] {
  // Real-Time Collision Detection (Ericson) section 5.1.5.
  const abx = v1x - v0x, aby = v1y - v0y, abz = v1z - v0z;
  const acx = v2x - v0x, acy = v2y - v0y, acz = v2z - v0z;
  const apx = px - v0x,  apy = py - v0y,  apz = pz - v0z;
  const dAB_AP = abx * apx + aby * apy + abz * apz;
  const dAC_AP = acx * apx + acy * apy + acz * apz;
  if (dAB_AP <= 0 && dAC_AP <= 0) return [v0x, v0y, v0z];

  const bpx = px - v1x, bpy = py - v1y, bpz = pz - v1z;
  const dAB_BP = abx * bpx + aby * bpy + abz * bpz;
  const dAC_BP = acx * bpx + acy * bpy + acz * bpz;
  if (dAB_BP >= 0 && dAC_BP <= dAB_BP) return [v1x, v1y, v1z];

  const vc = dAB_AP * dAC_BP - dAB_BP * dAC_AP;
  if (vc <= 0 && dAB_AP >= 0 && dAB_BP <= 0) {
    const t = dAB_AP / (dAB_AP - dAB_BP);
    return [v0x + t * abx, v0y + t * aby, v0z + t * abz];
  }

  const cpx = px - v2x, cpy = py - v2y, cpz = pz - v2z;
  const dAB_CP = abx * cpx + aby * cpy + abz * cpz;
  const dAC_CP = acx * cpx + acy * cpy + acz * cpz;
  if (dAC_CP >= 0 && dAB_CP <= dAC_CP) return [v2x, v2y, v2z];

  const vb = dAB_CP * dAC_AP - dAB_AP * dAC_CP;
  if (vb <= 0 && dAC_AP >= 0 && dAC_CP <= 0) {
    const t = dAC_AP / (dAC_AP - dAC_CP);
    return [v0x + t * acx, v0y + t * acy, v0z + t * acz];
  }

  const va = dAB_BP * dAC_CP - dAB_CP * dAC_BP;
  if (va <= 0 && (dAC_BP - dAB_BP) >= 0 && (dAB_CP - dAC_CP) >= 0) {
    const t = (dAC_BP - dAB_BP) / ((dAC_BP - dAB_BP) + (dAB_CP - dAC_CP));
    return [v1x + t * (v2x - v1x), v1y + t * (v2y - v1y), v1z + t * (v2z - v1z)];
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return [v0x + abx * v + acx * w, v0y + aby * v + acy * w, v0z + abz * v + acz * w];
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function detectCollision(
  store: EntityStore, slotA: number, slotB: number,
  metaA: EntityMeta, metaB: EntityMeta, dt: number,
): Contact | null {
  const d = store.data;

  // Triangle-mesh dispatch — only when the entity's `type` is explicitly "mesh".
  // An entity with type "quad"/"circle" + a meshId renders the mesh but collides
  // as a box/sphere using the existing primitive paths below. This keeps narrowphase
  // cheap for decorative or simple-shape objects.
  const meshA = usesMeshCollision(metaA);
  const meshB = usesMeshCollision(metaB);
  if (meshA && !meshB) {
    const entry = store.meshes.get(metaA.meshId!);
    if (entry) {
      const c = metaB.type === "circle"
        ? triMeshVsSphere(store, d, slotA, slotB, entry, dt)
        : triMeshVsAabb(store, d, slotA, slotB, entry, dt);
      if (c) c.trigger = !!(d[slotA * STRIDE + F_FLAGS] & FLAG_TRIGGER) || !!(d[slotB * STRIDE + F_FLAGS] & FLAG_TRIGGER);
      return c;
    }
  } else if (meshB && !meshA) {
    const entry = store.meshes.get(metaB.meshId!);
    if (entry) {
      const c = metaA.type === "circle"
        ? triMeshVsSphere(store, d, slotB, slotA, entry, dt)
        : triMeshVsAabb(store, d, slotB, slotA, entry, dt);
      if (!c) return null;
      // Flip slot ordering + normal so caller convention (slotA = first input) holds.
      const flipped: Contact = {
        slotA, slotB, nx: -c.nx, ny: -c.ny, nz: -c.nz, depth: c.depth, trigger: false,
      };
      flipped.trigger = !!(d[slotA * STRIDE + F_FLAGS] & FLAG_TRIGGER) || !!(d[slotB * STRIDE + F_FLAGS] & FLAG_TRIGGER);
      return flipped;
    }
  }

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
  d[ba+F_TX] -= corr*nx*invA;  d[ba+F_TY] -= corr*ny*invA;  d[ba+F_TZ] -= corr*nz*invA;
  d[bb+F_TX] += corr*nx*invB;  d[bb+F_TY] += corr*ny*invB;  d[bb+F_TZ] += corr*nz*invB;

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
