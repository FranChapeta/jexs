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

/**
 * One row to be fed into `entity-add`. The parser emits one row per draw call:
 *  - A glTF node with 0 primitives → 1 pivot row.
 *  - A glTF node with 1 primitive → 1 mesh row.
 *  - A glTF node with N>1 primitives → 1 pivot row + N mesh rows parented to it.
 *
 * Rows are emitted parents-first, so a single `foreach scene.nodes → entity-add`
 * works without recursion.
 */
export interface NodeData {
  id: string;
  parent: string | null;
  type: "mesh" | "pivot";
  /** Local-space transform (relative to parent). */
  translation: [number, number, number];
  rotation: [number, number, number, number]; // quaternion [qx, qy, qz, qw]
  scale: [number, number, number];
  /** Mesh id to draw. Null for pivots. */
  mesh: string | null;
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
  /**
   * Shortest triangle edge length in mesh-local space. Cached during BVH build.
   * Used by Physics.ts to decide when a dynamic body is moving fast enough relative
   * to mesh features that the dynamic-vs-mesh narrowphase needs sub-stepping to
   * avoid tunneling. Undefined until BVH is built.
   */
  minTriEdge?: number;
  /** Cached material URIs (same shape as MeshData.material). */
  material?: MeshMaterial;
  /**
   * GPU upload handle (set by GL during register-mesh).
   * Type-erased here so this file stays env-agnostic; gl/src/gl/types.ts defines `GpuMesh`
   * and casts on read/write.
   */
  gpu?: unknown;
}
