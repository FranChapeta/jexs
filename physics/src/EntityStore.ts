/**
 * Struct-of-arrays entity storage backed by Float64Array.
 *
 * Numeric fields are packed into a single interleaved Float64Array
 * (stride = 33 floats per entity). Non-numeric metadata (id, type,
 * group, mask, vertices) lives in a parallel JS array.
 *
 * Transform layout (offsets 0-9) matches GLTF node format:
 *   translation[3], scale[3], rotation quaternion[4]
 *
 * Removal uses swap-and-pop for O(1) dense iteration.
 * Draw order is tracked in a separate index array.
 */

import type { MeshEntry } from "./Mesh.js";

// ─── Field offsets within the stride ─────────────────────────────────────────

export const STRIDE = 33;

// Transform (contiguous, matches GLTF node order)
export const F_TX = 0, F_TY = 1, F_TZ = 2;           // translation
export const F_SX = 3, F_SY = 4, F_SZ = 5;           // scale
export const F_QX = 6, F_QY = 7, F_QZ = 8, F_QW = 9; // rotation quaternion

// Visual
export const F_CR = 10, F_CG = 11, F_CB = 12, F_CA = 13;

// Motion
export const F_VX = 14, F_VY = 15, F_VZ = 16;
export const F_AX = 17, F_AY = 18, F_AZ = 19;

// Physics
export const F_MASS = 20, F_INV_MASS = 21, F_RESTITUTION = 22, F_FRICTION = 23;
export const F_MOVE_X = 24, F_MOVE_Y = 25;
export const F_FLAGS = 26;

// UV / misc
export const F_U = 27, F_V = 28, F_UW = 29, F_UH = 30;
export const F_OPACITY = 31;
export const F_DAMPING = 32;

export const FLAG_VISIBLE = 1;
export const FLAG_PHYSICS = 2;
export const FLAG_FIXED = 4;
export const FLAG_POOLED = 8;
export const FLAG_SLEEPING = 16;
export const FLAG_TRIGGER = 32;
export const FLAG_CCD = 64;

// ─── Per-entity dirty bitmask ───────────────────────────────────────────────

export const DIRTY_TRANSFORM = 1;  // translation, scale, rotation
export const DIRTY_VISUAL    = 2;  // color, texture, opacity, uv
export const DIRTY_TEXT      = 4;  // text content changed, needs texture re-render
export const DIRTY_Z         = 8;  // z changed, needs re-sort
export const DIRTY_WORLD     = 16; // world transform needs recompute (parent chain changed)

/** Name → offset map for property access by string key */
export const FIELD_OFFSETS: Record<string, number> = {
  tx: F_TX, ty: F_TY, tz: F_TZ,
  sx: F_SX, sy: F_SY, sz: F_SZ,
  qx: F_QX, qy: F_QY, qz: F_QZ, qw: F_QW,
  vx: F_VX, vy: F_VY, vz: F_VZ,
  ax: F_AX, ay: F_AY, az: F_AZ,
  mass: F_MASS, invMass: F_INV_MASS,
  restitution: F_RESTITUTION, friction: F_FRICTION, damping: F_DAMPING,
  u: F_U, v: F_V, uW: F_UW, uH: F_UH,
  opacity: F_OPACITY,
};

// ─── Metadata side table ─────────────────────────────────────────────────────

export interface EntityMeta {
  id: string;
  type: "quad" | "triangle" | "points" | "circle" | "line" | "line-strip" | "sphere" | "cylinder" | "cone" | "light" | "ramp" | "pivot" | "mesh";
  group: string;
  mask: string[];
  vertices?: number[];
  /** Reference into `EntityStore.meshes` (registered via MeshNode `register-mesh`). */
  meshId?: string | null;
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
  /**
   * Cached world transform: [wtx, wty, wtz, wsx, wsy, wsz, wqx, wqy, wqz, wqw].
   * Null = needs recompute.
   */
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
    /** Set when `font` names a registered MSDF font: render via the GL MSDF path
     *  (per frame, crisp at any scale) instead of a one-shot canvas texture. */
    msdf?: { font: string; size: number };
  };
}

