/**
 * Physics engine + PhysicsNode + CollisionNode.
 *
 * Core step, loop management, and Node wrappers for JMS integration.
 * Collision and constraint logic are in separate modules.
 * Works on both client (RAF) and server (setTimeout).
 */

import { Node, Context, NodeValue, resolve, resolveAll, runSteps } from "@jexs/core";
import {
  EntityStore,
  STRIDE,
  F_X, F_Y, F_W, F_H, F_Z, F_D,
  F_VX, F_VY, F_AX, F_AY,
  F_VZ, F_AZ,
  F_INV_MASS, F_RESTITUTION, F_FRICTION, F_DAMPING,
  F_MOVE_X, F_MOVE_Y, F_FLAGS,
  F_RX, F_RY, F_ANGLE,
  FLAG_PHYSICS, FLAG_SLEEPING, FLAG_TRIGGER, FLAG_CCD,
} from "../EntityStore.js";
import { raycastStore } from "../Raycast.js";
import { detectCollision, resolveCollision, wakeBody, isRotated } from "../collision.js";
import { solveConstraints, type Constraint, type ConstraintType } from "../constraints.js";
import { SpatialGrid } from "../SpatialGrid.js";

// Re-export types and functions that the barrel (index.ts) needs from submodules
export { wakeBody } from "../collision.js";
export { type Constraint, type ConstraintType } from "../constraints.js";

// ─── Contact ─────────────────────────────────────────────────────────────────

export interface Contact {
  slotA: number;
  slotB: number;
  nx: number;
  ny: number;
  nz: number;
  depth: number;
  /** True if either entity is a trigger volume (overlap only, no impulse). */
  trigger: boolean;
}

// ─── World config ────────────────────────────────────────────────────────────

export interface PhysicsConfig {
  gravity: [number, number] | [number, number, number];
  damping: number;
  bounds: { x: number; y: number; w: number; h: number; z?: number; d?: number } | "canvas" | null;
}

interface CollisionHandler {
  id: string;
  groups: [string, string];
  do: unknown[];
}

/** Fixed timestep (seconds). Physics always steps at this rate. */
export const FIXED_DT = 1 / 60;
/** Maximum accumulated time before we start dropping frames (prevents spiral of death). */
const MAX_ACCUMULATOR = 0.1;

// ─── Sleep thresholds ────────────────────────────────────────────────────────
/** Motion below this is considered "at rest". ~0.5 px/s squared velocity. */
const SLEEP_MOTION_THRESHOLD = 0.25;
/** Frames of low motion required before putting a body to sleep. */
const SLEEP_FRAMES_REQUIRED = 90; // ~1.5s at 60Hz
/** Low-pass filter bias for motion smoothing (0..1). Higher = more responsive. */
const MOTION_BIAS = 0.2;

// ─── CCD thresholds ─────────────────────────────────────────────────────────
/** CCD activates when displacement exceeds this fraction of the entity's smallest dimension. */
const CCD_MOTION_THRESHOLD = 0.5;

/** Reference frame rate for frame-rate-independent damping. */
const REFERENCE_FPS = 60;

/** Minimum entity count before spatial grid broadphase activates (below this, brute-force is cheaper). */
const GRID_ACTIVATION_THRESHOLD = 20;

/** Epsilon pullback after CCD time-of-impact to prevent surface penetration. */
const CCD_TOI_EPSILON = 0.001;

// Constraint and ConstraintType re-exported from constraints module

interface PhysicsWorld {
  config: PhysicsConfig;
  store: EntityStore;
  handlers: CollisionHandler[];
  constraints: Constraint[];
  loopId: number | null;
  lastTime: number;
  accumulator: number;
  context: Context;
  paused: boolean;
  onStep: (() => void) | null;
}

// ─── Shared state ────────────────────────────────────────────────────────────

const worlds = new Map<string, PhysicsWorld>();

/** Enable verbose physics logging (timing + collision stats). */
export let _physicsDebug = false;

// ─── Loop driver (auto-detects RAF vs setTimeout) ────────────────────────────

const hasRAF = typeof requestAnimationFrame !== "undefined";

function scheduleFrame(fn: (time: number) => void): number {
  if (hasRAF) return requestAnimationFrame(fn);
  const start = Date.now();
  return setTimeout(() => fn(start), 16) as unknown as number;
}

function cancelFrame(id: number): void {
  if (hasRAF) cancelAnimationFrame(id);
  else clearTimeout(id);
}

const _pairSet = new Set<number>();
let _grid: SpatialGrid | null = null;
const DEFAULT_CELL_SIZE = 128;

// ─── CCD — Continuous Collision Detection ────────────────────────────────────

