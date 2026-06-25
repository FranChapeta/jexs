// ── Entity Store ──
export {
  EntityStore, type EntityMeta,
  STRIDE, FIELD_OFFSETS,
  F_TX, F_TY, F_TZ,
  F_SX, F_SY, F_SZ,
  F_QX, F_QY, F_QZ, F_QW,
  F_CR, F_CG, F_CB, F_CA,
  F_VX, F_VY, F_VZ,
  F_AX, F_AY, F_AZ,
  F_MASS, F_INV_MASS, F_RESTITUTION, F_FRICTION, F_DAMPING,
  F_MOVE_X, F_MOVE_Y, F_FLAGS,
  F_U, F_V, F_UW, F_UH, F_OPACITY,
  FLAG_VISIBLE, FLAG_PHYSICS, FLAG_FIXED, FLAG_POOLED, FLAG_SLEEPING, FLAG_TRIGGER, FLAG_CCD,
  DIRTY_TRANSFORM, DIRTY_VISUAL, DIRTY_TEXT, DIRTY_Z, DIRTY_WORLD,
  SHAPE_RECT, SHAPE_CIRCLE, SHAPE_RAMP, SHAPE_MESH, MAX_GROUPS,
} from "./EntityStore.js";

// ── Entity Node ──
export { EntityNode } from "./nodes/EntityNode.js";

// ── Mesh Import (GLB / GLTF) ──
export { MeshNode, setMeshoptLoader, type MeshoptDecoder } from "./nodes/MeshNode.js";
export type {
  Bounds, MeshMaterial, MeshData, NodeData, Scene, MeshEntry, BVH,
} from "./Mesh.js";
export {
  buildBvh, queryAabb, raycastBvh, rayTriangle, readTriangle, computeBounds,
} from "./Bvh.js";

// ── Physics ──
export {
  PhysicsNode, CollisionNode, JointNode,
  physicsStep, applyImpulse, wakeBody,
  type Contact, type PhysicsConfig, type Constraint, type ConstraintType,
  FIXED_DT,
} from "./nodes/Physics.js";

// ── Raycast ──
export { rayAABB, raycastStore, type RayHit } from "./Raycast.js";

// The generic worker offload (`runOnWorker` / `runWorkerRuntime`) lives in
// @jexs/core. Physics provides only the job (`physicsSetup`) + a thin host helper
// (`offloadWorld`); the env packages provide `makePhysicsWorker`.

// ── Physics worker job (runs on @jexs/core's generic worker runtime) ──
export {
  physicsSetup, offloadWorld,
  makeContactsBuffer, readContacts, CONTACT_STRIDE,
  type WorldOffload, type PhysicsJobBufs,
} from "./sharedPhysics.js";

// ── Vector ──
export {
  VectorNode,
  type Vec, type Vec2, type Vec3,
  toVec, toVec2, toVec3,
  distance, lerp, toward, normalize, direction, cross, dot, dot3,
} from "./nodes/Vector.js";
