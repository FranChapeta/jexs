/**
 * Position-Based Dynamics (PBD) constraint solver.
 *
 * Supports distance, spring, and hinge constraints between entity pairs.
 */

import {
  EntityStore,
  STRIDE,
  F_X, F_Y, F_VX, F_VY, F_INV_MASS, F_ANGLE,
} from "./EntityStore.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ConstraintType = "distance" | "spring" | "hinge";

export interface Constraint {
  id: string;
  type: ConstraintType;
  entityA: string;
  entityB: string;
  restLength: number;
  stiffness: number;
  damping: number;
  anchorA: [number, number];
  anchorB: [number, number];
  /** For hinge: min angle (degrees). NaN = unconstrained. */
  minAngle: number;
  /** For hinge: max angle (degrees). NaN = unconstrained. */
  maxAngle: number;
}

// ─── Solver ─────────────────────────────────────────────────────────────────

/** Number of PBD iterations for constraint solving. */
const CONSTRAINT_ITERATIONS = 4;

/**
 * Solve all constraints using Position-Based Dynamics (PBD).
 * Iterates multiple times for convergence.
 */
export function solveConstraints(store: EntityStore, constraints: Constraint[], dt: number): void {
  if (constraints.length === 0) return;
  const d = store.data;

  // Purge constraints referencing destroyed entities (auto-cleanup)
  for (let i = constraints.length - 1; i >= 0; i--) {
    if (store.slot(constraints[i].entityA) === -1 || store.slot(constraints[i].entityB) === -1) {
      constraints.splice(i, 1);
    }
  }

  for (let iter = 0; iter < CONSTRAINT_ITERATIONS; iter++) {
    for (let ci = 0; ci < constraints.length; ci++) {
      const c = constraints[ci];
      const slotA = store.slot(c.entityA), slotB = store.slot(c.entityB);
      if (slotA === -1 || slotB === -1) continue;
      const ba = slotA * STRIDE, bb = slotB * STRIDE;
      const invA = d[ba + F_INV_MASS], invB = d[bb + F_INV_MASS];
      const totalInv = invA + invB;
      if (totalInv === 0) continue;

      const axW = d[ba + F_X] + c.anchorA[0];
      const ayW = d[ba + F_Y] + c.anchorA[1];
      const bxW = d[bb + F_X] + c.anchorB[0];
      const byW = d[bb + F_Y] + c.anchorB[1];

      const dx = bxW - axW;
      const dy = byW - ayW;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (c.type === "distance") {
        if (dist < 1e-6) continue;
        const diff = (dist - c.restLength) / dist;
        const px = dx * diff / totalInv;
        const py = dy * diff / totalInv;
        d[ba + F_X] += px * invA;
        d[ba + F_Y] += py * invA;
        d[bb + F_X] -= px * invB;
        d[bb + F_Y] -= py * invB;
      } else if (c.type === "spring") {
        if (dist < 1e-6) continue;
        const nx = dx / dist, ny = dy / dist;
        const displacement = dist - c.restLength;

        const relVx = d[bb + F_VX] - d[ba + F_VX];
        const relVy = d[bb + F_VY] - d[ba + F_VY];
        const relVn = relVx * nx + relVy * ny;

        const force = c.stiffness * displacement + c.damping * relVn;
        const fx = nx * force * dt;
        const fy = ny * force * dt;

        d[ba + F_VX] += fx * invA;
        d[ba + F_VY] += fy * invA;
        d[bb + F_VX] -= fx * invB;
        d[bb + F_VY] -= fy * invB;
      } else if (c.type === "hinge") {
        if (dist > 1e-6) {
          const px = dx / totalInv;
          const py = dy / totalInv;
          d[ba + F_X] += px * invA;
          d[ba + F_Y] += py * invA;
          d[bb + F_X] -= px * invB;
          d[bb + F_Y] -= py * invB;
        }

        // Angular limits (if set)
        if (c.minAngle === c.minAngle && c.maxAngle === c.maxAngle) { // not NaN
          const angleA = d[ba + F_ANGLE];
          const angleB = d[bb + F_ANGLE];
          let relAngle = angleB - angleA;
          while (relAngle > 180) relAngle -= 360;
          while (relAngle < -180) relAngle += 360;

          if (relAngle < c.minAngle) {
            const correction = (c.minAngle - relAngle) / totalInv;
            d[ba + F_ANGLE] -= correction * invA;
            d[bb + F_ANGLE] += correction * invB;
          } else if (relAngle > c.maxAngle) {
            const correction = (relAngle - c.maxAngle) / totalInv;
            d[ba + F_ANGLE] += correction * invA;
            d[bb + F_ANGLE] -= correction * invB;
          }
        }
      }
    }
  }
}
