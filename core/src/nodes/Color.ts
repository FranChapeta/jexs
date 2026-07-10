import { Node, Context } from "./Node.js";
import { resolveAll } from "../Resolver.js";
import type { JexsNodeSchema, JexsPropertySchema } from "../schema.js";

/**
 * Color operations over two array color spaces:
 *   rgb `[r, g, b, a]` — r/g/b in 0..1, alpha default 1
 *   hsl `[h, s, l, a]` — h in 0-360, s/l in 0-100, alpha default 1
 * plus hex strings (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`).
 *
 * The `format` sibling (default `"rgb"`) disambiguates array inputs — a bare
 * `[a, b, c]` is read as rgb or hsl accordingly — and selects the space that
 * color-returning ops emit in.
 */
export class ColorNode extends Node {
  static commonSiblings: Record<string, JexsPropertySchema> = {
    format: {
      type: "string",
      enum: [
        "rgb",
        "hsl",
      ],
      description: "Color space of array inputs, and the space color-returning ops emit in (default `\"rgb\"`). Hex strings parse regardless.",
    },
  };

  static schema: JexsNodeSchema = {
    toRgb: {
      type: [
        "string",
        "array",
      ],
      output: "array",
      markdownDescription: "Parses a color into an rgb array `[r, g, b, a]` (components 0..1). Accepts a hex string (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`) or an array interpreted per `format`.",
      examples: [
        "{ \"toRgb\": \"#3366ff\" }",
        "{ \"toRgb\": [210, 100, 50], \"format\": \"hsl\" }",
      ],
    },
    toHsl: {
      type: [
        "string",
        "array",
      ],
      output: "array",
      markdownDescription: "Converts a color to an hsl array `[h, s, l, a]` (h 0-360, s/l 0-100). Accepts a hex string or an array interpreted per `format`.",
      examples: [
        "{ \"toHsl\": \"#3366ff\" }",
      ],
    },
    toHex: {
      type: [
        "string",
        "array",
      ],
      output: "string",
      markdownDescription: "Converts a color to a hex string. Emits `#rrggbb`, or `#rrggbbaa` when alpha is below 1.",
      examples: [
        "{ \"toHex\": [0.2, 0.4, 1] }",
      ],
    },
    lighten: {
      tuple: 2,
      output: "array",
      markdownDescription: "Raises a color's HSL lightness by `amount` (a 0..1 fraction of the full range; `0.1` adds 10 lightness points). Tuple form `[color, amount]`. Returns a color in the `format` space.",
      examples: [
        "{ \"lighten\": [\"#3366ff\", 0.2] }",
      ],
    },
    darken: {
      tuple: 2,
      output: "array",
      markdownDescription: "Lowers a color's HSL lightness by `amount` (a 0..1 fraction of the full range). Tuple form `[color, amount]`. Returns a color in the `format` space.",
      examples: [
        "{ \"darken\": [\"#3366ff\", 0.2] }",
      ],
    },
    mix: {
      tuple: 3,
      output: "array",
      markdownDescription: "Blends two colors component-wise by fraction `t` (0 = all `a`, 1 = all `b`). Tuple form `[a, b, t]`. The blend runs in the `format` space and returns a color there. In `hsl` the hue is interpolated naively (it does not take the shortest arc around the wheel), so `rgb` is the safer default.",
      examples: [
        "{ \"mix\": [\"#ff0000\", \"#0000ff\", 0.5] }",
      ],
    },
    luminance: {
      type: [
        "string",
        "array",
      ],
      output: "number",
      markdownDescription: "WCAG relative luminance of a color, 0 (black) to 1 (white).",
      examples: [
        "{ \"luminance\": \"#3366ff\" }",
      ],
    },
    contrast: {
      tuple: 2,
      output: "number",
      markdownDescription: "WCAG contrast ratio between two colors: `(Llighter + 0.05) / (Ldarker + 0.05)`, from 1 (identical) to 21 (black on white). Tuple form `[a, b]` — order does not matter.",
      examples: [
        "{ \"contrast\": [\"#000000\", \"#ffffff\"] }",
      ],
    },
  };

  toRgb(def: Record<string, unknown>, c: Context) {
    return resolveAll([def.toRgb, def.format], c, ([input, fmt]) =>
      this.toRgba(input, this.fmt(fmt)));
  }

  toHsl(def: Record<string, unknown>, c: Context) {
    return resolveAll([def.toHsl, def.format], c, ([input, fmt]) => {
      const [r, g, b, a] = this.toRgba(input, this.fmt(fmt));
      const [h, s, l] = rgbToHsl(r, g, b);
      return [h, s, l, a];
    });
  }

  toHex(def: Record<string, unknown>, c: Context) {
    return resolveAll([def.toHex, def.format], c, ([input, fmt]) =>
      toHexString(this.toRgba(input, this.fmt(fmt))));
  }

  lighten(def: Record<string, unknown>, c: Context) {
    return this.adjustLightness(def.lighten, def.format, c, 1);
  }

  darken(def: Record<string, unknown>, c: Context) {
    return this.adjustLightness(def.darken, def.format, c, -1);
  }

  mix(def: Record<string, unknown>, c: Context) {
    return resolveAll([def.mix, def.format], c, ([args, fmt]) => {
      const format = this.fmt(fmt);
      const a = this.toArray(args);
      const ca = this.toSpace(a[0], format);
      const cb = this.toSpace(a[1], format);
      const t = this.toNumber(a[2]);
      return ca.map((v, i) => v + (cb[i] - v) * t);
    });
  }

