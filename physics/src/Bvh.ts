/**
 * Bounding Volume Hierarchy over triangles.
 *
 * Top-down builder with midpoint split on the longest axis. Flat-array node
 * layout for cache efficiency. Used for collision narrow-phase and raycasting
 * against imported triangle meshes (see physics/src/collision.ts).
 */

import type { BVH, Bounds } from "./Mesh.js";

const LEAF_TRI_LIMIT = 4;
const MAX_DEPTH = 32;

interface BuildNode {
  min: [number, number, number];
  max: [number, number, number];
  isLeaf: boolean;
  start: number; // for leaves
  count: number; // for leaves
  left?: BuildNode;
  right?: BuildNode;
}

/**
 * Build a BVH from a triangle mesh.
 *
 * `positions` is XYZ-flat (3 floats per vertex). `indices` is triangle indices
 * (3 per triangle); pass null/undefined for non-indexed meshes (every 3 verts = 1 triangle).
 */
export function buildBvh(
  positions: Float32Array,
  indices: Uint16Array | Uint32Array | null | undefined,
): BVH {
  const triCount = indices ? indices.length / 3 : positions.length / 9;

  // Compute per-triangle bounds + centroids upfront.
  const triBounds = new Float32Array(triCount * 6); // [minX, minY, minZ, maxX, maxY, maxZ] per tri
  const triCentroids = new Float32Array(triCount * 3);
  const triRefs = new Uint32Array(triCount); // shuffled during build

  for (let t = 0; t < triCount; t++) {
    const i0 = indices ? indices[t * 3] : t * 3;
    const i1 = indices ? indices[t * 3 + 1] : t * 3 + 1;
    const i2 = indices ? indices[t * 3 + 2] : t * 3 + 2;

    const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
    const bx = positions[i1 * 3], by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2];
    const cx = positions[i2 * 3], cy = positions[i2 * 3 + 1], cz = positions[i2 * 3 + 2];

    const minX = Math.min(ax, bx, cx);
    const minY = Math.min(ay, by, cy);
    const minZ = Math.min(az, bz, cz);
    const maxX = Math.max(ax, bx, cx);
    const maxY = Math.max(ay, by, cy);
    const maxZ = Math.max(az, bz, cz);

    triBounds[t * 6]     = minX;
    triBounds[t * 6 + 1] = minY;
    triBounds[t * 6 + 2] = minZ;
    triBounds[t * 6 + 3] = maxX;
    triBounds[t * 6 + 4] = maxY;
    triBounds[t * 6 + 5] = maxZ;

    triCentroids[t * 3]     = (minX + maxX) * 0.5;
    triCentroids[t * 3 + 1] = (minY + maxY) * 0.5;
    triCentroids[t * 3 + 2] = (minZ + maxZ) * 0.5;

    triRefs[t] = t;
  }

  let nodeCount = 0;
  const root = buildNode(triRefs, triBounds, triCentroids, 0, triCount, 0);
  function buildNode(
    refs: Uint32Array,
    bounds: Float32Array,
    centroids: Float32Array,
    start: number,
    end: number,
    depth: number,
  ): BuildNode {
    nodeCount++;
    const count = end - start;

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = start; i < end; i++) {
      const t = refs[i];
      if (bounds[t * 6]     < minX) minX = bounds[t * 6];
      if (bounds[t * 6 + 1] < minY) minY = bounds[t * 6 + 1];
      if (bounds[t * 6 + 2] < minZ) minZ = bounds[t * 6 + 2];
      if (bounds[t * 6 + 3] > maxX) maxX = bounds[t * 6 + 3];
      if (bounds[t * 6 + 4] > maxY) maxY = bounds[t * 6 + 4];
      if (bounds[t * 6 + 5] > maxZ) maxZ = bounds[t * 6 + 5];
    }

    const node: BuildNode = {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      isLeaf: true,
      start, count,
    };

    if (count <= LEAF_TRI_LIMIT || depth >= MAX_DEPTH) return node;

    // Split on longest axis at the midpoint of the centroid range.
    const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
    let axis = 0;
    if (dy > dx && dy >= dz) axis = 1;
    else if (dz > dx && dz > dy) axis = 2;

    let cMin = Infinity, cMax = -Infinity;
    for (let i = start; i < end; i++) {
      const c = centroids[refs[i] * 3 + axis];
      if (c < cMin) cMin = c;
      if (c > cMax) cMax = c;
    }
    if (cMax - cMin < 1e-6) return node; // all centroids coincident → can't split

    const mid = (cMin + cMax) * 0.5;
    let i = start, j = end - 1;
    while (i <= j) {
      if (centroids[refs[i] * 3 + axis] < mid) {
        i++;
      } else {
        const tmp = refs[i]; refs[i] = refs[j]; refs[j] = tmp;
        j--;
      }
    }
    const splitAt = i;
    if (splitAt === start || splitAt === end) {
      // Degenerate split — fall back to median index split.
      const median = (start + end) >> 1;
      node.isLeaf = false;
      node.left  = buildNode(refs, bounds, centroids, start, median, depth + 1);
      node.right = buildNode(refs, bounds, centroids, median, end, depth + 1);
      return node;
    }

    node.isLeaf = false;
    node.left  = buildNode(refs, bounds, centroids, start, splitAt, depth + 1);
    node.right = buildNode(refs, bounds, centroids, splitAt, end, depth + 1);
    return node;
  }

  // Flatten to typed arrays. DFS so left child is always at index parentIdx+1.
  const min = new Float32Array(nodeCount * 3);
  const max = new Float32Array(nodeCount * 3);
  const left = new Int32Array(nodeCount);
  const startArr = new Int32Array(nodeCount);
  const countArr = new Int32Array(nodeCount);

  let writeIdx = 0;
  function flatten(node: BuildNode): number {
    const idx = writeIdx++;
    min[idx * 3]     = node.min[0];
    min[idx * 3 + 1] = node.min[1];
    min[idx * 3 + 2] = node.min[2];
    max[idx * 3]     = node.max[0];
    max[idx * 3 + 1] = node.max[1];
    max[idx * 3 + 2] = node.max[2];

    if (node.isLeaf) {
      left[idx] = -1;
      startArr[idx] = node.start;
      countArr[idx] = node.count;
    } else {
      flatten(node.left!);              // left child = idx + 1
      const rightIdx = flatten(node.right!);
      left[idx] = idx + 1;
      startArr[idx] = rightIdx;         // store right index in `start` for inner nodes
      countArr[idx] = 0;
    }
    return idx;
  }
  flatten(root);

  return { min, max, left, start: startArr, count: countArr, triIndices: triRefs, nodeCount };
}