// ─── EntityStore ─────────────────────────────────────────────────────────────

const INITIAL_CAPACITY = 64;

// ─── Packed collision metadata (SAB-refactor) ────────────────────────────────
// Collision filtering + shape dispatch read these per-slot typed arrays instead
// of the `meta` objects, so the physics step can run with no object access
// (and, in shared mode, on a worker over shared memory).

/** Shape enum packed per slot for narrowphase dispatch. */
export const SHAPE_RECT = 0;
export const SHAPE_CIRCLE = 1;
export const SHAPE_RAMP = 2;
export const SHAPE_MESH = 3;

/** Max distinct collision groups: each group is one bit of a 32-bit mask. */
export const MAX_GROUPS = 32;

/**
 * Hard ceiling for a SharedArrayBuffer-backed store. A growable SAB reserves
 * address space up to its maxByteLength, so this bounds the reservation; the
 * non-shared store has no such cap (it reallocs on demand).
 */
const MAX_CAPACITY = 1 << 17; // 131072 entities

// Growable SharedArrayBuffer (ES2024) — minimal ambient types until the build
// target's lib includes them. Scoped to what this module uses.
declare global {
  interface SharedArrayBuffer {
    grow(newByteLength: number): void;
    readonly growable: boolean;
  }
  interface SharedArrayBufferConstructor {
    new (byteLength: number, options?: { maxByteLength?: number }): SharedArrayBuffer;
  }
}

/** The shared backing buffers, one per per-slot typed array (shared mode only). */
interface SharedSabs {
  data: SharedArrayBuffer; prev: SharedArrayBuffer;
  motion: SharedArrayBuffer; sleep: SharedArrayBuffer;
  group: SharedArrayBuffer; mask: SharedArrayBuffer;
  shape: SharedArrayBuffer; mesh: SharedArrayBuffer;
}

/** Reallocate a typed-array view to a new length, copying contents (non-shared grow). */
function regrow<T extends { set(src: T): void }>(view: T, len: number, Ctor: new (n: number) => T): T {
  const next = new Ctor(len);
  next.set(view);
  return next;
}

