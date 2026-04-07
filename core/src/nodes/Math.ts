import { Node, Context } from "./Node.js";
import { resolve, onResolverDestroy } from "../Resolver.js";

// ── Seeded PRNG (mulberry32) ─────────────────────────────────────────────────
let _seed: number | null = null;

// Reset seed when resolver is destroyed so a fresh resolver starts unseeded
onResolverDestroy(() => { _seed = null; });

function seededRandom(): number {
  let t = (_seed = (_seed! + 0x6D2B79F5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function hashString(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return h;
}

/**
 * Handles math operations.
 *
 * Supported operations:
 * - { "add": [a, b, ...] }          -> sum of all values
 * - { "subtract": [a, b] }          -> a - b
 * - { "multiply": [a, b, ...] }     -> product of all values
 * - { "divide": [a, b] }            -> a / b
 * - { "mod": [a, b] }               -> a % b (modulo)
 * - { "power": [base, exp] }        -> base ^ exp
 * - { "sqrt": value }               -> square root
 * - { "abs": value }                -> absolute value
 * - { "round": value }              -> round to nearest integer
 * - { "floor": value }              -> round down
 * - { "ceil": value }               -> round up
 * - { "min": [a, b, ...] }          -> minimum value
 * - { "max": [a, b, ...] }          -> maximum value
 * - { "sum": array }                -> sum of array
 * - { "avg": array }                -> average of array
 * - { "random": [min, max] }        -> random number in range (seeded if randomSeed was called)
 * - { "randomSeed": seed }          -> seed the PRNG (string or number); null to unseed
 * - { "clamp": [value, min, max] }  -> clamp value to range
 * - { "toFixed": [value, decimals] } -> format to fixed decimals
 * - { "parseInt": value }           -> parse as integer
 * - { "parseFloat": value }         -> parse as float
 * - { "sin": degrees }              -> sine (input in degrees)
 * - { "cos": degrees }              -> cosine (input in degrees)
 * - { "atan2": [y, x] }            -> arctangent in degrees
 */
export class MathNode extends Node {
  async sqrt(d: Record<string, unknown>, c: Context) {
    return Math.sqrt(this.toNumber(await resolve(d.sqrt, c)));
  }
  async abs(d: Record<string, unknown>, c: Context) {
    return Math.abs(this.toNumber(await resolve(d.abs, c)));
  }
  async round(d: Record<string, unknown>, c: Context) {
    return Math.round(this.toNumber(await resolve(d.round, c)));
  }
  async floor(d: Record<string, unknown>, c: Context) {
    return Math.floor(this.toNumber(await resolve(d.floor, c)));
  }
  async ceil(d: Record<string, unknown>, c: Context) {
    return Math.ceil(this.toNumber(await resolve(d.ceil, c)));
  }
  async parseInt(d: Record<string, unknown>, c: Context) {
    return globalThis.parseInt(this.toString(await resolve(d.parseInt, c)), 10) || 0;
  }
  async parseFloat(d: Record<string, unknown>, c: Context) {
    return globalThis.parseFloat(this.toString(await resolve(d.parseFloat, c))) || 0;
  }

  async add(def: Record<string, unknown>, context: Context): Promise<number> {
    const values = this.toArray(def.add);
    let sum = 0;
    for (const v of values) {
      sum += this.toNumber(await resolve(v, context));
    }
    return sum;
  }

  async subtract(def: Record<string, unknown>, context: Context): Promise<number> {
    const values = this.toArray(def.subtract);
    if (values.length === 0) return 0;
    if (values.length === 1)
      return -this.toNumber(await resolve(values[0], context));

    let result = this.toNumber(await resolve(values[0], context));
    for (let i = 1; i < values.length; i++) {
      result -= this.toNumber(await resolve(values[i], context));
    }
    return result;
  }

  async multiply(def: Record<string, unknown>, context: Context): Promise<number> {
    const values = this.toArray(def.multiply);
    let product = 1;
    for (const v of values) {
      product *= this.toNumber(await resolve(v, context));
    }
    return product;
  }

  async divide(def: Record<string, unknown>, context: Context): Promise<number> {
    const values = this.toArray(def.divide);
    if (values.length < 2) return 0;

    const dividend = this.toNumber(await resolve(values[0], context));
    const divisor = this.toNumber(await resolve(values[1], context));

    if (divisor === 0) return 0;
    return dividend / divisor;
  }

  async mod(def: Record<string, unknown>, context: Context): Promise<number> {
    const values = this.toArray(def.mod);
    if (values.length < 2) return 0;

    const a = this.toNumber(await resolve(values[0], context));
    const b = this.toNumber(await resolve(values[1], context));

    if (b === 0) return 0;
    return a % b;
  }

  async power(def: Record<string, unknown>, context: Context): Promise<number> {
    const values = this.toArray(def.power);
    if (values.length < 2) return 0;

    const base = this.toNumber(await resolve(values[0], context));
    const exp = this.toNumber(await resolve(values[1], context));

    return Math.pow(base, exp);
  }

  async min(def: Record<string, unknown>, context: Context): Promise<number> {
    const values = this.toArray(def.min);
    const numbers: number[] = [];
    for (const v of values) {
      numbers.push(this.toNumber(await resolve(v, context)));
    }
    return numbers.length > 0 ? Math.min(...numbers) : 0;
  }

  async max(def: Record<string, unknown>, context: Context): Promise<number> {
    const values = this.toArray(def.max);
    const numbers: number[] = [];
    for (const v of values) {
      numbers.push(this.toNumber(await resolve(v, context)));
    }
    return numbers.length > 0 ? Math.max(...numbers) : 0;
  }

  async sum(def: Record<string, unknown>, context: Context): Promise<number> {
    const arr = this.toArray(await resolve(def.sum, context));
    return arr.reduce((sum: number, v) => sum + this.toNumber(v), 0);
  }

  async avg(def: Record<string, unknown>, context: Context): Promise<number> {
    const arr = this.toArray(await resolve(def.avg, context));
    if (arr.length === 0) return 0;
    const sum = arr.reduce((s: number, v) => s + this.toNumber(v), 0);
    return sum / arr.length;
  }

  async randomSeed(def: Record<string, unknown>, context: Context): Promise<null> {
    const val = await resolve(def.randomSeed, context);
    if (val == null) { _seed = null; return null; }
    _seed = typeof val === "number" ? val : hashString(String(val));
    return null;
  }

  async random(def: Record<string, unknown>, context: Context): Promise<number> {
    const values = this.toArray(def.random);
    const rng = _seed !== null ? seededRandom : Math.random;
    if (values.length === 0) return rng();

    const min = this.toNumber(await resolve(values[0], context));
    const max =
      values.length > 1 ? this.toNumber(await resolve(values[1], context)) : min;

    return Math.floor(rng() * (max - min + 1)) + min;
  }

  async clamp(def: Record<string, unknown>, context: Context): Promise<number> {
    const values = this.toArray(def.clamp);
    if (values.length < 3) return 0;

    const value = this.toNumber(await resolve(values[0], context));
    const min = this.toNumber(await resolve(values[1], context));
    const max = this.toNumber(await resolve(values[2], context));

    return Math.max(min, Math.min(max, value));
  }

  async sin(d: Record<string, unknown>, c: Context) {
    return Math.sin(this.toNumber(await resolve(d.sin, c)) * Math.PI / 180);
  }
  async cos(d: Record<string, unknown>, c: Context) {
    return Math.cos(this.toNumber(await resolve(d.cos, c)) * Math.PI / 180);
  }
  async atan2(def: Record<string, unknown>, context: Context): Promise<number> {
    const values = this.toArray(def.atan2);
    if (values.length < 2) return 0;
    const y = this.toNumber(await resolve(values[0], context));
    const x = this.toNumber(await resolve(values[1], context));
    return Math.atan2(y, x) * 180 / Math.PI;
  }

  async toFixed(def: Record<string, unknown>, context: Context): Promise<string> {
    const values = this.toArray(def.toFixed);
    const value = this.toNumber(await resolve(values[0], context));
    const decimals =
      values.length > 1 ? this.toNumber(await resolve(values[1], context)) : 2;
    return value.toFixed(Math.max(0, Math.min(20, decimals)));
  }
}
