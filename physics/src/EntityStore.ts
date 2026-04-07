/**
 * Struct-of-arrays entity storage backed by Float64Array.
 *
 * Numeric fields are packed into a single interleaved Float64Array
 * (stride = 26 floats per entity). Non-numeric metadata (id, type,
 * group, mask, vertices) lives in a parallel JS array.
 *
 * Removal uses swap-and-pop for O(1) dense iteration.
 * Draw order is tracked in a separate index array.
 */

// ─── Field offsets within the stride ─────────────────────────────────────────

export const STRIDE = 32;

export const F_X = 0, F_Y = 1, F_W = 2, F_H = 3, F_ANGLE = 4;
export const F_CR = 5, F_CG = 6, F_CB = 7, F_CA = 8;
export const F_VX = 9, F_VY = 10, F_AX = 11, F_AY = 12;
export const F_MASS = 13, F_INV_MASS = 14, F_RESTITUTION = 15, F_FRICTION = 16;
export const F_MOVE_X = 17, F_MOVE_Y = 18, F_FLAGS = 19;
export const F_Z = 20;
export const F_U = 21, F_V = 22, F_UW = 23, F_UH = 24;
export const F_OPACITY = 25;
export const F_DAMPING = 26;
// 3D extensions
export const F_D = 27;          // depth (z-size)
export const F_RX = 28;         // rotation around X axis (degrees)
export const F_RY = 29;         // rotation around Y axis (degrees)
export const F_VZ = 30;         // velocity Z
export const F_AZ = 31;         // acceleration Z

export const FLAG_VISIBLE = 1;
export const FLAG_PHYSICS = 2;
export const FLAG_FIXED = 4;
export const FLAG_POOLED = 8;
export const FLAG_SLEEPING = 16;
export const FLAG_TRIGGER = 32;
export const FLAG_CCD = 64;

// ─── Per-entity dirty bitmask ───────────────────────────────────────────────

export const DIRTY_TRANSFORM = 1;  // x, y, angle, w, h
export const DIRTY_VISUAL    = 2;  // color, texture, opacity, uv
export const DIRTY_TEXT      = 4;  // text content changed, needs texture re-render
export const DIRTY_Z         = 8;  // z changed, needs re-sort
export const DIRTY_WORLD     = 16; // world transform needs recompute (parent chain changed)

/** Name → offset map for property access by string key */
export const FIELD_OFFSETS: Record<string, number> = {
  x: F_X, y: F_Y, w: F_W, h: F_H, angle: F_ANGLE,
  vx: F_VX, vy: F_VY, ax: F_AX, ay: F_AY,
  mass: F_MASS, invMass: F_INV_MASS,
  restitution: F_RESTITUTION, friction: F_FRICTION, damping: F_DAMPING,
  z: F_Z,
  u: F_U, v: F_V, uW: F_UW, uH: F_UH,
  opacity: F_OPACITY,
  d: F_D, rx: F_RX, ry: F_RY, vz: F_VZ, az: F_AZ,
};

// ─── Metadata side table ─────────────────────────────────────────────────────

export interface EntityMeta {
  id: string;
  type: "quad" | "triangle" | "points" | "circle" | "line" | "line-strip" | "sphere" | "cylinder" | "cone" | "light" | "ramp" | "pivot";
  group: string;
  mask: string[];
  vertices?: number[];
  textureName?: string;
  normalMap?: string;
  normalScale?: number;
  lineWidth?: number;
  shader?: string;
  blend?: "normal" | "additive" | "multiply" | "screen";
  dirty: number;
  borderRadius?: number;
  emissive?: boolean;
  billboard?: boolean;
  parent?: string;
  children: string[];
  /** Cached world transform: [wx, wy, wAngle, wz]. Null = needs recompute. */
  worldTransform: Float64Array | null;
  custom: Record<string, unknown>;
  anim?: {
    frames: [number, number, number, number][];
    fps: number;
    loop: boolean;
    current: number;
    elapsed: number;
  };
  text?: {
    content: string;
    font: string;
    fill: string;
  };
}

// ─── EntityStore ─────────────────────────────────────────────────────────────

const INITIAL_CAPACITY = 64;