  luminance(def: Record<string, unknown>, c: Context) {
    return resolveAll([def.luminance, def.format], c, ([input, fmt]) =>
      relLuminance(this.toRgba(input, this.fmt(fmt))));
  }

  contrast(def: Record<string, unknown>, c: Context) {
    return resolveAll([def.contrast, def.format], c, ([args, fmt]) => {
      const format = this.fmt(fmt);
      const a = this.toArray(args);
      const la = relLuminance(this.toRgba(a[0], format));
      const lb = relLuminance(this.toRgba(a[1], format));
      const light = Math.max(la, lb);
      const dark = Math.min(la, lb);
      return (light + 0.05) / (dark + 0.05);
    });
  }

  private adjustLightness(arg: unknown, formatRaw: unknown, c: Context, sign: number) {
    return resolveAll([arg, formatRaw], c, ([args, fmt]) => {
      const format = this.fmt(fmt);
      const a = this.toArray(args);
      const rgba = this.toRgba(a[0], format);
      const amount = this.toNumber(a[1]);
      const hsl = rgbToHsl(rgba[0], rgba[1], rgba[2]);
      const l = Math.max(0, Math.min(100, hsl[2] + sign * amount * 100));
      const [r, g, b] = hslToRgb(hsl[0], hsl[1], l);
      return this.emitColor([r, g, b, rgba[3]], format);
    });
  }

  /** Normalize the `format` sibling to a known space (default `"rgb"`). */
  private fmt(value: unknown): string {
    return value === "hsl" ? "hsl" : "rgb";
  }

  /** Any color input -> rgba (all components 0..1). Strings parse as hex;
   *  arrays are read as rgb or hsl per `format`. */
  private toRgba(input: unknown, format: string): Rgba {
    if (typeof input === "string") return parseHex(input);
    const arr = this.toArray(input).map(v => this.toNumber(v));
    const a = arr.length > 3 ? clamp01(arr[3]) : 1;
    if (format === "hsl") {
      const [r, g, b] = hslToRgb(arr[0] ?? 0, arr[1] ?? 0, arr[2] ?? 0);
      return [r, g, b, a];
    }
    return [clamp01(arr[0] ?? 0), clamp01(arr[1] ?? 0), clamp01(arr[2] ?? 0), a];
  }

  /** A color as an array in the requested space (rgb `[r,g,b,a]` or hsl `[h,s,l,a]`). */
  private toSpace(input: unknown, format: string): number[] {
    return this.emitColor(this.toRgba(input, format), format);
  }

  /** Emit an rgba value as an array in the requested space. */
  private emitColor(rgba: Rgba, format: string): number[] {
    if (format === "hsl") {
      const [h, s, l] = rgbToHsl(rgba[0], rgba[1], rgba[2]);
      return [h, s, l, rgba[3]];
    }
    return [rgba[0], rgba[1], rgba[2], rgba[3]];
  }
}

type Rgba = [number, number, number, number];

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Parse `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` into rgba (0..1). Invalid
 *  channels fall back to 0 (alpha to 1). */
function parseHex(hex: string): Rgba {
  let h = hex.trim();
  if (h.charCodeAt(0) === 35) h = h.slice(1); // strip leading '#'
  if (h.length === 3 || h.length === 4) {
    h = h.split("").map(ch => ch + ch).join(""); // expand shorthand
  }
  const channel = (i: number, fallback: number): number => {
    if (h.length < i + 2) return fallback;
    const n = parseInt(h.slice(i, i + 2), 16);
    return Number.isNaN(n) ? fallback : n / 255;
  };
  return [channel(0, 0), channel(2, 0), channel(4, 0), channel(6, 1)];
}

/** Format rgba (0..1) as `#rrggbb`, or `#rrggbbaa` when alpha is below 1. */
function toHexString(rgba: Rgba): string {
  const hh = (n: number) => Math.round(clamp01(n) * 255).toString(16).padStart(2, "0");
  const base = `#${hh(rgba[0])}${hh(rgba[1])}${hh(rgba[2])}`;
  return rgba[3] < 1 ? `${base}${hh(rgba[3])}` : base;
}

/** rgb (0..1) -> hsl (h 0-360, s/l 0-100). */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l * 100];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  switch (max) {
    case r: h = (g - b) / d + (g < b ? 6 : 0); break;
    case g: h = (b - r) / d + 2; break;
    default: h = (r - g) / d + 4; break;
  }
  return [h * 60, s * 100, l * 100];
}

/** hsl (h 0-360, s/l 0-100) -> rgb (0..1). Hue wraps into range. */
function hslToRgb(hDeg: number, sPct: number, lPct: number): [number, number, number] {
  const h = (((hDeg % 360) + 360) % 360) / 360;
  const s = clamp01(sPct / 100);
  const l = clamp01(lPct / 100);
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue2rgb(h + 1 / 3), hue2rgb(h), hue2rgb(h - 1 / 3)];
}

/** WCAG relative luminance from rgba (0..1); alpha is ignored. */
function relLuminance(rgba: Rgba): number {
  const lin = (c: number) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * lin(rgba[0]) + 0.7152 * lin(rgba[1]) + 0.0722 * lin(rgba[2]);
}