/**
 * Swept AABB vs static AABB test. Returns time-of-impact [0..1] or 1.0 if no hit.
 * Uses the Minkowski-difference slab method for exact linear sweep.
 *
 * Parameters are the moving body's start position, size, displacement,
 * and the static body's position and size.
 */
function sweptAABB(
  ax: number, ay: number, aw: number, ah: number,
  dx: number, dy: number,
  bx: number, by: number, bw: number, bh: number,
): number {
  // Minkowski expansion: expand B by A's size, shrink A to a point
  const mx = bx - aw, my = by - ah;
  const mw = bw + aw, mh = bh + ah;

  // Slab intersection
  let tMin = 0, tMax = 1;

  // X axis
  if (dx !== 0) {
    let t1 = (mx - ax) / dx;
    let t2 = (mx + mw - ax) / dx;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return 1;
  } else {
    // Ray parallel to slab — check if inside
    if (ax < mx || ax > mx + mw) return 1;
  }

  // Y axis
  if (dy !== 0) {
    let t1 = (my - ay) / dy;
    let t2 = (my + mh - ay) / dy;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return 1;
  } else {
    if (ay < my || ay > my + mh) return 1;
  }

  return tMin >= 0 ? tMin : 1;
}

/**
 * CCD pass: for FLAG_CCD entities that moved more than CCD_MOTION_THRESHOLD * size,
 * perform swept tests against all static geometry. If tunneling is detected,
 * rewind position to the time-of-impact.
 */
function ccdPass(store: EntityStore, dynamicSlots: number[], staticSlots: number[]): void {
  const d = store.data;

  for (let i = 0; i < dynamicSlots.length; i++) {
    const slot = dynamicSlots[i];
    const b = slot * STRIDE;
    const flags = d[b + F_FLAGS];

    // Only process CCD-enabled, non-sleeping dynamic bodies
    if (!(flags & FLAG_CCD) || (flags & FLAG_SLEEPING) || d[b + F_INV_MASS] === 0) continue;

    const pb = slot * 3;
    const prevX = store.prevPositions[pb];
    const prevY = store.prevPositions[pb + 1];
    const curX = d[b + F_X];
    const curY = d[b + F_Y];
    const dx = curX - prevX;
    const dy = curY - prevY;

    const w = d[b + F_W], h = d[b + F_H];
    const minDim = Math.min(w, h);
    const dist2 = dx * dx + dy * dy;

    // Skip if displacement is small relative to entity size
    if (dist2 < (CCD_MOTION_THRESHOLD * minDim) * (CCD_MOTION_THRESHOLD * minDim)) continue;

    // Sweep against all statics to find earliest TOI
    let earliestTOI = 1;

    for (let j = 0; j < staticSlots.length; j++) {
      const sb = staticSlots[j] * STRIDE;
      const meta = store.meta[staticSlots[j]];
      if (!meta) continue;

      // Check mask compatibility
      const movingMeta = store.meta[slot];
      if (!movingMeta) continue;
      if (!movingMeta.mask.includes(meta.group) && !meta.mask.includes(movingMeta.group)) continue;

      const toi = sweptAABB(
        prevX, prevY, w, h, dx, dy,
        d[sb + F_X], d[sb + F_Y], d[sb + F_W], d[sb + F_H],
      );

      if (toi < earliestTOI) earliestTOI = toi;
    }

    // Also sweep against other dynamics (for dynamic-vs-dynamic tunneling)
    for (let j = 0; j < dynamicSlots.length; j++) {
      if (dynamicSlots[j] === slot) continue;
      const sb = dynamicSlots[j] * STRIDE;
      const meta = store.meta[dynamicSlots[j]];
      if (!meta) continue;
      const movingMeta = store.meta[slot];
      if (!movingMeta) continue;
      if (!movingMeta.mask.includes(meta.group) && !meta.mask.includes(movingMeta.group)) continue;

      const toi = sweptAABB(
        prevX, prevY, w, h, dx, dy,
        d[sb + F_X], d[sb + F_Y], d[sb + F_W], d[sb + F_H],
      );

      if (toi < earliestTOI) earliestTOI = toi;
    }

    // If we found an early TOI, rewind to just before impact
    if (earliestTOI < 1) {
      // Place at TOI with a small epsilon pullback to avoid starting inside
      const t = Math.max(0, earliestTOI - CCD_TOI_EPSILON);
      d[b + F_X] = prevX + dx * t;
      d[b + F_Y] = prevY + dy * t;
    }
  }
}

// ─── Pure physics step ───────────────────────────────────────────────────────

/**
 * Run one physics step. Returns contacts detected this frame.
 * Caller is responsible for firing collision handlers and rendering.
 */