export class EntityStore {
  data: Float64Array;
  meta: (EntityMeta | null)[];
  idToSlot: Map<string, number> = new Map();
  order: number[] = [];
  /** Reverse index: slot → position in `order` array. Enables O(1) removal. */
  private slotToOrderIdx: Map<number, number> = new Map();
  count = 0;
  capacity: number;
  width = 0;
  height = 0;
  virtualWidth = 0;
  virtualHeight = 0;
  /** Called after entity mutations. Set by renderer (e.g. GlNode). */
  onChange: (() => void) | null = null;
  /** Set true by EntityNode when z changes. Renderer resets after sorting. */
  zDirty = false;
  /** Count of z-dirty entities since last sort. Used to pick insertion vs built-in sort. */
  zDirtyCount = 0;
  /** Entity pool free lists keyed by type (e.g. "quad", "circle"). Opt-in via `pooled: true`. */
  pool: Map<string, number[]> = new Map();
  static readonly POOL_MAX_PER_TYPE = 50;

  /** Previous positions for fixed-timestep interpolation (3 floats per entity: x, y, z). */
  prevPositions: Float64Array;
  /** Interpolation alpha [0..1] for rendering between prev and current positions. */
  interpolationAlpha = 1;
  /** Per-entity low-pass filtered motion value for sleep detection. */
  motion: Float64Array;
  /** Consecutive frames each entity's motion has been below sleep threshold. */
  sleepFrames: Uint16Array;
  /** Entities marked for deferred removal (flushed after physics step). */
  deferredRemovals: string[] = [];
  /** When true, remove() defers instead of executing immediately. */
  deferringRemovals = false;

  constructor(capacity = INITIAL_CAPACITY) {
    this.capacity = capacity;
    this.data = new Float64Array(capacity * STRIDE);
    this.prevPositions = new Float64Array(capacity * 3);
    this.motion = new Float64Array(capacity);
    this.sleepFrames = new Uint16Array(capacity);
    this.meta = new Array(capacity).fill(null);
  }

  /** Allocate a slot for a new entity. Returns the slot index. */
  add(
    id: string,
    type: EntityMeta["type"],
    group: string,
    mask: string[],
    vertices: number[] | undefined,
    numerics: {
      x?: number; y?: number; w?: number; h?: number; angle?: number;
      color?: [number, number, number, number];
      vx?: number; vy?: number; ax?: number; ay?: number;
      mass?: number; restitution?: number; friction?: number; damping?: number;
      moveX?: number | null; moveY?: number | null;
      visible?: boolean; physics?: boolean; fixed?: boolean;
      z?: number;
      uv?: [number, number, number, number];
      d?: number; rx?: number; ry?: number; vz?: number; az?: number;
    },
  ): number {
    if (this.count >= this.capacity) this.grow();

    const slot = this.count++;
    const base = slot * STRIDE;

    // Zero everything, then set defaults
    this.data.fill(0, base, base + STRIDE);
    const d = this.data;
    d[base + F_W] = numerics.w ?? 1;
    d[base + F_H] = numerics.h ?? 1;
    d[base + F_X] = numerics.x ?? 0;
    d[base + F_Y] = numerics.y ?? 0;
    d[base + F_ANGLE] = numerics.angle ?? 0;

    const c = numerics.color ?? [1, 1, 1, 1];
    d[base + F_CR] = c[0]; d[base + F_CG] = c[1];
    d[base + F_CB] = c[2]; d[base + F_CA] = c[3];

    d[base + F_VX] = numerics.vx ?? 0;
    d[base + F_VY] = numerics.vy ?? 0;
    d[base + F_AX] = numerics.ax ?? 0;
    d[base + F_AY] = numerics.ay ?? 0;

    const mass = numerics.mass ?? 1;
    d[base + F_MASS] = mass;
    d[base + F_INV_MASS] = mass === 0 ? 0 : 1 / mass;
    d[base + F_RESTITUTION] = numerics.restitution ?? 0.3;
    d[base + F_FRICTION] = numerics.friction ?? 0.1;
    d[base + F_DAMPING] = numerics.damping ?? -1;  // -1 = use global damping

    d[base + F_MOVE_X] = numerics.moveX != null ? numerics.moveX : NaN;
    d[base + F_MOVE_Y] = numerics.moveY != null ? numerics.moveY : NaN;

    let flags = 0;
    if (numerics.visible !== false) flags |= FLAG_VISIBLE;
    if (numerics.physics === true) flags |= FLAG_PHYSICS;
    if (numerics.fixed === true) flags |= FLAG_FIXED;
    d[base + F_FLAGS] = flags;

    d[base + F_Z] = numerics.z ?? 0;

    const uv = numerics.uv ?? [0, 0, 1, 1];
    d[base + F_U] = uv[0]; d[base + F_V] = uv[1];
    d[base + F_UW] = uv[2]; d[base + F_UH] = uv[3];

    d[base + F_OPACITY] = 1.0;

    // 3D fields
    d[base + F_D]  = numerics.d  ?? 0;
    d[base + F_RX] = numerics.rx ?? 0;
    d[base + F_RY] = numerics.ry ?? 0;
    d[base + F_VZ] = numerics.vz ?? 0;
    d[base + F_AZ] = numerics.az ?? 0;

    // Initialize prev positions for interpolation
    const pb = slot * 3;
    this.prevPositions[pb]     = d[base + F_X];
    this.prevPositions[pb + 1] = d[base + F_Y];
    this.prevPositions[pb + 2] = d[base + F_Z];

    this.meta[slot] = { id, type, group, mask, vertices, dirty: 0, children: [], worldTransform: null, custom: {} };
    this.idToSlot.set(id, slot);
    this.slotToOrderIdx.set(slot, this.order.length);
    this.order.push(slot);

    return slot;
  }

