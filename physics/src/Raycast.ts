/**
 * Ray-casting primitives and EntityStore ray queries.
 *
 * Lives in core/ so both server (Physics) and client (GL) can use it.
 * No WebGL or rendering dependencies.
 */

import {
  EntityStore,
  STRIDE,
  F_X, F_Y, F_W, F_H, F_Z, F_D, F_FLAGS,
  FLAG_VISIBLE,
} from "./EntityStore.js";

// ─── Ray-AABB intersection ──────────────────────────────────────────────────

/** Ray-AABB intersection (slab method). Returns distance or -1 if no hit. */
export function rayAABB(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): number {
  let tmin = -Infinity, tmax = Infinity;
  if (Math.abs(dx) > 1e-10) {
    let t1 = (minX - ox) / dx, t2 = (maxX - ox) / dx;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
  } else if (ox < minX || ox > maxX) return -1;
  if (Math.abs(dy) > 1e-10) {
    let t1 = (minY - oy) / dy, t2 = (maxY - oy) / dy;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
  } else if (oy < minY || oy > maxY) return -1;
  if (Math.abs(dz) > 1e-10) {
    let t1 = (minZ - oz) / dz, t2 = (maxZ - oz) / dz;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
  } else if (oz < minZ || oz > maxZ) return -1;
  if (tmin > tmax || tmax < 0) return -1;
  return tmin >= 0 ? tmin : tmax;
}

// ─── Store-level ray query ──────────────────────────────────────────────────

export interface RayHit {
  id: string;
  slot: number;
  distance: number;
  point: { x: number; y: number; z: number };
}

// Pre-allocated hits array to reduce GC pressure on frequent raycasts
const _hits: RayHit[] = [];

/**
 * Cast a ray against all visible entities in an EntityStore.
 * Returns hits sorted by distance (nearest first).
 *
 * @param maskGroups - If provided, only entities whose group is in this set are tested.
 */
export function raycastStore(
  store: EntityStore,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maskGroups?: Set<string> | null,
): RayHit[] {
  _hits.length = 0;
  const d = store.data;

  for (let i = 0; i < store.count; i++) {
    const b = i * STRIDE;
    if (!(d[b + F_FLAGS] & FLAG_VISIBLE)) continue;
    const meta = store.meta[i];
    if (!meta) continue;

    if (maskGroups && !maskGroups.has(meta.group)) continue;

    const ex = d[b + F_X], ey = d[b + F_Y], ew = d[b + F_W], eh = d[b + F_H];
    const ez = d[b + F_Z], ed = d[b + F_D] || 0.01;

    const t = rayAABB(ox, oy, oz, dx, dy, dz, ex, ey, ez, ex + ew, ey + eh, ez + ed);
    if (t >= 0) {
      _hits.push({
        id: meta.id,
        slot: i,
        distance: t,
        point: { x: ox + dx * t, y: oy + dy * t, z: oz + dz * t },
      });
    }
  }

  _hits.sort((a, b) => a.distance - b.distance);
  return _hits;
}