// Preallocated scratch arrays — reused every frame to avoid GC pressure
let _dynamicSlots: number[] = [];
let _staticSlots: number[] = [];
let _contacts: Contact[] = [];

export function physicsStep(store: EntityStore, config: PhysicsConfig, dt: number, constraints?: Constraint[]): Contact[] {
  const d = store.data;
  const gx = config.gravity[0], gy = config.gravity[1], gz = config.gravity[2] ?? 0;

  _dynamicSlots.length = 0;
  _staticSlots.length = 0;

  const _t0 = performance.now();

  // 1. Integrate + collect physics slots in a single pass
  for (let i = 0; i < store.count; i++) {
    const b = i * STRIDE;
    const flags = d[b + F_FLAGS];
    if (!(flags & FLAG_PHYSICS)) continue;
    const invMass = d[b + F_INV_MASS];
    if (invMass === 0) { _staticSlots.push(i); continue; }

    // Skip sleeping bodies (still add to dynamic list for wake-on-collision)
    if (flags & FLAG_SLEEPING) {
      _dynamicSlots.push(i);
      continue;
    }

    _dynamicSlots.push(i);

    let vx = d[b + F_VX] + (gx + d[b + F_AX]) * dt;
    let vy = d[b + F_VY] + (gy + d[b + F_AY]) * dt;
    let vz = d[b + F_VZ] + (gz + d[b + F_AZ]) * dt;
    const damp = d[b + F_DAMPING] >= 0 ? d[b + F_DAMPING] : config.damping;
    const dampFactor = Math.pow(1 - damp, dt * REFERENCE_FPS);
    vx *= dampFactor;
    vy *= dampFactor;

    const mx = d[b + F_MOVE_X], my = d[b + F_MOVE_Y];
    if (mx === mx) vx = mx;
    if (my === my) vy = my;

    d[b + F_VX] = vx;
    d[b + F_VY] = vy;
    d[b + F_VZ] = vz;
    d[b + F_X] += vx * dt;
    d[b + F_Y] += vy * dt;
    d[b + F_Z] += vz * dt;

    // Invalidate cached worldTransform (position changed, children need recompute)
    const meta_i = store.meta[i];
    if (meta_i && meta_i.worldTransform) {
      store.invalidateWorldTransform(i);
    }

    // Update motion for sleep detection (low-pass filtered velocity magnitude)
    const speed2 = vx * vx + vy * vy + vz * vz;
    store.motion[i] = MOTION_BIAS * speed2 + (1 - MOTION_BIAS) * store.motion[i];
    if (store.motion[i] < SLEEP_MOTION_THRESHOLD) {
      if (store.sleepFrames[i] < SLEEP_FRAMES_REQUIRED) store.sleepFrames[i]++;
      if (store.sleepFrames[i] >= SLEEP_FRAMES_REQUIRED) {
        // Put to sleep: zero velocity, set flag
        d[b + F_VX] = 0; d[b + F_VY] = 0; d[b + F_VZ] = 0;
        d[b + F_FLAGS] = flags | FLAG_SLEEPING;
      }
    } else {
      store.sleepFrames[i] = 0;
    }
  }

  const _t1 = performance.now();

  // 2. CCD pass — rewind fast-moving CCD entities to time-of-impact
  ccdPass(store, _dynamicSlots, _staticSlots);

  // 3. Collision detection — skip static-vs-static entirely
  _contacts.length = 0;
  let _maskSkips = 0, _zSkips = 0, _narrowTests = 0;

  // Build spatial grid for broadphase (dynamic + static entities)
  const totalPhysics = _dynamicSlots.length + _staticSlots.length;
  const useGrid = totalPhysics > GRID_ACTIVATION_THRESHOLD;
  if (useGrid) {
    if (!_grid) _grid = new SpatialGrid(DEFAULT_CELL_SIZE);
    _grid.clear();
    for (let i = 0; i < _dynamicSlots.length; i++) {
      const s = _dynamicSlots[i], b = s * STRIDE;
      _grid.insert(s, d[b + F_X], d[b + F_Y], d[b + F_W], d[b + F_H]);
    }
    for (let i = 0; i < _staticSlots.length; i++) {
      const s = _staticSlots[i], b = s * STRIDE;
      _grid.insert(s, d[b + F_X], d[b + F_Y], d[b + F_W], d[b + F_H]);
    }
  }

  // Deduplicate pairs when using grid (a pair can be found from either side)
  const _pairsSeen = useGrid ? _pairSet : null;
  if (_pairsSeen) _pairsSeen.clear();

  // 3a. Dynamic vs dynamic
  if (useGrid) {
    for (let i = 0; i < _dynamicSlots.length; i++) {
      const sa = _dynamicSlots[i], ba = sa * STRIDE;
      const ma = store.meta[sa]!;
      const neighbors = _grid!.query(d[ba + F_X], d[ba + F_Y], d[ba + F_W], d[ba + F_H], sa);
      for (let j = 0; j < neighbors.length; j++) {
        const sb = neighbors[j];
        if (d[sb * STRIDE + F_INV_MASS] === 0) continue; // skip statics in this pass
        // Deduplicate: only process pair once (lower slot first)
        const pairKey = sa < sb ? sa * 0x100000 + sb : sb * 0x100000 + sa;
        if (_pairsSeen!.has(pairKey)) continue;
        _pairsSeen!.add(pairKey);
        const mb = store.meta[sb]!;
        if (!ma.mask.includes(mb.group) && !mb.mask.includes(ma.group)) { _maskSkips++; continue; }
        _narrowTests++;
        const c = detectCollision(d, sa, sb, ma, mb);
        if (c) _contacts.push(c);
      }
    }
  } else {
    for (let i = 0; i < _dynamicSlots.length; i++) {
      for (let j = i + 1; j < _dynamicSlots.length; j++) {
        const sa = _dynamicSlots[i], sb = _dynamicSlots[j];
        const ma = store.meta[sa]!, mb = store.meta[sb]!;
        if (!ma.mask.includes(mb.group) && !mb.mask.includes(ma.group)) { _maskSkips++; continue; }
        _narrowTests++;
        const c = detectCollision(d, sa, sb, ma, mb);
        if (c) _contacts.push(c);
      }
    }
  }

  // 3b. Dynamic vs static — early AABB broadphase on Z to skip irrelevant pairs
  if (useGrid) {
    for (let i = 0; i < _dynamicSlots.length; i++) {
      const sa = _dynamicSlots[i], ba = sa * STRIDE;
      const ma = store.meta[sa]!;
      const az = d[ba + F_Z], ad = d[ba + F_D] || 0.01;
      const aTop = az + ad;
      const neighbors = _grid!.query(d[ba + F_X], d[ba + F_Y], d[ba + F_W], d[ba + F_H], sa);
      for (let j = 0; j < neighbors.length; j++) {
        const sb = neighbors[j];
        if (d[sb * STRIDE + F_INV_MASS] !== 0) continue; // skip dynamics in this pass
        const mb = store.meta[sb]!;
        if (!ma.mask.includes(mb.group) && !mb.mask.includes(ma.group)) { _maskSkips++; continue; }
        const bb = sb * STRIDE;
        if (!isRotated(d, bb)) {
          const bz = d[bb + F_Z], bd = d[bb + F_D] || 0.01;
          if (az > bz + bd || bz > aTop) { _zSkips++; continue; }
        }
        _narrowTests++;
        const c = detectCollision(d, sa, sb, ma, mb);
        if (c) _contacts.push(c);
      }
    }
  } else {
    for (let i = 0; i < _dynamicSlots.length; i++) {
      const sa = _dynamicSlots[i];
      const ba = sa * STRIDE;
      const ma = store.meta[sa]!;
      const az = d[ba + F_Z], ad = d[ba + F_D] || 0.01;
      const aTop = az + ad;

      for (let j = 0; j < _staticSlots.length; j++) {
        const sb = _staticSlots[j];
        const mb = store.meta[sb]!;
        if (!ma.mask.includes(mb.group) && !mb.mask.includes(ma.group)) { _maskSkips++; continue; }

        // Quick Z-overlap pre-check before full collision test
        // Skip broadphase for rotated statics — their Z extent differs from raw d
        const bb = sb * STRIDE;
        if (!isRotated(d, bb)) {
          const bz = d[bb + F_Z], bd = d[bb + F_D] || 0.01;
          if (az > bz + bd || bz > aTop) { _zSkips++; continue; }
        }

        _narrowTests++;
        const c = detectCollision(d, sa, sb, ma, mb);
        if (c) _contacts.push(c);
      }
    }
  }

  const _t2 = performance.now();

  // 4. Resolve — skip triggers, apply impulses for solid contacts
  for (let i = 0; i < _contacts.length; i++) {
    if (!_contacts[i].trigger) resolveCollision(store, _contacts[i], config);
  }

  // 4b. Solve constraints (distance, spring, hinge)
  if (constraints && constraints.length > 0) {
    solveConstraints(store, constraints, dt);
  }

  const _t3 = performance.now();

  // Detailed step timing (accumulate for log in startLoop)
  _perfAccum.integrate += _t1 - _t0;
  _perfAccum.collide += _t2 - _t1;
  _perfAccum.resolve += _t3 - _t2;

  // 5. Bounds
  if (config.bounds) {
    const bx = 0, by = 0;
    let bw: number, bh: number;
    let bz = 0, bd = 0;
    if (config.bounds === "canvas") {
      bw = store.width; bh = store.height;
    } else {
      bw = config.bounds.w; bh = config.bounds.h;
      bz = config.bounds.z ?? 0; bd = config.bounds.d ?? 0;
    }
    for (let i = 0; i < _dynamicSlots.length; i++) {
      const slot = _dynamicSlots[i];
      const b = slot * STRIDE;
      const x = d[b + F_X], y = d[b + F_Y], w = d[b + F_W], h = d[b + F_H];
      const rest = d[b + F_RESTITUTION];
      if (x < bx)           { d[b + F_X] = bx;           d[b + F_VX] =  Math.abs(d[b + F_VX]) * rest; }
      if (y < by)           { d[b + F_Y] = by;           d[b + F_VY] =  Math.abs(d[b + F_VY]) * rest; }
      if (x + w > bx + bw) { d[b + F_X] = bx + bw - w;  d[b + F_VX] = -Math.abs(d[b + F_VX]) * rest; }
      if (y + h > by + bh) { d[b + F_Y] = by + bh - h;  d[b + F_VY] = -Math.abs(d[b + F_VY]) * rest; }
      if (bd > 0) {
        const z = d[b + F_Z], ed = d[b + F_D] || 0;
        if (z < bz)            { d[b + F_Z] = bz;            d[b + F_VZ] =  Math.abs(d[b + F_VZ]) * rest; }
        if (z + ed > bz + bd)  { d[b + F_Z] = bz + bd - ed;  d[b + F_VZ] = -Math.abs(d[b + F_VZ]) * rest; }
      }
    }
  }

  // Invalidate cached world transforms for entities with children
  // (physics moved parent positions, children need recomputed world transforms)
  for (let i = 0; i < store.count; i++) {
    const meta = store.meta[i];
    if (meta && meta.children.length > 0) {
      store.invalidateWorldTransform(i);
    }
  }

  return _contacts;
}

