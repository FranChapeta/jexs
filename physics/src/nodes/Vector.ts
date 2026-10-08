import { Node, Context, NodeValue, resolve } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";

/** A vector `[x, y]`, or `[x, y, z]` in 3D, laid out as entity translations are. */
export type Vec = number[];

// ── Core helpers ────────────────────────────────────────────────────────

export function toVec(value: unknown): Vec {
  if (Array.isArray(value) && (value.length === 2 || value.length === 3) && value.every(n => typeof n === "number")) {
    return value;
  }
  throw new Error(`Expected [x, y] or [x, y, z], got ${JSON.stringify(value)}`);
}

/** Component `i` of `v`, 0 past its end, so a 2D vector meets a 3D one at z = 0. */
function at(v: Vec, i: number): number {
  return v[i] ?? 0;
}

/** A vector of `a`'s and `b`'s dimension (3 when either is 3D), each component from `f`. */
function each(a: Vec, b: Vec, f: (i: number) => number): Vec {
  return Array.from({ length: Math.max(a.length, b.length) }, (_, i) => f(i));
}

// ── Pure math (2D/3D unified) ───────────────────────────────────────────

export function add(a: Vec, b: Vec): Vec {
  return each(a, b, i => at(a, i) + at(b, i));
}

export function sub(a: Vec, b: Vec): Vec {
  return each(a, b, i => at(a, i) - at(b, i));
}

export function scale(v: Vec, s: number): Vec {
  return v.map(c => c * s);
}

export function distance(a: Vec, b: Vec): number {
  return Math.hypot(...sub(b, a));
}

export function lerp(a: Vec, b: Vec, t: number): Vec {
  return each(a, b, i => at(a, i) + (at(b, i) - at(a, i)) * t);
}

export function toward(a: Vec, b: Vec, maxDist: number): Vec {
  const dist = distance(a, b);
  return dist <= maxDist || dist === 0 ? each(a, b, i => at(b, i)) : lerp(a, b, maxDist / dist);
}

export function normalize(v: Vec): Vec {
  const len = Math.hypot(...v);
  return v.map(c => len === 0 ? 0 : c / len);
}

export function direction(a: Vec, b: Vec): Vec {
  return normalize(sub(b, a));
}