  /** Flush all deferred removals. Call after physics step completes. */
  flushRemovals(): void {
    this.deferringRemovals = false;
    if (this.deferredRemovals.length === 0) return;
    const ids = this.deferredRemovals.splice(0);
    for (const id of ids) {
      this.remove(id);
    }
  }

  /** Remove by ID. Defers automatically when inside a physics step. */
  remove(id: string): boolean {
    const slot = this.idToSlot.get(id);
    if (slot === undefined) return false;
    if (this.deferringRemovals) {
      this.deferredRemovals.push(id);
      return true;
    }

    // Clean up parent-child relationships
    const meta = this.meta[slot];
    if (meta) {
      // Remove from parent's children list
      if (meta.parent) {
        const parentSlot = this.idToSlot.get(meta.parent);
        if (parentSlot !== undefined) {
          const parentMeta = this.meta[parentSlot];
          if (parentMeta) {
            const idx = parentMeta.children.indexOf(id);
            if (idx !== -1) parentMeta.children.splice(idx, 1);
          }
        }
      }
      // Cascade remove all children (standard scene graph behavior)
      const childrenCopy = meta.children.slice();
      meta.children.length = 0;
      for (const childId of childrenCopy) {
        this.remove(childId);
      }
    }

    const last = this.count - 1;
    this.idToSlot.delete(id);

    // Remove from draw order (swap-and-pop for O(1))
    const orderIdx = this.slotToOrderIdx.get(slot);
    if (orderIdx !== undefined) {
      const lastOrderIdx = this.order.length - 1;
      if (orderIdx !== lastOrderIdx) {
        const movedSlot = this.order[lastOrderIdx];
        this.order[orderIdx] = movedSlot;
        this.slotToOrderIdx.set(movedSlot, orderIdx);
      }
      this.order.pop();
      this.slotToOrderIdx.delete(slot);
      this.zDirty = true; // swap-and-pop may disturb draw order; re-sort next frame
    }

    if (slot !== last) {
      // Copy last entity's data into the vacated slot
      const srcBase = last * STRIDE;
      const dstBase = slot * STRIDE;
      this.data.copyWithin(dstBase, srcBase, srcBase + STRIDE);

      // Copy prev positions + sleep data too
      const srcPrev = last * 3, dstPrev = slot * 3;
      this.prevPositions[dstPrev]     = this.prevPositions[srcPrev];
      this.prevPositions[dstPrev + 1] = this.prevPositions[srcPrev + 1];
      this.prevPositions[dstPrev + 2] = this.prevPositions[srcPrev + 2];
      this.motion[slot] = this.motion[last];
      this.sleepFrames[slot] = this.sleepFrames[last];

      const lastMeta = this.meta[last]!;
      this.meta[slot] = lastMeta;
      this.idToSlot.set(lastMeta.id, slot);

      // Update draw order: the entity that was at `last` is now at `slot`
      const movedOrderIdx = this.slotToOrderIdx.get(last);
      if (movedOrderIdx !== undefined) {
        this.order[movedOrderIdx] = slot;
        this.slotToOrderIdx.set(slot, movedOrderIdx);
        this.slotToOrderIdx.delete(last);
      }
    }

    this.meta[last] = null;
    this.count--;
    return true;
  }