/** Apply an impulse to an entity by slot. Wakes sleeping bodies. */
export function applyImpulse(store: EntityStore, slot: number, ix: number, iy: number, iz?: number): void {
  const b = slot * STRIDE;
  const d = store.data;
  if (!(d[b + F_FLAGS] & FLAG_PHYSICS) || d[b + F_INV_MASS] === 0) return;
  wakeBody(store, slot);
  d[b + F_VX] += ix;
  d[b + F_VY] += iy;
  if (iz) d[b + F_VZ] += iz;
}

// wakeBody imported from ./collision.ts

// ─── PhysicsNode — JMS integration ──────────────────────────────────────────

export class PhysicsNode extends Node {

  /** Get selector from context._glSelector */
  static sel(context: Context): string {
    return (context._glSelector as string) || "";
  }

  /**
   * Initializes the physics simulation loop for the active entity store.
   * Must be called after `entity-init`. Restarts any existing loop.
   * @param {boolean} physics-init Pass `true` to initialize.
   * @param {number[]} gravity Gravity vector `[gx, gy]` or `[gx, gy, gz]` (default `[0, 980]`).
   * @param {number} damping Linear velocity damping factor 0–1 (default `0.01`).
   * @param {expr} bounds World boundary object `{x, y, w, h}` or `"canvas"`, or `null` for unbounded.
   * @example
   * { "physics-init": true, "gravity": [0, 980], "damping": 0.01 }
   */
  ["physics-init"](def: Record<string, unknown>, context: Context): NodeValue {
    const selector = PhysicsNode.sel(context);
    if (!selector) { console.error("[Physics] No _glSelector on context"); return null; }

    const prev = worlds.get(selector);
    if (prev?.loopId != null) cancelFrame(prev.loopId);

    const stores = context._entityStores as Record<string, EntityStore> | undefined;
    const store = stores?.[selector];
    if (!store) { console.error("[Physics] No entity store for", selector); return null; }

    return resolveAll(
      [def.gravity ?? null, def.damping ?? null, def.bounds ?? null],
      context,
      ([gravityRaw, dampingRaw, boundsRaw]) => {
        const config: PhysicsConfig = {
          gravity: gravityRaw ? gravityRaw as [number, number] : [0, 980],
          damping: dampingRaw !== null ? Number(dampingRaw) : 0.01,
          bounds: boundsRaw ? boundsRaw as PhysicsConfig["bounds"] : null,
        };

        const world: PhysicsWorld = {
          config,
          store,
          handlers: [],
          constraints: [],
          loopId: null,
          lastTime: 0,
          accumulator: 0,
          context,
          paused: false,
          onStep: (context._onPhysicsStep as ((selector: string) => void) | undefined)
            ? () => (context._onPhysicsStep as (s: string) => void)(selector)
            : null,
        };

        worlds.set(selector, world);
        startLoop(world);
        return null;
      },
    );
  }

