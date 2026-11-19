import { Node, Context, NodeValue } from "./Node.js";
import { resolveAll } from "../Resolver.js";
import { operands } from "../helpers.js";
import type { JexsNodeSchema, JexsPropertySchema } from "../schema.js";

/** A vector: `[x, y]` or `[x, y, z]` in space, or one of any length, such as an embedding. */
export type Vec = number[];

/** The lengths a vector may have: one length, or a list of them. */
export type VecDims = number | readonly number[];

/** The lengths of a point in space, `[x, y]` or `[x, y, z]`. */
export const SPACE_DIMS: readonly number[] = [2, 3];

function describeDims(dims: VecDims | undefined): string {
  if (dims === undefined) return "a vector of numbers";
  const list = typeof dims === "number" ? [dims] : dims;
  return `a vector of ${list.length > 1 ? `${list.slice(0, -1).join(", ")} or ${list[list.length - 1]}` : list[0]} numbers`;
}

/** `value` as a vector, of one of the lengths in `dims` when given. */
export function toVec(value: unknown, dims?: VecDims): Vec {
  if (Array.isArray(value) && value.length > 0 && value.every(n => typeof n === "number")) {
    if (dims === undefined || (typeof dims === "number" ? value.length === dims : dims.includes(value.length))) return value;
    throw new Error(`Expected ${describeDims(dims)}, got one of ${value.length}`);
  }
  const shown = JSON.stringify(value) ?? String(value);
  throw new Error(`Expected ${describeDims(dims)}, got ${shown.length > 80 ? `${shown.slice(0, 80)}...` : shown}`);
}

/** Component `i` of `v`, 0 past its end, so a 2D vector meets a 3D one at z = 0. */
function at(v: Vec, i: number): number {
  return v[i] ?? 0;
}

/** A vector as long as the longer of `a` and `b`, each component from `f`. */
function each(a: Vec, b: Vec, f: (i: number) => number): Vec {
  const out = new Array<number>(Math.max(a.length, b.length));
  for (let i = 0; i < out.length; i++) out[i] = f(i);
  return out;
}

function sub(a: Vec, b: Vec): Vec {
  return each(a, b, i => at(a, i) - at(b, i));
}