  /** Release an entity to the pool instead of removing it. Returns true if pooled. */
  poolRelease(id: string): boolean {
    const slot = this.idToSlot.get(id);
    if (slot === undefined) return false;
    const meta = this.meta[slot];
    if (!meta) return false;

    const type = meta.type;
    let freeList = this.pool.get(type);
    if (!freeList) { freeList = []; this.pool.set(type, freeList); }

    // If pool is full for this type, truly remove
    if (freeList.length >= EntityStore.POOL_MAX_PER_TYPE) {
      this.remove(id);
      return true;
    }

    // Hide: set POOLED, clear VISIBLE and PHYSICS
    const b = slot * STRIDE;
    this.data[b + F_FLAGS] = (this.data[b + F_FLAGS] | FLAG_POOLED) & ~FLAG_VISIBLE & ~FLAG_PHYSICS;

    // Zero velocities
    this.data[b + F_VX] = 0; this.data[b + F_VY] = 0; this.data[b + F_VZ] = 0;
    this.data[b + F_AX] = 0; this.data[b + F_AY] = 0; this.data[b + F_AZ] = 0;

    // Remove old ID mapping
    this.idToSlot.delete(id);
    freeList.push(slot);
    return true;
  }

  /** Try to acquire a pooled entity of the given type. Returns slot or -1. */
  poolAcquire(type: string, newId: string): number {
    const freeList = this.pool.get(type);
    if (!freeList || freeList.length === 0) return -1;

    const slot = freeList.pop()!;

    // Re-activate: clear POOLED, set VISIBLE
    const b = slot * STRIDE;
    this.data[b + F_FLAGS] = (this.data[b + F_FLAGS] & ~FLAG_POOLED) | FLAG_VISIBLE;

    // Map new ID to this slot
    this.idToSlot.set(newId, slot);
    const meta = this.meta[slot]!;
    meta.id = newId;
    meta.dirty = DIRTY_TRANSFORM | DIRTY_VISUAL;
    meta.custom = {};

    return slot;
  }

  /** Clear all entities. */
  clear(): void {
    this.count = 0;
    this.idToSlot.clear();
    this.order.length = 0;
    this.slotToOrderIdx.clear();
    this.pool.clear();
    this.deferredRemovals.length = 0;
    this.deferringRemovals = false;
  }

  /** Get slot index by ID, or -1 if not found. */
  slot(id: string): number {
    return this.idToSlot.get(id) ?? -1;
  }

  /** Base offset for a slot. */
  base(slot: number): number {
    return slot * STRIDE;
  }

  /** Set parent-child relationship. Maintains children arrays on both old and new parents. */
  setParent(childId: string, parentId: string | undefined): void {
    const childSlot = this.slot(childId);
    if (childSlot === -1) return;
    const childMeta = this.meta[childSlot];
    if (!childMeta) return;

    // Remove from old parent's children list
    if (childMeta.parent) {
      const oldParentSlot = this.slot(childMeta.parent);
      if (oldParentSlot !== -1) {
        const oldParentMeta = this.meta[oldParentSlot];
        if (oldParentMeta) {
          const idx = oldParentMeta.children.indexOf(childId);
          if (idx !== -1) oldParentMeta.children.splice(idx, 1);
        }
      }
    }

    childMeta.parent = parentId;

    // Add to new parent's children list
    if (parentId) {
      const newParentSlot = this.slot(parentId);
      if (newParentSlot !== -1) {
        const newParentMeta = this.meta[newParentSlot];
        if (newParentMeta && !newParentMeta.children.includes(childId)) {
          newParentMeta.children.push(childId);
        }
      }
    }

    // Invalidate world transform for child and all descendants
    this.invalidateWorldTransform(childSlot);
  }