  ["physics-pause"](_def: Record<string, unknown>, context: Context): NodeValue {
    const w = worlds.get(PhysicsNode.sel(context));
    if (w) w.paused = true;
    return null;
  }

  ["physics-resume"](_def: Record<string, unknown>, context: Context): NodeValue {
    const w = worlds.get(PhysicsNode.sel(context));
    if (w) { w.paused = false; w.lastTime = 0; }
    return null;
  }

  ["physics-destroy"](_def: Record<string, unknown>, context: Context): NodeValue {
    const selector = PhysicsNode.sel(context);
    const w = worlds.get(selector);
    if (w?.loopId != null) cancelFrame(w.loopId);
    worlds.delete(selector);
    return null;
  }

  ["physics-apply"](def: Record<string, unknown>, context: Context): NodeValue {
    const selector = PhysicsNode.sel(context);
    const stores = context._entityStores as Record<string, EntityStore> | undefined;
    const store = stores?.[selector];
    if (!store) return null;

    return resolveAll([def["physics-apply"], def.impulse ?? null], context, ([idRaw, impRaw]) => {
      const slot = store.slot(String(idRaw));
      if (slot === -1) return null;
      if (impRaw) {
        const imp = impRaw as number[];
        applyImpulse(store, slot, imp[0], imp[1], imp[2]);
      }
      return null;
    });
  }

