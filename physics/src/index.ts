// ── Entity Store ──
export {
  EntityStore, type EntityMeta,
  STRIDE, FIELD_OFFSETS,
  F_X, F_Y, F_W, F_H, F_ANGLE,
  F_CR, F_CG, F_CB, F_CA,
  F_VX, F_VY, F_AX, F_AY,
  F_MASS, F_INV_MASS, F_RESTITUTION, F_FRICTION, F_DAMPING,
  F_MOVE_X, F_MOVE_Y, F_FLAGS,
  F_Z, F_U, F_V, F_UW, F_UH, F_OPACITY,
  F_D, F_RX, F_RY, F_VZ, F_AZ,
  FLAG_VISIBLE, FLAG_PHYSICS, FLAG_FIXED, FLAG_POOLED, FLAG_SLEEPING, FLAG_TRIGGER, FLAG_CCD,
  DIRTY_TRANSFORM, DIRTY_VISUAL, DIRTY_TEXT, DIRTY_Z, DIRTY_WORLD,
} from "./EntityStore.js";

// ── Entity Node ──
export { EntityNode } from "./EntityNode.js";

// ── Physics ──
export {
  PhysicsNode, CollisionNode, JointNode,
  physicsStep, applyImpulse, wakeBody,
  type Contact, type PhysicsConfig, type Constraint, type ConstraintType,
  FIXED_DT,
} from "./Physics.js";

// ── Raycast ──
export { rayAABB, raycastStore, type RayHit } from "./Raycast.js";

// ── Vector ──
export {
  VectorNode,
  type Vec, type Vec2, type Vec3,
  toVec, toVec2, toVec3,
  distance, lerp, toward, normalize, direction, cross, dot, dot3,
} from "./Vector.js";