  /** Recursively invalidate cached world transforms (dirty propagation down the tree). */
  invalidateWorldTransform(slot: number): void {
    const meta = this.meta[slot];
    if (!meta) return;
    meta.worldTransform = null;
    meta.dirty |= DIRTY_WORLD;
    for (const childId of meta.children) {
      const cs = this.slot(childId);
      if (cs !== -1) this.invalidateWorldTransform(cs);
    }
  }

  /**
   * Get world transform for a slot: [worldX, worldY, worldAngle, worldZ].
   * Computes from parent chain if not cached. Caches the result.
   */
  getWorldTransform(slot: number): Float64Array {
    const meta = this.meta[slot];
    if (!meta) return _identityWT;
    if (meta.worldTransform) return meta.worldTransform;

    const b = slot * STRIDE;
    const lx = this.data[b + F_X], ly = this.data[b + F_Y];
    const la = this.data[b + F_ANGLE], lz = this.data[b + F_Z];
    const lrx = this.data[b + F_RX], lry = this.data[b + F_RY];

    if (!meta.parent) {
      const wt = new Float64Array(6);
      wt[0] = lx; wt[1] = ly; wt[2] = la; wt[3] = lz;
      wt[4] = lrx; wt[5] = lry;
      meta.worldTransform = wt;
      meta.dirty &= ~DIRTY_WORLD;
      return wt;
    }

    const parentSlot = this.slot(meta.parent);
    if (parentSlot === -1) {
      const wt = new Float64Array(6);
      wt[0] = lx; wt[1] = ly; wt[2] = la; wt[3] = lz;
      wt[4] = lrx; wt[5] = lry;
      meta.worldTransform = wt;
      meta.dirty &= ~DIRTY_WORLD;
      return wt;
    }

    const pwt = this.getWorldTransform(parentSlot);
    const px = pwt[0], py = pwt[1], pa = pwt[2], pz = pwt[3];
    const prx = pwt[4], pry = pwt[5];
    const DEG = Math.PI / 180;

    // Full 3D rotation: R = Rz * Rx * Ry (matching mat4Model order)
    const cZ = Math.cos(pa * DEG), sZ = Math.sin(pa * DEG);
    const cX = Math.cos(prx * DEG), sX = Math.sin(prx * DEG);
    const cY = Math.cos(pry * DEG), sY = Math.sin(pry * DEG);

    // Rotation matrix columns (R = Rz * Rx * Ry)
    const r00 = cZ * cY + sZ * sX * sY;
    const r10 = sZ * cX;
    const r20 = -cZ * sY + sZ * sX * cY;
    const r01 = -sZ * cY + cZ * sX * sY;
    const r11 = cZ * cX;
    const r21 = sZ * sY + cZ * sX * cY;
    const r02 = cX * sY;
    const r12 = -sX;
    const r22 = cX * cY;

    // Build child rotation matrix: R_child = Rz(la) * Rx(lrx) * Ry(lry)
    const ccZ = Math.cos(la * DEG), scZ = Math.sin(la * DEG);
    const ccX = Math.cos(lrx * DEG), scX = Math.sin(lrx * DEG);
    const ccY = Math.cos(lry * DEG), scY = Math.sin(lry * DEG);
    const c00 = ccZ * ccY + scZ * scX * scY;
    const c10 = scZ * ccX;
    const c20 = -ccZ * scY + scZ * scX * ccY;
    const c01 = -scZ * ccY + ccZ * scX * scY;
    const c11 = ccZ * ccX;
    const c21 = scZ * scY + ccZ * scX * ccY;
    const c02 = ccX * scY;
    const c12 = -scX;
    const c22 = ccX * ccY;

    // Combined rotation: R_world = R_parent * R_child
    const m10 = r10 * c00 + r11 * c10 + r12 * c20;
    const m11 = r10 * c01 + r11 * c11 + r12 * c21;
    const m12 = r10 * c02 + r11 * c12 + r12 * c22;
    const m02 = r00 * c02 + r01 * c12 + r02 * c22;
    const m22 = r20 * c02 + r21 * c12 + r22 * c22;

    // Extract Euler angles: R = Rz * Rx * Ry → rx = asin(-m12), ry = atan2(m02,m22), rz = atan2(m10,m11)
    const clampedM12 = Math.max(-1, Math.min(1, m12));
    const wrx = Math.asin(-clampedM12) / DEG;
    const wry = Math.atan2(m02, m22) / DEG;
    const wrz = Math.atan2(m10, m11) / DEG;

    const wt = new Float64Array(6);
    wt[0] = px + lx * r00 + ly * r01 + lz * r02;
    wt[1] = py + lx * r10 + ly * r11 + lz * r12;
    wt[2] = wrz;
    wt[3] = pz + lx * r20 + ly * r21 + lz * r22;
    wt[4] = wrx;
    wt[5] = wry;
    meta.worldTransform = wt;
    meta.dirty &= ~DIRTY_WORLD;
    return wt;
  }