  /**
   * Run a single physics step without managing a loop.
   * For use inside a tick loop for server-side authoritative simulation.
   * @param {boolean} physics-step Pass `true` to step.
   * @param {number} dt Delta time in seconds (default `1/60`).
   */
  ["physics-step"](def: Record<string, unknown>, context: Context): NodeValue {
    const selector = PhysicsNode.sel(context);
    const world = worlds.get(selector);
    if (!world) return null;

    return resolve(def.dt ?? null, context, dtRaw => {
      const dt = dtRaw !== null ? Number(dtRaw) : 1 / 60;
      const contacts = physicsStep(world.store, world.config, dt, world.constraints);
      world.store.deferringRemovals = true;
      const fired = fireCollisionHandlers(world, contacts);
      const finish = (): number => {
        world.store.flushRemovals();
        if (world.onStep) world.onStep();
        return contacts.length;
      };
      return fired instanceof Promise ? fired.then(finish) : finish();
    });
  }

  // ── physics-raycast — cast a ray and return sorted hits (works on client & server) ──
  // { "physics-raycast": true, "from": {"x":0,"y":0,"z":0}, "dir": {"x":1,"y":0,"z":0}, "mask": ["enemy"] }

  ["physics-raycast"](def: Record<string, unknown>, context: Context): NodeValue {
    const selector = PhysicsNode.sel(context);
    const stores = context._entityStores as Record<string, EntityStore> | undefined;
    const store = stores?.[selector];
    if (!store) return [];

    return resolveAll([def["from"], def["dir"], def["mask"] ?? null], context, ([fromRaw, dirRaw, maskRaw]) => {
      const from = fromRaw as { x: number; y: number; z?: number } | null;
      const dir = dirRaw as { x: number; y: number; z?: number } | null;
      if (!from || !dir) return [];
      const maskSet = maskRaw ? new Set(maskRaw as string[]) : null;
      return raycastStore(
        store,
        from.x, from.y, from.z ?? 0,
        dir.x, dir.y, dir.z ?? 0,
        maskSet,
      );
    });
  }
}

// ─── CollisionNode ───────────────────────────────────────────────────────────

export class CollisionNode extends Node {

  /**
   * Registers a collision handler that runs `do` steps when entities from two groups collide.
   * `$collisionA`, `$collisionB`, `$collisionNx/Ny/Nz` are set in context during the steps.
   * @param {boolean} collision-on Pass `true` to register the handler.
   * @param {[2]} groups Two-element array of group names: `[groupA, groupB]`.
   * @param {string} id Optional handler ID (auto-generated if omitted).
   * @param {expr[]} do Steps to run on collision.
   * @example
   * { "collision-on": true, "groups": ["player", "enemy"], "do": [{ "var": "$collisionA" }] }
   */
  ["collision-on"](def: Record<string, unknown>, context: Context): NodeValue {
    const w = worlds.get(PhysicsNode.sel(context));
    if (!w) return null;

    return resolveAll([def.groups, def.id ?? null], context, ([groupsRaw, idRaw]) => {
      const groups = groupsRaw as [string, string];
      const id = idRaw !== null ? String(idRaw) : `h${w.handlers.length}`;
      const steps = Array.isArray(def.do) ? def.do as unknown[] : [];
      w.handlers.push({ id, groups, do: steps });
      return id;
    });
  }