function distance(a: Vec, b: Vec): number {
  let sum = 0;
  for (let i = 0, n = Math.max(a.length, b.length); i < n; i++) {
    const d = at(b, i) - at(a, i);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function lerp(a: Vec, b: Vec, t: number): Vec {
  return each(a, b, i => at(a, i) + (at(b, i) - at(a, i)) * t);
}

function normalize(v: Vec): Vec {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const len = Math.sqrt(sum);
  return v.map(c => len === 0 ? 0 : c / len);
}

/** A resolved `dims` sibling, checked: undefined when the step gives none. */
function dimsOf(raw: unknown): VecDims | undefined {
  if (raw === undefined || raw === null) return undefined;
  const isLength = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;
  if (isLength(raw)) return raw;
  if (Array.isArray(raw) && raw.length > 0 && raw.every(isLength)) return raw;
  throw new Error(`dims takes a vector length or a list of them, got ${JSON.stringify(raw)}`);
}

/** The first two operands as vectors of one length, or a 2D and a 3D one, which meet at z = 0. */
function pair(args: unknown[], rawDims: unknown): [Vec, Vec] {
  const dims = dimsOf(rawDims);
  const a = toVec(args[0], dims), b = toVec(args[1], dims);
  if (a.length !== b.length && !(SPACE_DIMS.includes(a.length) && SPACE_DIMS.includes(b.length))) {
    throw new Error(`Expected vectors of one length, got ${a.length} and ${b.length}: only a 2D vector meets a 3D one, at z = 0`);
  }
  return [a, b];
}

const vec = (description: string): JexsPropertySchema => ({ $ref: "#/$defs/_vec", description });

export class VectorNode extends Node {
  static schemaDefs = {
    _vec: {
      type: "array",
      items: { $ref: "#/$defs/numOrExpr" },
      minItems: 1,
      description: "A vector: an array of numbers, `[x, y]` or `[x, y, z]` in space, or one of any length, such as an embedding. Two vectors in one op have the same length, except that a 2D one meets a 3D one at `z = 0`.",
    },
  };

  static commonSiblings: Record<string, JexsPropertySchema> = {
    dims: {
      type: ["number", "array"],
      items: { type: "number" },
      description: "The lengths the vectors may have: one length, or a list of them (`[2, 3]` for points in space, `1536` for the embeddings of one model). A vector of another length throws.",
    },
  };

  static schema: JexsNodeSchema = {
    vectorDistance: {
      tuple: 2,
      prefixItems: [vec("First vector `a`."), vec("Second vector `b`.")],
      output: "number",
      markdownDescription: "Returns the Euclidean distance between two vectors. Pass `[a, b]`.",
      examples: [
        "{ \"$vectorDistance\": [{ \"$var\": \"a\" }, { \"$var\": \"b\" }] }",
      ],
    },
    vectorLerp: {
      tuple: 3,
      prefixItems: [
        vec("Start vector `a`."),
        vec("End vector `b`."),
        { type: "number", description: "Interpolation fraction `t` (0-1)." },
      ],
      output: { $ref: "#/$defs/_vec" },
      markdownDescription: "Linearly interpolates between two vectors. Pass `[a, b, t]` where `t` is 0-1.",
      examples: [
        "{ \"$vectorLerp\": [{ \"$var\": \"from\" }, { \"$var\": \"to\" }, 0.1] }",
      ],
    },
    vectorToward: {
      tuple: 3,
      prefixItems: [
        vec("The starting vector `a`."),
        vec("The target vector `b`."),
        { type: "number", description: "Maximum distance to move toward `b`." },
      ],
      output: { $ref: "#/$defs/_vec" },
      markdownDescription: "Moves vector `a` toward `b` by at most `maxDist`. Returns `b` if already within range. Pass `[a, b, maxDist]`.",
      examples: [
        "{ \"$vectorToward\": [{ \"$var\": \"pos\" }, { \"$var\": \"target\" }, 5] }",
      ],
    },
    vectorNormalize: {
      $ref: "#/$defs/_vec",
      output: { $ref: "#/$defs/_vec" },
      markdownDescription: "Returns the unit vector (length 1) in the same direction, or zeros for a zero vector.",
      examples: [
        "{ \"$vectorNormalize\": [3, 4] }",
      ],
    },
    vectorScale: {
      tuple: 2,
      prefixItems: [
        vec("The vector to scale."),
        { type: "number", description: "The scalar multiplier." },
      ],
      output: { $ref: "#/$defs/_vec" },
      markdownDescription: "Multiplies a vector by a scalar. Pass `[vector, scalar]`.",
    },
    vectorAdd: {
      tuple: 2,
      prefixItems: [vec("First vector `a`."), vec("Second vector `b`.")],
      output: { $ref: "#/$defs/_vec" },
      markdownDescription: "Adds two vectors component-wise. Pass `[a, b]`.",
      examples: [
        "{ \"$vectorAdd\": [{ \"$entityGet\": \"player\", \"prop\": \"translation\" }, [0, 10, 0]] }",
      ],
    },
    vectorSub: {
      tuple: 2,
      prefixItems: [vec("The minuend vector `a`."), vec("The subtrahend vector `b`.")],
      output: { $ref: "#/$defs/_vec" },
      markdownDescription: "Subtracts vector `b` from `a`. Pass `[a, b]`.",
    },
    vectorDirection: {
      tuple: 2,
      prefixItems: [vec("The `from` vector."), vec("The `to` vector.")],
      output: { $ref: "#/$defs/_vec" },
      markdownDescription: "Returns the unit vector from `a` pointing toward `b`. Pass `[from, to]`.",
    },
    vectorCross: {
      tuple: 2,
      prefixItems: [vec("First vector `a`, 2D or 3D."), vec("Second vector `b`, 2D or 3D.")],
      output: { $ref: "#/$defs/_vec" },
      markdownDescription: "Returns the cross product of two vectors as a 3D vector (a 2D one has `z = 0`). Pass `[a, b]`. Only 2D and 3D vectors have one, so a longer vector throws.",
    },
    vectorDot: {
      tuple: 2,
      prefixItems: [vec("First vector `a`."), vec("Second vector `b`.")],
      output: "number",
      markdownDescription: "Returns the scalar dot product of two vectors. Pass `[a, b]`.\n\nFor unit vectors it is their cosine similarity, which is how to score an embedding against a query: most embedding APIs return unit vectors, and `$vectorNormalize` makes one of any other once, when it is stored. Pass `dims` with the model's length, so an embedding from another model throws rather than scoring.",
      examples: [
        "{ \"$vectorDot\": [{ \"$var\": \"a\" }, { \"$var\": \"b\" }] }",
        "{ \"$map\": { \"$var\": \"chunks\" }, \"item\": \"chunk\", \"do\": { \"text\": { \"$var\": \"chunk.text\" }, \"score\": { \"$vectorDot\": [{ \"$var\": \"chunk.embedding\" }, { \"$var\": \"query\" }], \"dims\": 1536 } } }",
      ],
    },
  };

  vectorDistance(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$vectorDistance, def.dims], context, ([args, dims]) =>
      distance(...pair(operands("vectorDistance", args, 2), dims)));
  }

  vectorLerp(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$vectorLerp, def.dims], context, ([args, dims]) => {
      const a = operands("vectorLerp", args, 3);
      return lerp(...pair(a, dims), this.toNumber(a[2]));
    });
  }

  vectorToward(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$vectorToward, def.dims], context, ([args, dims]) => {
      const a = operands("vectorToward", args, 3);
      const [from, to] = pair(a, dims), maxDist = this.toNumber(a[2]);
      const dist = distance(from, to);
      return dist <= maxDist || dist === 0 ? each(from, to, i => at(to, i)) : lerp(from, to, maxDist / dist);
    });
  }

  vectorNormalize(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$vectorNormalize, def.dims], context, ([v, dims]) => normalize(toVec(v, dimsOf(dims))));
  }

  vectorScale(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$vectorScale, def.dims], context, ([args, dims]) => {
      const a = operands("vectorScale", args, 2);
      const s = this.toNumber(a[1]);
      return toVec(a[0], dimsOf(dims)).map(c => c * s);
    });
  }

  vectorAdd(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$vectorAdd, def.dims], context, ([args, dims]) => {
      const [a, b] = pair(operands("vectorAdd", args, 2), dims);
      return each(a, b, i => at(a, i) + at(b, i));
    });
  }

  vectorSub(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$vectorSub, def.dims], context, ([args, dims]) =>
      sub(...pair(operands("vectorSub", args, 2), dims)));
  }

  vectorDirection(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$vectorDirection, def.dims], context, ([args, dims]) => {
      const [from, to] = pair(operands("vectorDirection", args, 2), dims);
      return normalize(sub(to, from));
    });
  }

  vectorCross(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$vectorCross, def.dims], context, ([args, dims]) => {
      const [a, b] = pair(operands("vectorCross", args, 2), dims);
      if (a.length > 3) throw new Error("vectorCross takes 2D or 3D vectors: only they have a cross product");
      const [ax, ay, az] = [at(a, 0), at(a, 1), at(a, 2)];
      const [bx, by, bz] = [at(b, 0), at(b, 1), at(b, 2)];
      return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
    });
  }

  vectorDot(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$vectorDot, def.dims], context, ([args, dims]) => {
      const [a, b] = pair(operands("vectorDot", args, 2), dims);
      let sum = 0;
      for (let i = 0, n = Math.min(a.length, b.length); i < n; i++) sum += a[i] * b[i];
      return sum;
    });
  }
}