  /** Recursively set visibility on all children of the given slot. */
  setChildrenVisible(slot: number, visible: boolean): void {
    const meta = this.meta[slot];
    if (!meta) return;
    for (const childId of meta.children) {
      const cs = this.slot(childId);
      if (cs === -1) continue;
      if (visible) this.data[cs * STRIDE + F_FLAGS] |= FLAG_VISIBLE;
      else this.data[cs * STRIDE + F_FLAGS] &= ~FLAG_VISIBLE;
      const childMeta = this.meta[cs];
      if (childMeta) childMeta.dirty |= DIRTY_VISUAL;
      this.setChildrenVisible(cs, visible);
    }
  }

  /**
   * Lerp positions in-place for rendering. Call before drawing.
   * Overwrites data[F_X/F_Y/F_Z] with interpolated values and
   * stashes the real physics positions into prevPositions.
   */
  applyInterpolation(skipSlot = -1): void {
    const d = this.data, p = this.prevPositions;
    const alpha = this.interpolationAlpha;
    const oneMinusAlpha = 1 - alpha;
    for (let i = 0; i < this.count; i++) {
      const b = i * STRIDE, pb = i * 3;
      const cx = d[b + F_X], cy = d[b + F_Y], cz = d[b + F_Z];
      // Skip interpolation for the camera-follow entity so it stays
      // at its raw physics position (matching what the camera reads)
      if (i !== skipSlot) {
        d[b + F_X] = p[pb]     * oneMinusAlpha + cx * alpha;
        d[b + F_Y] = p[pb + 1] * oneMinusAlpha + cy * alpha;
        d[b + F_Z] = p[pb + 2] * oneMinusAlpha + cz * alpha;
      }
      // Stash physics positions in prevPositions temporarily
      p[pb]     = cx;
      p[pb + 1] = cy;
      p[pb + 2] = cz;
    }
  }

  /** Restore physics positions after rendering. Call after drawing. */
  restoreFromInterpolation(): void {
    const d = this.data, p = this.prevPositions;
    for (let i = 0; i < this.count; i++) {
      const b = i * STRIDE, pb = i * 3;
      // Restore real physics positions from where applyInterpolation stashed them
      d[b + F_X] = p[pb];
      d[b + F_Y] = p[pb + 1];
      d[b + F_Z] = p[pb + 2];
    }
  }

  /** Double the capacity. */
  private grow(): void {
    this.capacity *= 2;
    const newData = new Float64Array(this.capacity * STRIDE);
    newData.set(this.data);
    this.data = newData;
    const newPrev = new Float64Array(this.capacity * 3);
    newPrev.set(this.prevPositions);
    this.prevPositions = newPrev;
    const newMotion = new Float64Array(this.capacity);
    newMotion.set(this.motion);
    this.motion = newMotion;
    const newSleep = new Uint16Array(this.capacity);
    newSleep.set(this.sleepFrames);
    this.sleepFrames = newSleep;
    this.meta.length = this.capacity;
  }
}

const _identityWT = new Float64Array(6);