  ["collision-off"](def: Record<string, unknown>, context: Context): NodeValue {
    const w = worlds.get(PhysicsNode.sel(context));
    if (!w) return null;
    return resolve(def["collision-off"], context, idRaw => {
      const id = String(idRaw);
      w.handlers = w.handlers.filter(h => h.id !== id);
      return null;
    });
  }
}

// ─── JointNode — constraint management via JMS templates ─────────────────────

export class JointNode extends Node {

  /**
   * Create a constraint between two entities.
   * @param {string} joint-add Constraint ID.
   * @param {"distance"|"spring"|"hinge"} type Constraint type (default `"distance"`).
   * @param {string} a ID of first entity.
   * @param {string} b ID of second entity.
   * @param {number} restLength Rest length (default: current distance between entities).
   * @param {number} stiffness Constraint stiffness 0–1 (default `0.5`).
   * @param {number} damping Constraint damping 0–1 (default `0.1`).
   * @example
   * { "joint-add": "rope", "type": "spring", "a": "anchor", "b": "ball", "restLength": 100 }
   */
  ["joint-add"](def: Record<string, unknown>, context: Context): NodeValue {
    const w = worlds.get(PhysicsNode.sel(context));
    if (!w) return null;

    return resolveAll(
      [
        def["joint-add"],
        def.type ?? null,
        def.a,
        def.b,
        def.restLength ?? null,
        def.anchorA ?? null,
        def.anchorB ?? null,
        def.stiffness ?? null,
        def.damping ?? null,
        def.minAngle ?? null,
        def.maxAngle ?? null,
      ],
      context,
      ([idRaw, typeRaw, aRaw, bRaw, restRaw, anchorARaw, anchorBRaw, stiffRaw, dampRaw, minAngleRaw, maxAngleRaw]) => {
        const id = String(idRaw);
        const type = (typeRaw !== null ? String(typeRaw) : "distance") as ConstraintType;
        const entityA = String(aRaw);
        const entityB = String(bRaw);
        const slotA = w.store.slot(entityA);
        const slotB = w.store.slot(entityB);
        if (slotA === -1 || slotB === -1) return null;

        let restLength: number;
        if (restRaw !== null) {
          restLength = Number(restRaw);
        } else {
          const d = w.store.data;
          const ba = slotA * STRIDE, bb = slotB * STRIDE;
          const dx = d[bb + F_X] - d[ba + F_X];
          const dy = d[bb + F_Y] - d[ba + F_Y];
          restLength = Math.sqrt(dx * dx + dy * dy);
        }

        const anchorA = (anchorARaw ?? [0, 0]) as [number, number];
        const anchorB = (anchorBRaw ?? [0, 0]) as [number, number];

        const constraint: Constraint = {
          id,
          type,
          entityA,
          entityB,
          restLength,
          stiffness: stiffRaw !== null ? Number(stiffRaw) : 0.5,
          damping: dampRaw !== null ? Number(dampRaw) : 0.1,
          anchorA,
          anchorB,
          minAngle: minAngleRaw !== null ? Number(minAngleRaw) : NaN,
          maxAngle: maxAngleRaw !== null ? Number(maxAngleRaw) : NaN,
        };

        const idx = w.constraints.findIndex(c => c.id === id);
        if (idx !== -1) w.constraints[idx] = constraint;
        else w.constraints.push(constraint);

        return id;
      },
    );
  }

  /** Remove a constraint by ID. { "joint-remove": "myJoint" } */
  ["joint-remove"](def: Record<string, unknown>, context: Context): NodeValue {
    const w = worlds.get(PhysicsNode.sel(context));
    if (!w) return null;
    return resolve(def["joint-remove"], context, idRaw => {
      const id = String(idRaw);
      w.constraints = w.constraints.filter(c => c.id !== id);
      return null;
    });
  }
}

// ─── Collision handler dispatch ──────────────────────────────────────────────

