/**
 * Ray-casting primitives and EntityStore ray queries.
 *
 * Lives in core/ so both server (Physics) and client (GL) can use it.
 * No WebGL or rendering dependencies.
 */

import {
  EntityStore,
  STRIDE,
  F_TX, F_TY, F_SX, F_SY, F_TZ, F_SZ, F_FLAGS,
  FLAG_VISIBLE,
} from "./EntityStore.js";
import { buildBvh, raycastBvh } from "./Bvh.js";

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

    const ex = d[b + F_TX], ey = d[b + F_TY], ew = d[b + F_SX], eh = d[b + F_SY];
    const ez = d[b + F_TZ], ed = d[b + F_SZ] || 0.01;

    const t = rayAABB(ox, oy, oz, dx, dy, dz, ex, ey, ez, ex + ew, ey + eh, ez + ed);
    if (t < 0) continue;

    // Mesh entity: refine the AABB hit by descending the BVH for an exact triangle hit.
    if (meta.meshId) {
      const entry = store.meshes.get(meta.meshId);
      if (entry && entry.positions) {
        if (!entry.bvh) entry.bvh = buildBvh(entry.positions, entry.indices ?? null);
        const meshOx = ex - entry.bounds.min[0];
        const meshOy = ey - entry.bounds.min[1];
        const meshOz = ez - entry.bounds.min[2];
        // Transform ray into mesh local space (translation only).
        const localOx = ox - meshOx, localOy = oy - meshOy, localOz = oz - meshOz;
        const out = { t: Infinity };
        const triHit = raycastBvh(
          entry.bvh, entry.positions, entry.indices ?? null,
          localOx, localOy, localOz, dx, dy, dz, Infinity, out,
        );
        if (triHit < 0) continue;
        _hits.push({
          id: meta.id, slot: i, distance: out.t,
          point: { x: ox + dx * out.t, y: oy + dy * out.t, z: oz + dz * out.t },
        });
        continue;
      }
    }

    _hits.push({
      id: meta.id,
      slot: i,
      distance: t,
      point: { x: ox + dx * t, y: oy + dy * t, z: oz + dz * t },
    });
  }

  _hits.sort((a, b) => a.distance - b.distance);
  return _hits;
}
