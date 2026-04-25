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

export class MathNode extends Node {
  /** Returns the square root of a number. @example { "sqrt": 16 } */
  sqrt(d: Record<string, unknown>, c: Context) {
    return resolve(d.sqrt, c, v => Math.sqrt(this.toNumber(v)));
  }
  /** Returns the absolute value of a number. @example { "abs": -5 } */
  abs(d: Record<string, unknown>, c: Context) {
    return resolve(d.abs, c, v => Math.abs(this.toNumber(v)));
  }
  /** Rounds a number to the nearest integer. @example { "round": 3.6 } */
  round(d: Record<string, unknown>, c: Context) {
    return resolve(d.round, c, v => Math.round(this.toNumber(v)));
  }
  /** Rounds a number down to the nearest integer. @example { "floor": 3.9 } */
  floor(d: Record<string, unknown>, c: Context) {
    return resolve(d.floor, c, v => Math.floor(this.toNumber(v)));
  }
  /** Rounds a number up to the nearest integer. @example { "ceil": 3.1 } */
  ceil(d: Record<string, unknown>, c: Context) {
    return resolve(d.ceil, c, v => Math.ceil(this.toNumber(v)));
  }
  /** Parses a string to an integer (base 10); returns `0` on failure. @example { "parseInt": "42px" } */
  parseInt(d: Record<string, unknown>, c: Context) {
    return resolve(d.parseInt, c, v => globalThis.parseInt(this.toString(v), 10) || 0);
  }
  /** Parses a string to a float; returns `0` on failure. @example { "parseFloat": "3.14rem" } */
  parseFloat(d: Record<string, unknown>, c: Context) {
    return resolve(d.parseFloat, c, v => globalThis.parseFloat(this.toString(v)) || 0);
  }
  /** Sine of an angle in degrees. @example { "sin": 90 } */
  sin(d: Record<string, unknown>, c: Context) {
    return resolve(d.sin, c, v => Math.sin(this.toNumber(v) * Math.PI / 180));
  }
  /** Cosine of an angle in degrees. @example { "cos": 0 } */
  cos(d: Record<string, unknown>, c: Context) {
    return resolve(d.cos, c, v => Math.cos(this.toNumber(v) * Math.PI / 180));
  }

  /**
   * Sums all numbers in an array.
   *
   * @param {number[]} sum Numbers to sum.
   * @example
   * { "sum": [1, 2, 3] }
   */
  sum(def: Record<string, unknown>, c: Context) {
    return resolve(def.sum, c, arr => this.toArray(arr).reduce((s: number, v) => s + this.toNumber(v), 0));
  }

  /**
   * Returns the arithmetic mean of an array of numbers.
   *
   * @param {number[]} avg Numbers to average.
   * @example
   * { "avg": [1, 2, 3] }
   */
  avg(def: Record<string, unknown>, c: Context) {
    return resolve(def.avg, c, arr => {
      const items = this.toArray(arr);
      if (items.length === 0) return 0;
      return items.reduce((s: number, v) => s + this.toNumber(v), 0) / items.length;
    });
  }

  /**
   * Sums two or more numbers.
   *
   * @param {number[]} add Numbers to add together.
   * @example
   * { "add": [{ "var": "$price" }, 10] }
   */
  add(def: Record<string, unknown>, c: Context) {
    return resolve(def.add, c, values =>
      this.toArray(values).reduce((sum: number, v) => sum + this.toNumber(v), 0)
    );
  }

  /**
   * Subtracts subsequent values from the first. Single-element negates.
   *
   * @param {number[]} subtract Numbers: `[a, b, ...]`.
   * @example
   * { "subtract": [10, 3] }
   */
  subtract(def: Record<string, unknown>, c: Context) {
    return resolve(def.subtract, c, values => {
      const arr = this.toArray(values);
      if (arr.length === 0) return 0;
      if (arr.length === 1) return -this.toNumber(arr[0]);
      return arr.slice(1).reduce((acc: number, v) => acc - this.toNumber(v), this.toNumber(arr[0]));
    });
  }

  /**
   * Multiplies two or more numbers.
   *
   * @param {number[]} multiply Numbers to multiply together.
   * @example
   * { "multiply": [{ "var": "$qty" }, { "var": "$price" }] }
   */
  multiply(def: Record<string, unknown>, c: Context) {
    return resolve(def.multiply, c, values =>
      this.toArray(values).reduce((p: number, v) => p * this.toNumber(v), 1)
    );
  }

  /**
   * Divides the first value by the second; returns `0` on division by zero.
   *
   * @param {[2]} divide `[dividend, divisor]`.
   * @example
   * { "divide": [10, 4] }
   */
  divide(def: Record<string, unknown>, c: Context) {
    return resolve(def.divide, c, values => {
      const arr = this.toArray(values);
      if (arr.length < 2) return 0;
      const divisor = this.toNumber(arr[1]);
      return divisor === 0 ? 0 : this.toNumber(arr[0]) / divisor;
    });
  }