function fireCollisionHandlers(world: PhysicsWorld, contacts: Contact[]): void | Promise<void> {
  // Sync-fast-path: walk all contacts/handlers inline; only return a Promise chain
  // when a handler actually returns one. Sequential ordering is preserved on the
  // async path so `world.context.collisionX` is not clobbered between handlers.
  let chain: Promise<unknown> | null = null;
  for (const { slotA, slotB, nx, ny, nz } of contacts) {
    const ma = world.store.meta[slotA]!, mb = world.store.meta[slotB]!;
    for (const h of world.handlers) {
      if (h.do.length === 0) continue;
      const [g1, g2] = h.groups;
      let ca: string, cb: string, cnx: number, cny: number, cnz: number;
      if (ma.group === g1 && mb.group === g2) {
        ca = ma.id; cb = mb.id; cnx = nx; cny = ny; cnz = nz;
      } else if (ma.group === g2 && mb.group === g1) {
        ca = mb.id; cb = ma.id; cnx = -nx; cny = -ny; cnz = -nz;
      } else continue;

      const run = (): unknown => {
        world.context.collisionA = ca;
        world.context.collisionB = cb;
        world.context.collisionNx = cnx;
        world.context.collisionNy = cny;
        world.context.collisionNz = cnz;
        return runSteps(h.do, world.context);
      };

      if (chain) {
        chain = chain.then(run);
      } else {
        const r = run();
        if (r instanceof Promise) chain = r;
      }
    }
  }
  return chain ? chain.then(() => undefined) : undefined;
}

// ─── Simulation loop ─────────────────────────────────────────────────────────

// ─── Performance tracing ──────────────────────────────────────────────────────

let _perfFrameCount = 0;
let _perfAccum = { integrate: 0, collide: 0, resolve: 0, handlers: 0, onStep: 0, total: 0 };
let _perfLastLog = 0;

/** Snapshot current positions into prevPositions for interpolation. */
function snapshotPositions(store: EntityStore): void {
  const d = store.data, p = store.prevPositions;
  for (let i = 0; i < store.count; i++) {
    const b = i * STRIDE, pb = i * 3;
    p[pb]     = d[b + F_X];
    p[pb + 1] = d[b + F_Y];
    p[pb + 2] = d[b + F_Z];
  }
}

function startLoop(world: PhysicsWorld): void {
  const tick = async (time: number) => {
    world.loopId = scheduleFrame(tick);
    if (world.paused) { world.lastTime = 0; world.accumulator = 0; return; }

    const frameDt = world.lastTime
      ? Math.min((time - world.lastTime) / 1000, MAX_ACCUMULATOR)
      : FIXED_DT;
    world.lastTime = time;
    world.accumulator += frameDt;

    const t0 = performance.now();
    let contacts: Contact[] = [];
    let steps = 0;

    // Fixed timestep: run as many FIXED_DT steps as accumulated time allows.
    // Skip the microtask hop when collision handlers ran sync — await on undefined
    // still queues a microtask, which adds up across many fixed steps per frame.
    while (world.accumulator >= FIXED_DT) {
      snapshotPositions(world.store);
      contacts = physicsStep(world.store, world.config, FIXED_DT, world.constraints);
      world.store.deferringRemovals = true;
      const fired = fireCollisionHandlers(world, contacts);
      if (fired) await fired;
      world.accumulator -= FIXED_DT;
      steps++;
    }
    world.store.flushRemovals();

    // Interpolation alpha: how far into the next fixed step we are
    world.store.interpolationAlpha = world.accumulator / FIXED_DT;

    const t1 = performance.now();
    if (world.onStep) world.onStep();
    const t2 = performance.now();

    _perfAccum.total += t1 - t0;
    _perfAccum.onStep += t2 - t1;
    _perfFrameCount++;

    if (_physicsDebug && time - _perfLastLog > 2000) {
      const n = _perfFrameCount || 1;
      console.log(
        `[Physics] ${_perfFrameCount} frames/2s | total: ${(_perfAccum.total/n).toFixed(2)}ms | ` +
        `integrate: ${(_perfAccum.integrate/n).toFixed(3)}ms | ` +
        `collide: ${(_perfAccum.collide/n).toFixed(3)}ms | resolve: ${(_perfAccum.resolve/n).toFixed(3)}ms | ` +
        `onStep: ${(_perfAccum.onStep/n).toFixed(2)}ms | ` +
        `entities: ${world.store.count} | contacts: ${contacts.length} | steps/frame: ${steps}`
      );
      _perfAccum = { integrate: 0, collide: 0, resolve: 0, handlers: 0, onStep: 0, total: 0 };
      _perfFrameCount = 0;
      _perfLastLog = time;
    }
  };
  world.loopId = scheduleFrame(tick);
}


// Collision detection, resolution, and wakeBody imported from ./collision.ts
// Constraint solving imported from ./constraints.ts
// SpatialGrid imported from ./SpatialGrid.ts