export function cross(a: Vec, b: Vec): Vec {
  const [ax, ay, az] = [at(a, 0), at(a, 1), at(a, 2)];
  const [bx, by, bz] = [at(b, 0), at(b, 1), at(b, 2)];
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

export function dot(a: Vec, b: Vec): number {
  return each(a, b, i => at(a, i) * at(b, i)).reduce((sum, c) => sum + c, 0);
}

// ── JSON handlers ──────────────────────────────────────────────────────

export class VectorNode extends Node {
  static schemaDefs = {
    _vec: {
      type: "array",
      items: { $ref: "#/$defs/numOrExpr" },
      minItems: 2,
      maxItems: 3,
      description: "A vector `[x, y]`, or `[x, y, z]` in 3D. A 2D vector meets a 3D one at `z = 0`.",
    },
  };

  static schema: JexsNodeSchema = {
    "v-distance": {
      tuple: 2,
      prefixItems: [
        { $ref: "#/$defs/_vec", description: "First vector `a`." },
        { $ref: "#/$defs/_vec", description: "Second vector `b`." },
      ],
      output: "number",
      markdownDescription: "Returns the Euclidean distance between two vectors. Pass `[a, b]`.",
      examples: [
        "{ \"$v-distance\": [{ \"$var\": \"a\" }, { \"$var\": \"b\" }] }",
      ],
    },
    "v-lerp": {
      tuple: 3,
      prefixItems: [
        { $ref: "#/$defs/_vec", description: "Start vector `a`." },
        { $ref: "#/$defs/_vec", description: "End vector `b`." },
        { type: "number", description: "Interpolation fraction `t` (0-1)." },
      ],
      output: { $ref: "#/$defs/_vec" },
      markdownDescription: "Linearly interpolates between two vectors. Pass `[a, b, t]` where `t` is 0–1.",
      examples: [
        "{ \"$v-lerp\": [{ \"$var\": \"from\" }, { \"$var\": \"to\" }, 0.1] }",
      ],
    },
    "v-toward": {
      tuple: 3,
      prefixItems: [
        { $ref: "#/$defs/_vec", description: "The starting vector `a`." },
        { $ref: "#/$defs/_vec", description: "The target vector `b`." },
        { type: "number", description: "Maximum distance to move toward `b`." },
      ],
      output: { $ref: "#/$defs/_vec" },
      markdownDescription: "Moves vector `a` toward `b` by at most `maxDist`. Returns `b` if already within range. Pass `[a, b, maxDist]`.",
      examples: [
        "{ \"$v-toward\": [{ \"$var\": \"pos\" }, { \"$var\": \"target\" }, 5] }",
      ],
    },
    "v-normalize": {
      $ref: "#/$defs/_vec",
      output: { $ref: "#/$defs/_vec" },
      markdownDescription: "Returns the unit vector (length 1) in the same direction. Works in 2D and 3D.",
      examples: [
        "{ \"$v-normalize\": [3, 4] }",
      ],
    },
    "v-scale": {
      tuple: 2,
      prefixItems: [
        { $ref: "#/$defs/_vec", description: "The vector to scale." },
        { type: "number", description: "The scalar multiplier." },
      ],
      output: { $ref: "#/$defs/_vec" },
      markdownDescription: "Multiplies a vector by a scalar. Pass `[vector, scalar]`. Works in 2D and 3D.",
    },
    "v-add": {
      tuple: 2,
      prefixItems: [
        { $ref: "#/$defs/_vec", description: "First vector `a`." },
        { $ref: "#/$defs/_vec", description: "Second vector `b`." },
      ],
      output: { $ref: "#/$defs/_vec" },
      markdownDescription: "Adds two vectors component-wise. Pass `[a, b]`. Works in 2D and 3D.",
      examples: [
        "{ \"$v-add\": [{ \"$entity-get\": \"player\", \"prop\": \"translation\" }, [0, 10, 0]] }",
      ],
    },
    "v-sub": {
      tuple: 2,
      prefixItems: [
        { $ref: "#/$defs/_vec", description: "The minuend vector `a`." },
        { $ref: "#/$defs/_vec", description: "The subtrahend vector `b`." },
      ],
      output: { $ref: "#/$defs/_vec" },
      markdownDescription: "Subtracts vector `b` from `a`. Pass `[a, b]`. Works in 2D and 3D.",
    },
    "v-direction": {
      tuple: 2,
      prefixItems: [
        { $ref: "#/$defs/_vec", description: "The `from` vector." },
        { $ref: "#/$defs/_vec", description: "The `to` vector." },
      ],
      output: { $ref: "#/$defs/_vec" },
      markdownDescription: "Returns the unit vector from `a` pointing toward `b`. Pass `[from, to]`.",
    },
    "v-cross": {
      tuple: 2,
      prefixItems: [
        { $ref: "#/$defs/_vec", description: "First vector `a`." },
        { $ref: "#/$defs/_vec", description: "Second vector `b`." },
      ],
      output: { $ref: "#/$defs/_vec" },
      markdownDescription: "Returns the cross product of two vectors as a 3D vector (a 2D one has `z = 0`). Pass `[a, b]`.",
    },
    "v-dot": {
      tuple: 2,
      prefixItems: [
        { $ref: "#/$defs/_vec", description: "First vector `a`." },
        { $ref: "#/$defs/_vec", description: "Second vector `b`." },
      ],
      output: "number",
      markdownDescription: "Returns the scalar dot product of two vectors. Pass `[a, b]`. Works in 2D and 3D.",
    },
  };

  ["v-distance"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["$v-distance"], context, args => {
      const a = this.toArray(args);
      if (a.length < 2) return 0;
      return distance(toVec(a[0]), toVec(a[1]));
    });
  }

  ["v-lerp"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["$v-lerp"], context, args => {
      const a = this.toArray(args);
      if (a.length < 3) return [0, 0];
      return lerp(toVec(a[0]), toVec(a[1]), this.toNumber(a[2]));
    });
  }

  ["v-toward"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["$v-toward"], context, args => {
      const a = this.toArray(args);
      if (a.length < 3) return [0, 0];
      return toward(toVec(a[0]), toVec(a[1]), this.toNumber(a[2]));
    });
  }

  ["v-normalize"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["$v-normalize"], context, v => normalize(toVec(v)));
  }

  ["v-scale"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["$v-scale"], context, args => {
      const a = this.toArray(args);
      if (a.length < 2) return [0, 0];
      return scale(toVec(a[0]), this.toNumber(a[1]));
    });
  }

  ["v-add"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["$v-add"], context, args => {
      const a = this.toArray(args);
      if (a.length < 2) return [0, 0];
      return add(toVec(a[0]), toVec(a[1]));
    });
  }

  ["v-sub"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["$v-sub"], context, args => {
      const a = this.toArray(args);
      if (a.length < 2) return [0, 0];
      return sub(toVec(a[0]), toVec(a[1]));
    });
  }

  ["v-direction"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["$v-direction"], context, args => {
      const a = this.toArray(args);
      if (a.length < 2) return [0, 0];
      return direction(toVec(a[0]), toVec(a[1]));
    });
  }

  ["v-cross"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["$v-cross"], context, args => {
      const a = this.toArray(args);
      if (a.length < 2) return [0, 0, 0];
      return cross(toVec(a[0]), toVec(a[1]));
    });
  }

  ["v-dot"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["$v-dot"], context, args => {
      const a = this.toArray(args);
      if (a.length < 2) return 0;
      return dot(toVec(a[0]), toVec(a[1]));
    });
  }
}
