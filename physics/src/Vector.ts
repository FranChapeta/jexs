import { Node, Context, NodeValue, resolve } from "@jexs/core";

export type Vec = { x: number; y: number; z?: number };
/** @deprecated Use Vec with optional z */
export type Vec2 = Vec;
/** @deprecated Use Vec with z */
export type Vec3 = { x: number; y: number; z: number };

// ── Core helpers ────────────────────────────────────────────────────────

export function toVec(value: unknown): Vec {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.x === "number" && typeof obj.y === "number") {
      const v: Vec = { x: obj.x, y: obj.y };
      if (typeof obj.z === "number") v.z = obj.z;
      return v;
    }
  }
  throw new Error(`Expected {x, y[, z]}, got ${JSON.stringify(value)}`);
}

/** @deprecated Use toVec */
export const toVec2 = toVec;

export function toVec3(value: unknown): Vec3 {
  const v = toVec(value);
  return { x: v.x, y: v.y, z: v.z ?? 0 };
}

function has3d(a: Vec, b?: Vec): boolean {
  return a.z !== undefined || (b !== undefined && b.z !== undefined);
}

function Z(v: Vec): number { return v.z ?? 0; }

function zero3d(use3d: boolean): Vec {
  return use3d ? { x: 0, y: 0, z: 0 } : { x: 0, y: 0 };
}

// ── Pure math (2D/3D unified) ───────────────────────────────────────────

export function distance(a: Vec, b: Vec): number {
  const dx = b.x - a.x, dy = b.y - a.y, dz = Z(b) - Z(a);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function lerp(a: Vec, b: Vec, t: number): Vec {
  const r: Vec = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  if (has3d(a, b)) r.z = Z(a) + (Z(b) - Z(a)) * t;
  return r;
}

export function toward(a: Vec, b: Vec, maxDist: number): Vec {
  const dx = b.x - a.x, dy = b.y - a.y, dz = Z(b) - Z(a);
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist <= maxDist || dist === 0) {
    const r: Vec = { x: b.x, y: b.y };
    if (has3d(a, b)) r.z = Z(b);
    return r;
  }
  const s = maxDist / dist;
  const r: Vec = { x: a.x + dx * s, y: a.y + dy * s };
  if (has3d(a, b)) r.z = Z(a) + dz * s;
  return r;
}

export function normalize(v: Vec): Vec {
  const vz = Z(v);
  const len = Math.sqrt(v.x * v.x + v.y * v.y + vz * vz);
  if (len === 0) return zero3d(v.z !== undefined);
  const r: Vec = { x: v.x / len, y: v.y / len };
  if (v.z !== undefined) r.z = vz / len;
  return r;
}

export function direction(a: Vec, b: Vec): Vec {
  const d: Vec = { x: b.x - a.x, y: b.y - a.y };
  if (has3d(a, b)) d.z = Z(b) - Z(a);
  return normalize(d);
}

export function cross(a: Vec, b: Vec): Vec3 {
  const az = Z(a), bz = Z(b);
  return {
    x: a.y * bz - az * b.y,
    y: az * b.x - a.x * bz,
    z: a.x * b.y - a.y * b.x,
  };
}

export function dot(a: Vec, b: Vec): number {
  return a.x * b.x + a.y * b.y + Z(a) * Z(b);
}

/** @deprecated Use dot */
export const dot3 = dot;

// ── JSON handlers ──────────────────────────────────────────────────────

/**
 * Vector math for 2D and 3D space.
 *
 * All operations auto-detect dimensionality: pass {x, y} for 2D,
 * {x, y, z} for 3D. If either input has z, the result includes z.
 *
 * Supported operations:
 * - { "v-distance": [a, b] }          -> Euclidean distance
 * - { "v-lerp": [a, b, t] }           -> linear interpolation
 * - { "v-toward": [a, b, maxDist] }   -> move toward at constant speed
 * - { "v-normalize": point }           -> unit direction vector
 * - { "v-scale": [point, scalar] }     -> multiply vector by scalar
 * - { "v-add": [a, b] }               -> vector addition
 * - { "v-sub": [a, b] }               -> vector subtraction
 * - { "v-direction": [from, to] }      -> unit vector from a toward b
 * - { "v-cross": [a, b] }             -> cross product (always returns z)
 * - { "v-dot": [a, b] }               -> dot product (scalar)
 */