/** Per-triangle vertex fetch helper. */
export function readTriangle(
  positions: Float32Array,
  indices: Uint16Array | Uint32Array | undefined | null,
  triIdx: number,
  out: Float32Array, // length 9
): void {
  const i0 = indices ? indices[triIdx * 3]     : triIdx * 3;
  const i1 = indices ? indices[triIdx * 3 + 1] : triIdx * 3 + 1;
  const i2 = indices ? indices[triIdx * 3 + 2] : triIdx * 3 + 2;
  out[0] = positions[i0 * 3];     out[1] = positions[i0 * 3 + 1]; out[2] = positions[i0 * 3 + 2];
  out[3] = positions[i1 * 3];     out[4] = positions[i1 * 3 + 1]; out[5] = positions[i1 * 3 + 2];
  out[6] = positions[i2 * 3];     out[7] = positions[i2 * 3 + 1]; out[8] = positions[i2 * 3 + 2];
}

/** AABB-vs-AABB overlap test. */
export function aabbOverlap(
  aMinX: number, aMinY: number, aMinZ: number, aMaxX: number, aMaxY: number, aMaxZ: number,
  bMinX: number, bMinY: number, bMinZ: number, bMaxX: number, bMaxY: number, bMaxZ: number,
): boolean {
  return aMaxX >= bMinX && aMinX <= bMaxX
      && aMaxY >= bMinY && aMinY <= bMaxY
      && aMaxZ >= bMinZ && aMinZ <= bMaxZ;
}

/**
 * Traverse BVH, collecting triangle indices whose AABB overlaps the query AABB.
 * `out` is appended to.
 */