  /**
   * Remainder of `a % b`; returns `0` if `b` is zero.
   *
   * @param {[2]} mod `[a, b]`.
   * @example
   * { "mod": [10, 3] }
   */
  mod(def: Record<string, unknown>, c: Context) {
    return resolve(def.mod, c, values => {
      const arr = this.toArray(values);
      if (arr.length < 2) return 0;
      const b = this.toNumber(arr[1]);
      return b === 0 ? 0 : this.toNumber(arr[0]) % b;
    });
  }

  /**
   * Raises `base` to `exponent`.
   *
   * @param {[2]} power `[base, exponent]`.
   * @example
   * { "power": [2, 10] }
   */
  power(def: Record<string, unknown>, c: Context) {
    return resolve(def.power, c, values => {
      const arr = this.toArray(values);
      if (arr.length < 2) return 0;
      return Math.pow(this.toNumber(arr[0]), this.toNumber(arr[1]));
    });
  }

  /**
   * Returns the smallest number in an array.
   *
   * @param {number[]} min Numbers to compare.
   * @example
   * { "min": [3, 1, 4, 1, 5] }
   */
  min(def: Record<string, unknown>, c: Context) {
    return resolve(def.min, c, values => {
      const nums = this.toArray(values).map(v => this.toNumber(v));
      return nums.length > 0 ? Math.min(...nums) : 0;
    });
  }

  /**
   * Returns the largest number in an array.
   *
   * @param {number[]} max Numbers to compare.
   * @example
   * { "max": [3, 1, 4, 1, 5] }
   */
  max(def: Record<string, unknown>, c: Context) {
    return resolve(def.max, c, values => {
      const nums = this.toArray(values).map(v => this.toNumber(v));
      return nums.length > 0 ? Math.max(...nums) : 0;
    });
  }

  /**
   * Clamps a value between min and max.
   *
   * @param {[3]} clamp `[value, min, max]`.
   * @example
   * { "clamp": [{ "var": "$health" }, 0, 100] }
   */
  clamp(def: Record<string, unknown>, c: Context) {
    return resolve(def.clamp, c, values => {
      const arr = this.toArray(values);
      if (arr.length < 3) return 0;
      return Math.max(this.toNumber(arr[1]), Math.min(this.toNumber(arr[2]), this.toNumber(arr[0])));
    });
  }

  /**
   * Formats a number to a fixed number of decimal places (default 2).
   *
   * @param {[1,2]} toFixed `[value, decimals?]`.
   * @example
   * { "toFixed": [3.14159, 2] }
   */
  toFixed(def: Record<string, unknown>, c: Context) {
    return resolve(def.toFixed, c, values => {
      const arr = this.toArray(values);
      const value = this.toNumber(arr[0]);
      const decimals = arr.length > 1 ? this.toNumber(arr[1]) : 2;
      return value.toFixed(Math.max(0, Math.min(20, decimals)));
    });
  }

  /**
   * Returns the angle in degrees between the positive x-axis and the point `[y, x]`.
   *
   * @param {[2]} atan2 `[y, x]`.
   * @example
   * { "atan2": [1, 1] }
   */
  atan2(def: Record<string, unknown>, c: Context) {
    return resolve(def.atan2, c, values => {
      const arr = this.toArray(values);
      if (arr.length < 2) return 0;
      return Math.atan2(this.toNumber(arr[0]), this.toNumber(arr[1])) * 180 / Math.PI;
    });
  }

  /**
   * Returns a random number. No args → float `[0, 1)`. One arg → integer `[0, n]`. Two args → integer `[min, max]`.
   * Uses the seeded RNG if `randomSeed` has been called.
   *
   * @param {[0,2]} random `[]`, `[max]`, or `[min, max]`.
   * @example
   * { "random": [1, 6] }
   */
  random(def: Record<string, unknown>, c: Context) {
    return resolve(def.random, c, values => {
      const arr = this.toArray(values);
      const rng = _seed !== null ? seededRandom : Math.random;
      if (arr.length === 0) return rng();
      const min = this.toNumber(arr[0]);
      const max = arr.length > 1 ? this.toNumber(arr[1]) : min;
      return Math.floor(rng() * (max - min + 1)) + min;
    });
  }

  /**
   * Seeds the RNG for reproducible sequences. Pass a number or string; `null` resets to unseeded.
   *
   * @example
   * { "randomSeed": 42 }
   */
  randomSeed(def: Record<string, unknown>, c: Context) {
    return resolve(def.randomSeed, c, val => {
      if (val == null) { _seed = null; return null; }
      _seed = typeof val === "number" ? val : hashString(String(val));
      return null;
    });
  }
}
