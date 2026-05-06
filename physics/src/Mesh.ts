/**
 * Mesh types for imported geometry (GLB / GLTF).
 *
 * The parser (MeshNode) produces transient `MeshData` and `Scene`. The `register-mesh`
 * step consumes them into `MeshEntry` records stored in `EntityStore.meshes` keyed by id.
 * One entry holds whatever is needed by each consumer:
 *  - `gpu` is set by GL when uploaded as VBO/IBO (opaque handle, type-erased here so
 *     the physics package stays env-agnostic).
 *  - `bvh` + `positions` + `indices` are kept when the mesh is used for collision.
 */

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface MeshMaterial {
  baseColorUri?: string;
  normalUri?: string;
  metallicRoughnessUri?: string;
  occlusionUri?: string;
  emissiveUri?: string;
  baseColorFactor?: [number, number, number, number];
}

/** Transient parser output for a single primitive. Consumed by `register-mesh`. */
export interface MeshData {
  id: string;
  positions: Float32Array;
  normals?: Float32Array;
  uvs?: Float32Array;
  indices?: Uint16Array | Uint32Array;
  bounds: Bounds;
  material?: MeshMaterial;
}

/** A single glTF scene-graph node placement. Consumed by user `entity-add` calls. */
export interface NodeData {
  id: string;
  parentId: string | null;
  /** Local-space transform (relative to parent node). */
  translation: [number, number, number];
  quaternion: [number, number, number, number]; // local quaternion [qx, qy, qz, qw]
  scale: [number, number, number];
  /** World-space transform (local composed with the full parent chain). */
  worldTranslation: [number, number, number];
  worldQuaternion: [number, number, number, number];
  worldScale: [number, number, number];
  meshId: string | null; // null = pivot/group node
}

/** Top-level parser output. */
export interface Scene {
  meshes: Record<string, MeshData>;
  nodes: NodeData[];
}

/** Flat-array BVH over triangles. See physics/src/Bvh.ts for builder + traversal. */
export interface BVH {
  /** Per-node AABB min (3 floats per node). */
  min: Float32Array;
  /** Per-node AABB max (3 floats per node). */
  max: Float32Array;
  /** For inner nodes: index of left child (right = left+1). For leaves: -1. */
  left: Int32Array;
  /** For leaves: start index into `triIndices`. For inner nodes: 0. */
  start: Int32Array;
  /** For leaves: triangle count. For inner nodes: 0. */
  count: Int32Array;
  /** Triangle indices in BVH order. Each entry = triangle index in `indices` (3 vertex indices per triangle). */
  triIndices: Uint32Array;
  /** Total node count. */
  nodeCount: number;
}

/** A registered mesh in `EntityStore.meshes`. */
export interface MeshEntry {
  bounds: Bounds;
  /** CPU geometry — kept when the mesh is used for physics; also read by GL upload. */
  positions?: Float32Array;
  /** Per-vertex normals. Kept for GL upload; not needed by physics narrow-phase. */
  normals?: Float32Array;
  /** Per-vertex texture coords. Kept for GL upload. */
  uvs?: Float32Array;
  /** Triangle indices. If null, positions are non-indexed (every 3 verts = 1 triangle). */
  indices?: Uint16Array | Uint32Array;
  /** Built lazily for collision; shared across all entities referencing this id. */
  bvh?: BVH;
  /** Cached material URIs (same shape as MeshData.material). */
  material?: MeshMaterial;
  /**
   * GPU upload handle (set by GL during register-mesh).
   * Type-erased here so this file stays env-agnostic; gl/src/gl/types.ts defines `GpuMesh`
   * and casts on read/write.
   */
  gpu?: unknown;
}