export class VectorNode extends Node {
  /**
   * Returns the Euclidean distance between two vectors. Pass `[a, b]`.
   * @example
   * { "v-distance": [{ "var": "$a" }, { "var": "$b" }] }
   */
  ["v-distance"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["v-distance"], context, args => {
      const a = this.toArray(args);
      if (a.length < 2) return 0;
      return distance(toVec(a[0]), toVec(a[1]));
    });
  }

  /**
   * Linearly interpolates between two vectors. Pass `[a, b, t]` where `t` is 0–1.
   * @example
   * { "v-lerp": [{ "var": "$from" }, { "var": "$to" }, 0.1] }
   */
  ["v-lerp"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["v-lerp"], context, args => {
      const a = this.toArray(args);
      if (a.length < 3) return { x: 0, y: 0 };
      return lerp(toVec(a[0]), toVec(a[1]), this.toNumber(a[2])) as unknown as NodeValue;
    });
  }

  /**
   * Moves vector `a` toward `b` by at most `maxDist`. Returns `b` if already within range. Pass `[a, b, maxDist]`.
   * @example
   * { "v-toward": [{ "var": "$pos" }, { "var": "$target" }, 5] }
   */
  ["v-toward"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["v-toward"], context, args => {
      const a = this.toArray(args);
      if (a.length < 3) return { x: 0, y: 0 };
      return toward(toVec(a[0]), toVec(a[1]), this.toNumber(a[2])) as unknown as NodeValue;
    });
  }

  /** Returns the unit vector (length 1) in the same direction. Works in 2D and 3D. */
  ["v-normalize"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["v-normalize"], context, v => normalize(toVec(v)) as unknown as NodeValue);
  }

  /** Multiplies a vector by a scalar. Pass `[vector, scalar]`. Works in 2D and 3D. */
  ["v-scale"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["v-scale"], context, args => {
      const a = this.toArray(args);
      if (a.length < 2) return { x: 0, y: 0 };
      const v = toVec(a[0]), s = this.toNumber(a[1]);
      const r: Vec = { x: v.x * s, y: v.y * s };
      if (v.z !== undefined) r.z = v.z * s;
      return r as unknown as NodeValue;
    });
  }

  /** Adds two vectors component-wise. Pass `[a, b]`. Works in 2D and 3D. */
  ["v-add"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["v-add"], context, args => {
      const a = this.toArray(args);
      if (a.length < 2) return { x: 0, y: 0 };
      const va = toVec(a[0]), vb = toVec(a[1]);
      const r: Vec = { x: va.x + vb.x, y: va.y + vb.y };
      if (has3d(va, vb)) r.z = Z(va) + Z(vb);
      return r as unknown as NodeValue;
    });
  }

  /** Subtracts vector `b` from `a`. Pass `[a, b]`. Works in 2D and 3D. */
  ["v-sub"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["v-sub"], context, args => {
      const a = this.toArray(args);
      if (a.length < 2) return { x: 0, y: 0 };
      const va = toVec(a[0]), vb = toVec(a[1]);
      const r: Vec = { x: va.x - vb.x, y: va.y - vb.y };
      if (has3d(va, vb)) r.z = Z(va) - Z(vb);
      return r as unknown as NodeValue;
    });
  }

  /** Returns the unit vector from `a` pointing toward `b`. Pass `[from, to]`. */
  ["v-direction"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["v-direction"], context, args => {
      const a = this.toArray(args);
      if (a.length < 2) return { x: 0, y: 0 };
      return direction(toVec(a[0]), toVec(a[1])) as unknown as NodeValue;
    });
  }

  /** Returns the cross product of two vectors as a 3D vector. Pass `[a, b]`. */
  ["v-cross"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["v-cross"], context, args => {
      const a = this.toArray(args);
      if (a.length < 2) return { x: 0, y: 0, z: 0 };
      return cross(toVec3(a[0]), toVec3(a[1])) as unknown as NodeValue;
    });
  }

  /** Returns the scalar dot product of two vectors. Pass `[a, b]`. Works in 2D and 3D. */
  ["v-dot"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["v-dot"], context, args => {
      const a = this.toArray(args);
      if (a.length < 2) return 0;
      return dot(toVec(a[0]), toVec(a[1]));
    });
  }
}
