import { Node, Context } from "./Node.js";
import { resolve, resolveAll } from "../Resolver.js";
import type { JexsNodeSchema } from "../schema.js";

// ── Seeded PRNG (mulberry32) ─────────────────────────────────────────────────
let _seed: number | null = null;

function seededRandom(): number {
  let t = (_seed = (_seed! + 0x6D2B79F5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Next random float in `[0, 1)` — drawn from the seeded RNG when `randomSeed`
 *  is active, otherwise `Math.random`. Shared so other nodes (e.g. ArrayNode's
 *  `shuffle`) draw from the same reproducible stream. */
export function nextRandom(): number {
  return _seed !== null ? seededRandom() : Math.random();
}

function hashString(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return h;
}

// English ordinal suffixes keyed by Intl.PluralRules ordinal category. The
// plural category is locale-aware; the suffix strings themselves are English.
const ORDINAL_SUFFIX: Record<string, string> = {
  one: "st", two: "nd", few: "rd", other: "th",
};

export class MathNode extends Node {
  static schema: JexsNodeSchema = {
    sqrt: {
      output: "number",
      markdownDescription: "Returns the square root of a number.",
      examples: [
        "{ \"sqrt\": 16 }",
      ],
    },
    abs: {
      output: "number",
      markdownDescription: "Returns the absolute value of a number.",
      examples: [
        "{ \"abs\": -5 }",
      ],
    },
    round: {
      output: "number",
      markdownDescription: "Rounds a number to the nearest integer.",
      examples: [
        "{ \"round\": 3.6 }",
      ],
    },
    floor: {
      output: "number",
      markdownDescription: "Rounds a number down to the nearest integer.",
      examples: [
        "{ \"floor\": 3.9 }",
      ],
    },
    ceil: {
      output: "number",
      markdownDescription: "Rounds a number up to the nearest integer.",
      examples: [
        "{ \"ceil\": 3.1 }",
      ],
    },
    parseInt: {
      output: "number",
      markdownDescription: "Parses a string to an integer (base 10); returns `0` on failure.",
      examples: [
        "{ \"parseInt\": \"42px\" }",
      ],
    },
    parseFloat: {
      output: "number",
      markdownDescription: "Parses a string to a float; returns `0` on failure.",
      examples: [
        "{ \"parseFloat\": \"3.14rem\" }",
      ],
    },
    sin: {
      output: "number",
      markdownDescription: "Sine of an angle in degrees.",
      examples: [
        "{ \"sin\": 90 }",
      ],
    },
    cos: {
      output: "number",
      markdownDescription: "Cosine of an angle in degrees.",
      examples: [
        "{ \"cos\": 0 }",
      ],
    },
    tan: {
      output: "number",
      markdownDescription: "Tangent of an angle in degrees.",
      examples: [
        "{ \"tan\": 45 }",
      ],
    },
    asin: {
      output: "number",
      markdownDescription: "Arcsine of a value, returned in degrees. Input outside `[-1, 1]` yields `NaN`.",
      examples: [
        "{ \"asin\": 1 }",
      ],
    },
    acos: {
      output: "number",
      markdownDescription: "Arccosine of a value, returned in degrees. Input outside `[-1, 1]` yields `NaN`.",
      examples: [
        "{ \"acos\": 0 }",
      ],
    },
    atan: {
      output: "number",
      markdownDescription: "Arctangent of a value, returned in degrees. For a two-argument form use `atan2`.",
      examples: [
        "{ \"atan\": 1 }",
      ],
    },
    log: {
      output: "number",
      markdownDescription: "Natural logarithm (base `e`) of a number.",
      examples: [
        "{ \"log\": 2.718281828 }",
      ],
    },
    log2: {
      output: "number",
      markdownDescription: "Base-2 logarithm of a number.",
      examples: [
        "{ \"log2\": 8 }",
      ],
    },
    log10: {
      output: "number",
      markdownDescription: "Base-10 logarithm of a number.",
      examples: [
        "{ \"log10\": 1000 }",
      ],
    },
    exp: {
      output: "number",
      markdownDescription: "Returns `e` raised to the given power.",
      examples: [
        "{ \"exp\": 1 }",
      ],
    },
    sign: {
      output: "number",
      markdownDescription: "Sign of a number: `-1`, `0`, or `1`.",
      examples: [
        "{ \"sign\": -42 }",
      ],
    },
    trunc: {
      output: "number",
      markdownDescription: "Removes the fractional part of a number, truncating toward zero.",
      examples: [
        "{ \"trunc\": -3.9 }",
      ],
    },
    hypot: {
      type: "array",
      items: {
        type: "number",
      },
      output: "number",
      markdownDescription: "Euclidean norm: the square root of the sum of squares of an array of numbers.",
      examples: [
        "{ \"hypot\": [3, 4] }",
      ],
    },
    lerp: {
      tuple: 3,
      prefixItems: [
        { type: "number", description: "Start value (`a`), returned when `t` is 0." },
        { type: "number", description: "End value (`b`), returned when `t` is 1." },
        { type: "number", description: "Interpolation fraction `t` (0-1; extrapolates outside)." },
      ],
      output: "number",
      markdownDescription: "Linear interpolation between `a` and `b` by fraction `t`: `a + (b - a) * t`. Tuple form `[a, b, t]`. Extrapolates when `t` is outside `[0, 1]`.",
      examples: [
        "{ \"lerp\": [0, 100, 0.5] }",
      ],
    },
    mapRange: {
      tuple: 5,
      prefixItems: [
        { type: "number", description: "The input value to remap." },
        { type: "number", description: "Lower bound of the input range." },
        { type: "number", description: "Upper bound of the input range." },
        { type: "number", description: "Lower bound of the output range." },
        { type: "number", description: "Upper bound of the output range." },
      ],
      output: "number",
      markdownDescription: "Linearly remaps a value from one range to another: `[value, inMin, inMax, outMin, outMax]`. Extrapolates by default; set `clampToRange: true` to bound the result to `[outMin, outMax]`. When `inMin === inMax` it returns `outMin`.",
      examples: [
        "{ \"mapRange\": [5, 0, 10, 0, 100] }",
        "{ \"mapRange\": [15, 0, 10, 0, 100], \"clampToRange\": true }",
      ],
      siblings: {
        clampToRange: {
          type: "boolean",
          description: "Clamp the result to `[outMin, outMax]` instead of extrapolating (default `false`). Named to avoid colliding with the `clamp` op.",
        },
      },
    },
    sum: {
      type: "array",
      items: {
        type: "number",
      },
      output: "number",
      markdownDescription: "Sums all numbers in an array.",
      examples: [
        "{ \"sum\": [1, 2, 3] }",
      ],
    },
    avg: {
      type: "array",
      items: {
        type: "number",
      },
      output: "number",
      markdownDescription: "Returns the arithmetic mean of an array of numbers.",
      examples: [
        "{ \"avg\": [1, 2, 3] }",
      ],
    },
    add: {
      type: "array",
      items: {
        type: "number",
      },
      output: "number",
      markdownDescription: "Sums two or more numbers.",
      examples: [
        "{ \"add\": [{ \"var\": \"$price\" }, 10] }",
      ],
    },
    subtract: {
      type: "array",
      items: {
        type: "number",
      },
      output: "number",
      markdownDescription: "Subtracts subsequent values from the first. Single-element negates.",
      examples: [
        "{ \"subtract\": [10, 3] }",
      ],
    },
    multiply: {
      type: "array",
      items: {
        type: "number",
      },
      output: "number",
      markdownDescription: "Multiplies two or more numbers.",
      examples: [
        "{ \"multiply\": [{ \"var\": \"$qty\" }, { \"var\": \"$price\" }] }",
      ],
    },
    divide: {
      tuple: 2,
      prefixItems: [
        { type: "number", description: "The dividend." },
        { type: "number", description: "The divisor (returns `0` when zero)." },
      ],
      output: "number",
      markdownDescription: "Divides the first value by the second; returns `0` on division by zero.",
      examples: [
        "{ \"divide\": [10, 4] }",
      ],
    },
    mod: {
      tuple: 2,
      prefixItems: [
        { type: "number", description: "The dividend (`a`)." },
        { type: "number", description: "The divisor (`b`; returns `0` when zero)." },
      ],
      output: "number",
      markdownDescription: "Remainder of `a % b`; returns `0` if `b` is zero.",
      examples: [
        "{ \"mod\": [10, 3] }",
      ],
    },
    power: {
      tuple: 2,
      prefixItems: [
        { type: "number", description: "The base." },
        { type: "number", description: "The exponent." },
      ],
      output: "number",
      markdownDescription: "Raises `base` to `exponent`.",
      examples: [
        "{ \"power\": [2, 10] }",
      ],
    },
    min: {
      type: "array",
      items: {
        type: "number",
      },
      output: "number",
      markdownDescription: "Returns the smallest number in an array.",
      examples: [
        "{ \"min\": [3, 1, 4, 1, 5] }",
      ],
    },
    max: {
      type: "array",
      items: {
        type: "number",
      },
      output: "number",
      markdownDescription: "Returns the largest number in an array.",
      examples: [
        "{ \"max\": [3, 1, 4, 1, 5] }",
      ],
    },
    clamp: {
      tuple: 3,
      prefixItems: [
        { type: "number", description: "The value to clamp." },
        { type: "number", description: "Lower bound." },
        { type: "number", description: "Upper bound." },
      ],
      output: "number",
      markdownDescription: "Clamps a value between min and max.",
      examples: [
        "{ \"clamp\": [{ \"var\": \"$health\" }, 0, 100] }",
      ],
    },
    toFixed: {
      tuple: [
        1,
        2,
      ],
      prefixItems: [
        { type: "number", description: "The number to format." },
        { type: "number", description: "Decimal places (default 2)." },
      ],
      output: "string",
      markdownDescription: "Formats a number to a fixed number of decimal places (default 2). Returns a string.",
      examples: [
        "{ \"toFixed\": [3.14159, 2] }",
      ],
    },
    numberFormat: {
      type: "number",
      output: "string",
      markdownDescription: "Formats a number as a locale-aware decimal string via `Intl.NumberFormat` (grouping separators, fraction-digit control). Currency and percent formatting compose from this plus `concat`.",
      examples: [
        "{ \"numberFormat\": 1234.5, \"maximumFractionDigits\": 1 }",
      ],
      siblings: {
        locale: {
          type: "string",
          description: "BCP-47 locale tag (default: the runtime locale).",
        },
        minimumFractionDigits: {
          type: "number",
          description: "Minimum digits after the decimal point.",
        },
        maximumFractionDigits: {
          type: "number",
          description: "Maximum digits after the decimal point.",
        },
      },
    },
    ordinal: {
      type: "number",
      output: "string",
      markdownDescription: "Formats an integer as an English ordinal (`1` -> `\"1st\"`, `2` -> `\"2nd\"`, `3` -> `\"3rd\"`, `11` -> `\"11th\"`). Uses `Intl.PluralRules` for the plural category with an English suffix map; the suffixes are English-only regardless of `locale`.",
      examples: [
        "{ \"ordinal\": 1 }",
      ],
      siblings: {
        locale: {
          type: "string",
          description: "BCP-47 locale tag for the plural-category selection (default: the runtime locale). Suffixes remain English.",
        },
      },
    },
    atan2: {
      tuple: 2,
      prefixItems: [
        { type: "number", description: "The y coordinate." },
        { type: "number", description: "The x coordinate." },
      ],
      output: "number",
      markdownDescription: "Returns the angle in degrees between the positive x-axis and the point `[y, x]`.",
      examples: [
        "{ \"atan2\": [1, 1] }",
      ],
    },
    random: {
      tuple: [
        0,
        2,
      ],
      prefixItems: [
        { type: "number", description: "With one arg, the inclusive max `n` (integer in `[0, n]`); with two, the inclusive `min`." },
        { type: "number", description: "The inclusive `max` (integer in `[min, max]`)." },
      ],
      output: "number",
      markdownDescription: "Generates a random number, using the seeded RNG when `randomSeed` has been set, otherwise `Math.random`.",
      outputDescription: "No args → a float in `[0, 1)`. One arg `n` → an integer in `[0, n]`. Two args → an integer in `[min, max]` (both inclusive).",
      examples: [
        "{ \"random\": [1, 6] }",
      ],
    },
    randomSeed: {
      output: "null",
      markdownDescription: "Seeds the RNG for reproducible sequences. Pass a number or string; `null` resets to unseeded.",
      examples: [
        "{ \"randomSeed\": 42 }",
      ],
    },
  };

  sqrt(d: Record<string, unknown>, c: Context) {
    return resolve(d.sqrt, c, v => Math.sqrt(this.toNumber(v)));
  }
  abs(d: Record<string, unknown>, c: Context) {
    return resolve(d.abs, c, v => Math.abs(this.toNumber(v)));
  }
  round(d: Record<string, unknown>, c: Context) {
    return resolve(d.round, c, v => Math.round(this.toNumber(v)));
  }
  floor(d: Record<string, unknown>, c: Context) {
    return resolve(d.floor, c, v => Math.floor(this.toNumber(v)));
  }
  ceil(d: Record<string, unknown>, c: Context) {
    return resolve(d.ceil, c, v => Math.ceil(this.toNumber(v)));
  }
  parseInt(d: Record<string, unknown>, c: Context) {
    return resolve(d.parseInt, c, v => globalThis.parseInt(this.toString(v), 10) || 0);
  }
  parseFloat(d: Record<string, unknown>, c: Context) {
    return resolve(d.parseFloat, c, v => globalThis.parseFloat(this.toString(v)) || 0);
  }
  sin(d: Record<string, unknown>, c: Context) {
    return resolve(d.sin, c, v => Math.sin(this.toNumber(v) * Math.PI / 180));
  }
  cos(d: Record<string, unknown>, c: Context) {
    return resolve(d.cos, c, v => Math.cos(this.toNumber(v) * Math.PI / 180));
  }
  tan(d: Record<string, unknown>, c: Context) {
    return resolve(d.tan, c, v => Math.tan(this.toNumber(v) * Math.PI / 180));
  }
  asin(d: Record<string, unknown>, c: Context) {
    return resolve(d.asin, c, v => Math.asin(this.toNumber(v)) * 180 / Math.PI);
  }
  acos(d: Record<string, unknown>, c: Context) {
    return resolve(d.acos, c, v => Math.acos(this.toNumber(v)) * 180 / Math.PI);
  }
  atan(d: Record<string, unknown>, c: Context) {
    return resolve(d.atan, c, v => Math.atan(this.toNumber(v)) * 180 / Math.PI);
  }
  log(d: Record<string, unknown>, c: Context) {
    return resolve(d.log, c, v => Math.log(this.toNumber(v)));
  }
  log2(d: Record<string, unknown>, c: Context) {
    return resolve(d.log2, c, v => Math.log2(this.toNumber(v)));
  }
  log10(d: Record<string, unknown>, c: Context) {
    return resolve(d.log10, c, v => Math.log10(this.toNumber(v)));
  }
  exp(d: Record<string, unknown>, c: Context) {
    return resolve(d.exp, c, v => Math.exp(this.toNumber(v)));
  }
  sign(d: Record<string, unknown>, c: Context) {
    return resolve(d.sign, c, v => Math.sign(this.toNumber(v)));
  }
  trunc(d: Record<string, unknown>, c: Context) {
    return resolve(d.trunc, c, v => Math.trunc(this.toNumber(v)));
  }

  hypot(def: Record<string, unknown>, c: Context) {
    return resolve(def.hypot, c, arr => Math.hypot(...this.toArray(arr).map(v => this.toNumber(v))));
  }

  lerp(def: Record<string, unknown>, c: Context) {
    return resolve(def.lerp, c, values => {
      const a = this.toArray(values);
      if (a.length < 3) return 0;
      const start = this.toNumber(a[0]);
      const end = this.toNumber(a[1]);
      return start + (end - start) * this.toNumber(a[2]);
    });
  }

  mapRange(def: Record<string, unknown>, c: Context) {
    return resolveAll([def.mapRange, def.clampToRange], c, ([values, clampRaw]) => {
      const a = this.toArray(values);
      if (a.length < 5) return 0;
      const value = this.toNumber(a[0]);
      const inMin = this.toNumber(a[1]);
      const inMax = this.toNumber(a[2]);
      const outMin = this.toNumber(a[3]);
      const outMax = this.toNumber(a[4]);
      if (inMax === inMin) return outMin;
      const result = outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin);
      if (!this.toBoolean(clampRaw)) return result;
      const lo = Math.min(outMin, outMax);
      const hi = Math.max(outMin, outMax);
      return Math.max(lo, Math.min(hi, result));
    });
  }

  sum(def: Record<string, unknown>, c: Context) {
    return resolve(def.sum, c, arr => this.toArray(arr).reduce((s: number, v) => s + this.toNumber(v), 0));
  }

  avg(def: Record<string, unknown>, c: Context) {
    return resolve(def.avg, c, arr => {
      const items = this.toArray(arr);
      if (items.length === 0) return 0;
      return items.reduce((s: number, v) => s + this.toNumber(v), 0) / items.length;
    });
  }

  add(def: Record<string, unknown>, c: Context) {
    return resolve(def.add, c, values =>
      this.toArray(values).reduce((sum: number, v) => sum + this.toNumber(v), 0)
    );
  }

  subtract(def: Record<string, unknown>, c: Context) {
    return resolve(def.subtract, c, values => {
      const arr = this.toArray(values);
      if (arr.length === 0) return 0;
      if (arr.length === 1) return -this.toNumber(arr[0]);
      return arr.slice(1).reduce((acc: number, v) => acc - this.toNumber(v), this.toNumber(arr[0]));
    });
  }

  multiply(def: Record<string, unknown>, c: Context) {
    return resolve(def.multiply, c, values =>
      this.toArray(values).reduce((p: number, v) => p * this.toNumber(v), 1)
    );
  }

  divide(def: Record<string, unknown>, c: Context) {
    return resolve(def.divide, c, values => {
      const arr = this.toArray(values);
      if (arr.length < 2) return 0;
      const divisor = this.toNumber(arr[1]);
      return divisor === 0 ? 0 : this.toNumber(arr[0]) / divisor;
    });
  }

  mod(def: Record<string, unknown>, c: Context) {
    return resolve(def.mod, c, values => {
      const arr = this.toArray(values);
      if (arr.length < 2) return 0;
      const b = this.toNumber(arr[1]);
      return b === 0 ? 0 : this.toNumber(arr[0]) % b;
    });
  }

  power(def: Record<string, unknown>, c: Context) {
    return resolve(def.power, c, values => {
      const arr = this.toArray(values);
      if (arr.length < 2) return 0;
      return Math.pow(this.toNumber(arr[0]), this.toNumber(arr[1]));
    });
  }

  min(def: Record<string, unknown>, c: Context) {
    return resolve(def.min, c, values => {
      const nums = this.toArray(values).map(v => this.toNumber(v));
      return nums.length > 0 ? Math.min(...nums) : 0;
    });
  }

  max(def: Record<string, unknown>, c: Context) {
    return resolve(def.max, c, values => {
      const nums = this.toArray(values).map(v => this.toNumber(v));
      return nums.length > 0 ? Math.max(...nums) : 0;
    });
  }

  clamp(def: Record<string, unknown>, c: Context) {
    return resolve(def.clamp, c, values => {
      const arr = this.toArray(values);
      if (arr.length < 3) return 0;
      return Math.max(this.toNumber(arr[1]), Math.min(this.toNumber(arr[2]), this.toNumber(arr[0])));
    });
  }

  toFixed(def: Record<string, unknown>, c: Context) {
    return resolve(def.toFixed, c, values => {
      const arr = this.toArray(values);
      const value = this.toNumber(arr[0]);
      const decimals = arr.length > 1 ? this.toNumber(arr[1]) : 2;
      return value.toFixed(Math.max(0, Math.min(20, decimals)));
    });
  }

  numberFormat(def: Record<string, unknown>, c: Context) {
    return resolveAll([def.numberFormat, def.locale, def.minimumFractionDigits, def.maximumFractionDigits], c,
      ([value, locale, minF, maxF]) => {
        const opts: Intl.NumberFormatOptions = {};
        if (minF != null) opts.minimumFractionDigits = this.toNumber(minF);
        if (maxF != null) opts.maximumFractionDigits = this.toNumber(maxF);
        return new Intl.NumberFormat(locale != null ? this.toString(locale) : undefined, opts).format(this.toNumber(value));
      });
  }

  ordinal(def: Record<string, unknown>, c: Context) {
    return resolveAll([def.ordinal, def.locale], c, ([value, locale]) => {
      const n = this.toNumber(value);
      const rules = new Intl.PluralRules(locale != null ? this.toString(locale) : undefined, { type: "ordinal" });
      return `${n}${ORDINAL_SUFFIX[rules.select(n)] ?? "th"}`;
    });
  }

  atan2(def: Record<string, unknown>, c: Context) {
    return resolve(def.atan2, c, values => {
      const arr = this.toArray(values);
      if (arr.length < 2) return 0;
      return Math.atan2(this.toNumber(arr[0]), this.toNumber(arr[1])) * 180 / Math.PI;
    });
  }

  random(def: Record<string, unknown>, c: Context) {
    return resolve(def.random, c, values => {
      const arr = this.toArray(values);
      if (arr.length === 0) return nextRandom();
      // One arg n → integer in [0, n]; two args → integer in [min, max].
      const min = arr.length > 1 ? this.toNumber(arr[0]) : 0;
      const max = arr.length > 1 ? this.toNumber(arr[1]) : this.toNumber(arr[0]);
      return Math.floor(nextRandom() * (max - min + 1)) + min;
    });
  }

  randomSeed(def: Record<string, unknown>, c: Context) {
    return resolve(def.randomSeed, c, val => {
      if (val == null) { _seed = null; return null; }
      _seed = typeof val === "number" ? val : hashString(String(val));
      return null;
    });
  }

  /** A seed set through one resolver must not leak into the next. */
  dispose(): void {
    _seed = null;
  }
}