/** True when growable SharedArrayBuffer is available (requires cross-origin isolation). */
function supportsGrowableSAB(): boolean {
  if (typeof SharedArrayBuffer === "undefined") return false;
  try {
    const probe = new SharedArrayBuffer(8, { maxByteLength: 16 });
    return typeof probe.grow === "function";
  } catch {
    return false;
  }
}

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

  /**
   * Registered meshes (from GLB/GLTF imports). Keyed by mesh id.
   * Each entry holds whatever is needed by its consumers: GPU upload (`gpu`) for
   * rendering, BVH + positions/indices for collision. Populated via MeshNode `register-mesh`.
   */
  meshes: Map<string, MeshEntry> = new Map();

  /** Previous positions for fixed-timestep interpolation (3 floats per entity: x, y, z). */
  prevPositions: Float64Array;
  /**
   * Interpolated render positions (3 floats per entity: x, y, z) — a MAIN-THREAD
   * render scratch, NOT shared and NEVER touched by the physics worker. The
   * renderer computes the prev↔current blend into this each frame and reads its
   * visible transforms from here, so `data` stays the authoritative physics state
   * (the worker writes `data`; the renderer only reads it). Grows with the store.
   */
  renderPos: Float64Array;
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

  /** True when the numeric buffers are backed by growable SharedArrayBuffers
   *  (cross-thread sharing). Falls back to plain Float64Array when unavailable. */
  readonly shared: boolean;
  /** Bumped whenever the numeric views are re-created (a `grow()`). Consumers
   *  that cache a view of `data` re-acquire it when this changes. */
  bufferGeneration = 0;
  // No separate SAB handles are kept: in shared mode each typed-array view is a
  // length-tracking view over its growable SharedArrayBuffer, so `view.buffer`
  // IS the SAB (used by grow()/getSharedBuffers()).

  // ── Packed collision metadata (one element per slot) ──
  /** Interned group id per slot (0..MAX_GROUPS-1). */
  groupId: Int32Array;
  /** 32-bit bitset of allowed groups per slot (`1<<groupId` of each mask entry). */
  maskBits: Int32Array;
  /** SHAPE_* enum per slot. */
  shapeType: Uint8Array;
  /** Interned mesh id per slot, -1 if none (for mesh-collision dispatch). */
  meshIndex: Int32Array;
  private _groupIds = new Map<string, number>();
  private _meshIds = new Map<string, number>();

  // Grow strategy + capacity ceiling, fixed at construction from `shared` — so
  // grow() doesn't re-branch. Shared: grow each SAB in place (length-tracking
  // views auto-extend), capped at MAX_CAPACITY. Non-shared: realloc+copy, no cap.
  private readonly _maxCap: number;
  private readonly _grow: (cap: number) => void;
  /** The shared backing buffers (shared mode only) — the source of truth handed
   *  to a worker via getSharedBuffers(). Null in non-shared mode. */
  private readonly _sharedBuffers: SharedSabs | null;

  constructor(capacity = INITIAL_CAPACITY, shared = false) {
    this.capacity = capacity;
    this.shared = shared && supportsGrowableSAB();
    if (this.shared) {
      // Growable SABs, captured once here as the single source of truth for both
      // grow() and getSharedBuffers() — no per-call re-derivation from .buffer.
      // Views are length-tracking (no explicit length) so they auto-extend on grow.
      const sab = (bytes: number, max: number) => new SharedArrayBuffer(bytes, { maxByteLength: max });
      const sb: SharedSabs = {
        data: sab(capacity * STRIDE * 8, MAX_CAPACITY * STRIDE * 8),
        prev: sab(capacity * 3 * 8, MAX_CAPACITY * 3 * 8),
        motion: sab(capacity * 8, MAX_CAPACITY * 8),
        sleep: sab(capacity * 2, MAX_CAPACITY * 2),
        group: sab(capacity * 4, MAX_CAPACITY * 4),
        mask: sab(capacity * 4, MAX_CAPACITY * 4),
        shape: sab(capacity, MAX_CAPACITY),
        mesh: sab(capacity * 4, MAX_CAPACITY * 4),
      };
      this._sharedBuffers = sb;
      this.data = new Float64Array(sb.data);
      this.prevPositions = new Float64Array(sb.prev);
      this.renderPos = new Float64Array(capacity * 3); // main-thread scratch, not shared
      this.motion = new Float64Array(sb.motion);
      this.sleepFrames = new Uint16Array(sb.sleep);
      this.groupId = new Int32Array(sb.group);
      this.maskBits = new Int32Array(sb.mask);
      this.shapeType = new Uint8Array(sb.shape);
      this.meshIndex = new Int32Array(sb.mesh);
      this._maxCap = MAX_CAPACITY;
      this._grow = (cap) => {
        sb.data.grow(cap * STRIDE * 8);
        sb.prev.grow(cap * 3 * 8);
        sb.motion.grow(cap * 8);
        sb.sleep.grow(cap * 2);
        sb.group.grow(cap * 4);
        sb.mask.grow(cap * 4);
        sb.shape.grow(cap);
        sb.mesh.grow(cap * 4);
        this.renderPos = regrow(this.renderPos, cap * 3, Float64Array); // non-shared scratch
      };
    } else {
      this.data = new Float64Array(capacity * STRIDE);
      this.prevPositions = new Float64Array(capacity * 3);
      this.renderPos = new Float64Array(capacity * 3);
      this.motion = new Float64Array(capacity);
      this.sleepFrames = new Uint16Array(capacity);
      this.groupId = new Int32Array(capacity);
      this.maskBits = new Int32Array(capacity);
      this.shapeType = new Uint8Array(capacity);
      this.meshIndex = new Int32Array(capacity);
      this._maxCap = Infinity;
      this._grow = (cap) => {
        this.data = regrow(this.data, cap * STRIDE, Float64Array);
        this.prevPositions = regrow(this.prevPositions, cap * 3, Float64Array);
        this.renderPos = regrow(this.renderPos, cap * 3, Float64Array);
        this.motion = regrow(this.motion, cap, Float64Array);
        this.sleepFrames = regrow(this.sleepFrames, cap, Uint16Array);
        this.groupId = regrow(this.groupId, cap, Int32Array);
        this.maskBits = regrow(this.maskBits, cap, Int32Array);
        this.shapeType = regrow(this.shapeType, cap, Uint8Array);
        this.meshIndex = regrow(this.meshIndex, cap, Int32Array);
      };
      this._sharedBuffers = null;
    }
    // meshIndex sentinel is -1 (no mesh); repackCollision() sets each slot on add,
    // so newly grown slots (SAB grows zero-filled) are written before they're read.
    this.meshIndex.fill(-1);
    this.meta = new Array(capacity).fill(null);
  }

  /** Intern a group string into a stable 0-based id (one bit of the mask). */
  private internGroup(group: string): number {
    let id = this._groupIds.get(group);
    if (id === undefined) {
      id = this._groupIds.size;
      if (id >= MAX_GROUPS) throw new Error(`EntityStore: exceeded ${MAX_GROUPS} collision groups`);
      this._groupIds.set(group, id);
    }
    return id;
  }

  /** Intern a mesh id string into a stable 0-based index. */
  private internMesh(meshId: string): number {
    let idx = this._meshIds.get(meshId);
    if (idx === undefined) { idx = this._meshIds.size; this._meshIds.set(meshId, idx); }
    return idx;
  }

  /**
   * Refresh a slot's packed collision arrays from its `meta` (group/mask/type/
   * meshId). Call after `add()` and whenever any of those fields change.
   */
  repackCollision(slot: number): void {
    const m = this.meta[slot];
    if (!m) return;
    this.groupId[slot] = this.internGroup(m.group);
    let bits = 0;
    for (const g of m.mask) bits |= 1 << this.internGroup(g);
    this.maskBits[slot] = bits;
    this.shapeType[slot] =
      m.type === "circle" ? SHAPE_CIRCLE :
      m.type === "ramp"   ? SHAPE_RAMP :
      (m.type === "mesh" && m.meshId) ? SHAPE_MESH : SHAPE_RECT;
    this.meshIndex[slot] = m.meshId ? this.internMesh(m.meshId) : -1;
  }

  /** The shared buffers + layout, for transfer to a physics worker. Null when
   *  not in shared mode. `meta` is intentionally excluded — it stays main-thread. */
  getSharedBuffers(): (SharedSabs & { stride: number; capacity: number }) | null {
    if (!this._sharedBuffers) return null;
    return { ...this._sharedBuffers, stride: STRIDE, capacity: this.capacity };
  }

  /**
   * Build a worker-side EntityStore over the host's shared buffers (no copy).
   * The numeric typed arrays are WINDOWS onto the same SharedArrayBuffers, so
   * `physicsStep` writes transforms/velocities here and the host sees them in
   * place — this store is fully writable for the per-step numeric path.
   *
   * What it does NOT carry: the `meta` objects (empty — `EntityMeta[]` is JS
   * objects, not shareable) and `meshes`, so it is valid only for the meta-free
   * step (non-parented, non-mesh bodies; parenting/mesh stay host-side). And it
   * must not change the POPULATION: do not add/remove/grow on this view —
   * structural changes (which realloc/extend the SAB and move `count`) are owned
   * by the host and marshaled in via `countView`. The host writes structure; the
   * worker writes per-step physics.
   */
  static viewShared(
    bufs: NonNullable<ReturnType<EntityStore["getSharedBuffers"]>>,
    count: number,
  ): EntityStore {
    const s = new EntityStore(1); // minimal; views below replace its buffers
    s.data = new Float64Array(bufs.data);
    s.prevPositions = new Float64Array(bufs.prev);
    s.motion = new Float64Array(bufs.motion);
    s.sleepFrames = new Uint16Array(bufs.sleep);
    s.groupId = new Int32Array(bufs.group);
    s.maskBits = new Int32Array(bufs.mask);
    s.shapeType = new Uint8Array(bufs.shape);
    s.meshIndex = new Int32Array(bufs.mesh);
    s.capacity = bufs.capacity;
    s.count = count;
    s.meta = []; // worker has no meta objects; step path is meta-free
    return s;
  }

  /** Allocate a slot for a new entity. Returns the slot index. */
  add(
    id: string,
    type: EntityMeta["type"],
    group: string,
    mask: string[],
    vertices: number[] | undefined,
    numerics: {
      translation?: [number, number, number];
      scale?: [number, number, number];
      rotation?: [number, number, number, number]; // quaternion [qx,qy,qz,qw]
      color?: [number, number, number, number];
      vx?: number; vy?: number; vz?: number;
      ax?: number; ay?: number; az?: number;
      mass?: number; restitution?: number; friction?: number; damping?: number;
      moveX?: number | null; moveY?: number | null;
      visible?: boolean; physics?: boolean; fixed?: boolean;
      uv?: [number, number, number, number];
    },
  ): number {
    if (this.count >= this.capacity) this.grow();

    const slot = this.count++;
    const base = slot * STRIDE;

    // Zero everything, then set defaults
    this.data.fill(0, base, base + STRIDE);
    const d = this.data;

    const t = numerics.translation ?? [0, 0, 0];
    d[base + F_TX] = t[0]; d[base + F_TY] = t[1]; d[base + F_TZ] = t[2];

    const s = numerics.scale ?? [1, 1, 1];
    d[base + F_SX] = s[0]; d[base + F_SY] = s[1]; d[base + F_SZ] = s[2];

    const q = numerics.rotation ?? [0, 0, 0, 1];
    d[base + F_QX] = q[0]; d[base + F_QY] = q[1]; d[base + F_QZ] = q[2]; d[base + F_QW] = q[3];

    const c = numerics.color ?? [1, 1, 1, 1];
    d[base + F_CR] = c[0]; d[base + F_CG] = c[1];
    d[base + F_CB] = c[2]; d[base + F_CA] = c[3];

    d[base + F_VX] = numerics.vx ?? 0;
    d[base + F_VY] = numerics.vy ?? 0;
    d[base + F_VZ] = numerics.vz ?? 0;
    d[base + F_AX] = numerics.ax ?? 0;
    d[base + F_AY] = numerics.ay ?? 0;
    d[base + F_AZ] = numerics.az ?? 0;

    const mass = numerics.mass ?? 1;
    d[base + F_MASS] = mass;
    d[base + F_INV_MASS] = mass === 0 ? 0 : 1 / mass;
    d[base + F_RESTITUTION] = numerics.restitution ?? 0.3;
    d[base + F_FRICTION] = numerics.friction ?? 0.1;
    d[base + F_DAMPING] = numerics.damping ?? -1;

    d[base + F_MOVE_X] = numerics.moveX != null ? numerics.moveX : NaN;
    d[base + F_MOVE_Y] = numerics.moveY != null ? numerics.moveY : NaN;

    let flags = 0;
    if (numerics.visible !== false) flags |= FLAG_VISIBLE;
    if (numerics.physics === true) flags |= FLAG_PHYSICS;
    if (numerics.fixed === true) flags |= FLAG_FIXED;
    d[base + F_FLAGS] = flags;

    const uv = numerics.uv ?? [0, 0, 1, 1];
    d[base + F_U] = uv[0]; d[base + F_V] = uv[1];
    d[base + F_UW] = uv[2]; d[base + F_UH] = uv[3];

    d[base + F_OPACITY] = 1.0;

    // Initialize prev positions for interpolation
    const pb = slot * 3;
    this.prevPositions[pb]     = t[0];
    this.prevPositions[pb + 1] = t[1];
    this.prevPositions[pb + 2] = t[2];

    this.meta[slot] = { id, type, group, mask, vertices, dirty: 0, children: [], worldTransform: null, custom: {} };
    this.repackCollision(slot);
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
    let slot = this.idToSlot.get(id);
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
      // Re-lookup slot: a child's swap-and-pop may have moved this entity to a
      // different slot (e.g. if this entity was the last in the store and the
      // child's removal swapped it down). Without this re-lookup the subsequent
      // order and data operations would target the now-stale original slot,
      // leaving a ghost entry in store.order and corrupting store.count.
      const movedSlot = this.idToSlot.get(id);
      if (movedSlot === undefined) return true; // removed as a cascade side-effect
      slot = movedSlot;
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
      // Packed collision arrays move with the entity.
      this.groupId[slot] = this.groupId[last];
      this.maskBits[slot] = this.maskBits[last];
      this.shapeType[slot] = this.shapeType[last];
      this.meshIndex[slot] = this.meshIndex[last];

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
   * Get world transform for a slot: [wtx, wty, wtz, wsx, wsy, wsz, wqx, wqy, wqz, wqw].
   * Computes from parent chain if not cached. Caches the result.
   */
  getWorldTransform(slot: number, interpolated = false): Float64Array {
    const meta = this.meta[slot];
    if (!meta) return _identityWT;
    // Raw path caches into meta.worldTransform (invalidated on mutation). The
    // interpolated path (render only) reads renderPos for translation and is NOT
    // cached — alpha changes every frame — so it returns a fresh transform.
    if (!interpolated && meta.worldTransform) return meta.worldTransform;

    const b = slot * STRIDE, pb = slot * 3;
    // Local translation: from renderPos (interpolated) or data (raw physics).
    const r = interpolated ? this.renderPos : null;
    const lx = r ? r[pb]     : this.data[b + F_TX];
    const ly = r ? r[pb + 1] : this.data[b + F_TY];
    const lz = r ? r[pb + 2] : this.data[b + F_TZ];
    const lsx = this.data[b + F_SX], lsy = this.data[b + F_SY], lsz = this.data[b + F_SZ];
    const lqx = this.data[b + F_QX], lqy = this.data[b + F_QY];
    const lqz = this.data[b + F_QZ], lqw = this.data[b + F_QW];

    if (!meta.parent) {
      const wt = new Float64Array(10);
      wt[0]=lx; wt[1]=ly; wt[2]=lz;
      wt[3]=lsx; wt[4]=lsy; wt[5]=lsz;
      wt[6]=lqx; wt[7]=lqy; wt[8]=lqz; wt[9]=lqw;
      if (interpolated) return wt;
      meta.worldTransform = wt;
      meta.dirty &= ~DIRTY_WORLD;
      return wt;
    }

    const parentSlot = this.slot(meta.parent);
    if (parentSlot === -1) {
      const wt = new Float64Array(10);
      wt[0]=lx; wt[1]=ly; wt[2]=lz;
      wt[3]=lsx; wt[4]=lsy; wt[5]=lsz;
      wt[6]=lqx; wt[7]=lqy; wt[8]=lqz; wt[9]=lqw;
      if (interpolated) return wt;
      meta.worldTransform = wt;
      meta.dirty &= ~DIRTY_WORLD;
      return wt;
    }

    const pwt = this.getWorldTransform(parentSlot, interpolated);
    const px = pwt[0], py = pwt[1], pz = pwt[2];
    const psx = pwt[3], psy = pwt[4], psz = pwt[5];
    const pqx = pwt[6], pqy = pwt[7], pqz = pwt[8], pqw = pwt[9];

    // World scale: component-wise multiply
    const wsx = psx * lsx, wsy = psy * lsy, wsz = psz * lsz;

    // Scale local translation by parent world scale, then rotate by parent world quaternion
    const slx = psx * lx, sly = psy * ly, slz = psz * lz;
    const x2=pqx+pqx, y2=pqy+pqy, z2=pqz+pqz;
    const xx=pqx*x2, xy=pqx*y2, xz=pqx*z2;
    const yy=pqy*y2, yz=pqy*z2, zz=pqz*z2;
    const wx=pqw*x2, wy=pqw*y2, wz=pqw*z2;
    const wtx = px + (1-yy-zz)*slx + (xy-wz)*sly + (xz+wy)*slz;
    const wty = py + (xy+wz)*slx + (1-xx-zz)*sly + (yz-wx)*slz;
    const wtz = pz + (xz-wy)*slx + (yz+wx)*sly + (1-xx-yy)*slz;

    // World rotation: Hamilton product (parent * child)
    const wqx = pqw*lqx + pqx*lqw + pqy*lqz - pqz*lqy;
    const wqy = pqw*lqy - pqx*lqz + pqy*lqw + pqz*lqx;
    const wqz = pqw*lqz + pqx*lqy - pqy*lqx + pqz*lqw;
    const wqw = pqw*lqw - pqx*lqx - pqy*lqy - pqz*lqz;

    const wt = new Float64Array(10);
    wt[0]=wtx; wt[1]=wty; wt[2]=wtz;
    wt[3]=wsx; wt[4]=wsy; wt[5]=wsz;
    wt[6]=wqx; wt[7]=wqy; wt[8]=wqz; wt[9]=wqw;
    if (interpolated) return wt;
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
   * Compute interpolated RENDER positions into `renderPos` (read-only over the
   * physics state). Call once per frame before drawing; the renderer then reads
   * visible transforms from `renderPos` while `data` stays the authoritative
   * physics state. NON-MUTATING — never writes `data`/`prevPositions`, so it is
   * safe while a physics worker concurrently writes `data` (the industry-standard
   * separation: simulate in `data`, blend into a render-only buffer).
   *
   * `skipSlot` (the camera-follow entity) renders at its RAW position so camera
   * and entity use the same coordinate and don't jitter against each other.
   */
  computeRenderPositions(skipSlot = -1): void {
    const d = this.data, p = this.prevPositions, r = this.renderPos;
    const alpha = this.interpolationAlpha;
    const oneMinusAlpha = 1 - alpha;
    for (let i = 0; i < this.count; i++) {
      const b = i * STRIDE, pb = i * 3;
      const cx = d[b + F_TX], cy = d[b + F_TY], cz = d[b + F_TZ];
      if (i === skipSlot || alpha >= 1) {
        r[pb] = cx; r[pb + 1] = cy; r[pb + 2] = cz;
      } else {
        r[pb]     = p[pb]     * oneMinusAlpha + cx * alpha;
        r[pb + 1] = p[pb + 1] * oneMinusAlpha + cy * alpha;
        r[pb + 2] = p[pb + 2] * oneMinusAlpha + cz * alpha;
      }
    }
  }

  /**
   * Sort draw order by Z ascending and rebuild the slotToOrderIdx reverse index.
   * Must be called instead of sorting `order` directly — any external sort would
   * leave slotToOrderIdx stale, causing subsequent remove() calls to corrupt order.
   */
  sortByZ(): void {
    const d = this.data;
    if (this.zDirtyCount < 10) {
      // Insertion sort: fast for nearly-sorted arrays (few Z changes per frame)
      for (let i = 1; i < this.order.length; i++) {
        const key = this.order[i];
        const keyZ = d[key * STRIDE + F_TZ];
        let j = i - 1;
        while (j >= 0 && d[this.order[j] * STRIDE + F_TZ] > keyZ) {
          this.order[j + 1] = this.order[j];
          j--;
        }
        this.order[j + 1] = key;
      }
    } else {
      this.order.sort((a, b) => d[a * STRIDE + F_TZ] - d[b * STRIDE + F_TZ]);
    }
    // Rebuild reverse index — the sort changes every entry's position.
    this.slotToOrderIdx.clear();
    for (let i = 0; i < this.order.length; i++) {
      this.slotToOrderIdx.set(this.order[i], i);
    }
    this.zDirty = false;
    this.zDirtyCount = 0;
  }

  /** Double the capacity, applying the grow strategy fixed at construction. */
  private grow(): void {
    const newCap = Math.min(this.capacity * 2, this._maxCap);
    if (newCap <= this.capacity) {
      throw new Error(`EntityStore: capacity cap (${this._maxCap}) reached`);
    }
    this.capacity = newCap;
    this._grow(this.capacity); // shared: grow SABs in place; non-shared: realloc+copy
    this.meta.length = this.capacity;
    // Consumers caching a view of `data` must re-acquire after a grow: in the
    // non-shared path the array identity changed; in the shared path the
    // length-tracking view extended.
    this.bufferGeneration++;
  }
}

const _identityWT = new Float64Array([0,0,0, 1,1,1, 0,0,0,1]);