export function queryAabb(
  bvh: BVH,
  qMinX: number, qMinY: number, qMinZ: number,
  qMaxX: number, qMaxY: number, qMaxZ: number,
  out: number[],
): void {
  if (bvh.nodeCount === 0) return;
  const stack: number[] = [0];
  while (stack.length > 0) {
    const idx = stack.pop()!;
    const nMinX = bvh.min[idx * 3],     nMinY = bvh.min[idx * 3 + 1], nMinZ = bvh.min[idx * 3 + 2];
    const nMaxX = bvh.max[idx * 3],     nMaxY = bvh.max[idx * 3 + 1], nMaxZ = bvh.max[idx * 3 + 2];
    if (!aabbOverlap(nMinX, nMinY, nMinZ, nMaxX, nMaxY, nMaxZ, qMinX, qMinY, qMinZ, qMaxX, qMaxY, qMaxZ)) continue;

    if (bvh.left[idx] === -1) {
      // Leaf: emit its triangles.
      const start = bvh.start[idx];
      const count = bvh.count[idx];
      for (let k = 0; k < count; k++) out.push(bvh.triIndices[start + k]);
    } else {
      stack.push(bvh.left[idx]);
      stack.push(bvh.start[idx]); // right child idx stashed in start for inner nodes
    }
  }
}

/**
 * Ray-vs-BVH traversal. Returns the hit triangle index (in `bvh.triIndices` value space)
 * with the smallest `t` along the ray, or -1 if no hit. `outT` receives the hit `t` value.
 */
export function raycastBvh(
  bvh: BVH,
  positions: Float32Array,
  indices: Uint16Array | Uint32Array | undefined | null,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxT: number,
  outT: { t: number },
): number {
  if (bvh.nodeCount === 0) return -1;

  const invDx = dx === 0 ? Infinity : 1 / dx;
  const invDy = dy === 0 ? Infinity : 1 / dy;
  const invDz = dz === 0 ? Infinity : 1 / dz;

  let bestT = maxT;
  let bestTri = -1;
  const tri = new Float32Array(9);

  const stack: number[] = [0];
  while (stack.length > 0) {
    const idx = stack.pop()!;

    // Slab test.
    const nMinX = bvh.min[idx * 3],     nMinY = bvh.min[idx * 3 + 1], nMinZ = bvh.min[idx * 3 + 2];
    const nMaxX = bvh.max[idx * 3],     nMaxY = bvh.max[idx * 3 + 1], nMaxZ = bvh.max[idx * 3 + 2];
    const tx1 = (nMinX - ox) * invDx, tx2 = (nMaxX - ox) * invDx;
    const ty1 = (nMinY - oy) * invDy, ty2 = (nMaxY - oy) * invDy;
    const tz1 = (nMinZ - oz) * invDz, tz2 = (nMaxZ - oz) * invDz;
    const tMin = Math.max(Math.min(tx1, tx2), Math.min(ty1, ty2), Math.min(tz1, tz2));
    const tMax = Math.min(Math.max(tx1, tx2), Math.max(ty1, ty2), Math.max(tz1, tz2));
    if (tMax < 0 || tMin > tMax || tMin > bestT) continue;

    if (bvh.left[idx] === -1) {
      const start = bvh.start[idx];
      const count = bvh.count[idx];
      for (let k = 0; k < count; k++) {
        const triIdx = bvh.triIndices[start + k];
        readTriangle(positions, indices, triIdx, tri);
        const t = rayTriangle(
          ox, oy, oz, dx, dy, dz,
          tri[0], tri[1], tri[2],
          tri[3], tri[4], tri[5],
          tri[6], tri[7], tri[8],
        );
        if (t >= 0 && t < bestT) { bestT = t; bestTri = triIdx; }
      }
    } else {
      stack.push(bvh.left[idx]);
      stack.push(bvh.start[idx]);
    }
  }

  outT.t = bestT;
  return bestTri;
}

/** Möller-Trumbore ray-triangle intersection. Returns hit `t`, or -1 if miss. */
export function rayTriangle(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  v0x: number, v0y: number, v0z: number,
  v1x: number, v1y: number, v1z: number,
  v2x: number, v2y: number, v2z: number,
): number {
  const e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
  const e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-9 && det < 1e-9) return -1;
  const invDet = 1 / det;
  const tx = ox - v0x, ty = oy - v0y, tz = oz - v0z;
  const u = (tx * px + ty * py + tz * pz) * invDet;
  if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * invDet;
  if (v < 0 || u + v > 1) return -1;
  const t = (e2x * qx + e2y * qy + e2z * qz) * invDet;
  return t > 1e-9 ? t : -1;
}

/** Compute AABB of a triangle mesh from raw positions. */
export function computeBounds(positions: Float32Array): Bounds {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}
