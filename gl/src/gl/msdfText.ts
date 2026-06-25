/**
 * MSDF text — pure parsing + layout (no GL).
 *
 * Consumes the BMFont-JSON descriptor produced by the standard MSDF tooling
 * (e.g. msdf-bmfont-xml): a `chars` table of glyph atlas rects + metrics, plus
 * `common`/`info` for line metrics and the atlas dimensions. `layoutText`
 * turns a string into positioned textured quads with atlas UVs, which the GL
 * path (separate module) uploads and draws with the median-of-3 MSDF shader.
 *
 * This is the resolution-independent counterpart to the canvas text path
 * (textRendering.ts): one shared atlas, crisp at any scale, recolorable.
 */

/** One glyph's atlas rectangle + placement metrics (atlas pixel units). */
export interface MsdfChar {
  id: number;
  x: number; y: number; width: number; height: number;
  xoffset: number; yoffset: number; xadvance: number;
}

/** A parsed MSDF font descriptor. */
export interface MsdfFont {
  /** EM size the atlas was rasterized at (info.size) — the layout scale basis. */
  size: number;
  /** Line advance in atlas px (common.lineHeight). */
  lineHeight: number;
  /** Baseline offset from the cell top in atlas px (common.base). */
  base: number;
  /** Atlas texture dimensions in px (common.scaleW/scaleH). */
  scaleW: number;
  scaleH: number;
  /** Glyphs keyed by codepoint. */
  chars: Map<number, MsdfChar>;
  /** Kerning pairs keyed by `first * 0x110000 + second` → advance delta (atlas px). */
  kernings: Map<number, number>;
  /** SDF px range (for the shader's screen-space derivative scaling); 0 if unknown. */
  distanceRange: number;
  /** Atlas page image filename(s), if present. */
  pages: string[];
}

const KERN_BASE = 0x110000; // one past the max Unicode codepoint
function kernKey(first: number, second: number): number {
  return first * KERN_BASE + second;
}

/**
 * Parse a BMFont-JSON descriptor into an `MsdfFont`. Accepts either a JSON
 * string or an already-parsed object.
 */
/** Type guard: a plain object (not array/null). Narrows without a cast. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
/** Plain-object accessor: the value if it's an object, else an empty record. */
function asObj(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

export function parseMsdfFont(src: string | Record<string, unknown>): MsdfFont {
  const json: Record<string, unknown> = typeof src === "string" ? JSON.parse(src) : src;
  const info = asObj(json.info);
  const common = asObj(json.common);
  const distanceField = asObj(json.distanceField);

  const chars = new Map<number, MsdfChar>();
  if (Array.isArray(json.chars)) {
    for (const c of json.chars) {
      const ch = asObj(c);
      const id = Number(ch.id);
      chars.set(id, {
        id,
        x: Number(ch.x) || 0, y: Number(ch.y) || 0, width: Number(ch.width) || 0, height: Number(ch.height) || 0,
        xoffset: Number(ch.xoffset) || 0, yoffset: Number(ch.yoffset) || 0, xadvance: Number(ch.xadvance) || 0,
      });
    }
  }

  const kernings = new Map<number, number>();
  if (Array.isArray(json.kernings)) {
    for (const k of json.kernings) {
      const kn = asObj(k);
      kernings.set(kernKey(Number(kn.first), Number(kn.second)), Number(kn.amount) || 0);
    }
  }

  return {
    size: Number(info.size) || 32,
    lineHeight: Number(common.lineHeight) || Number(info.size) || 32,
    base: Number(common.base) || 0,
    scaleW: Number(common.scaleW) || 1,
    scaleH: Number(common.scaleH) || 1,
    chars,
    kernings,
    distanceRange: Number(distanceField.distanceRange) || 0,
    pages: Array.isArray(json.pages) ? json.pages.map(String) : [],
  };
}

/** One textured quad in layout space (y-down, origin at the text's top-left),
 *  with atlas UVs normalized to [0,1]. */
export interface GlyphQuad {
  x: number; y: number; w: number; h: number;
  u0: number; v0: number; u1: number; v1: number;
}

export interface TextLayout {
  quads: GlyphQuad[];
  /** Tight bounding width (max line advance) and height (line count × scaled lineHeight). */
  width: number;
  height: number;
}

/**
 * Lay out `text` in `font` at `fontSize` px. Handles per-glyph advance, kerning,
 * and `\n` line breaks. Missing glyphs are skipped (their advance is omitted).
 * Returns quads with atlas UVs ready to feed the MSDF shader.
 */
export function layoutText(text: string, font: MsdfFont, fontSize: number): TextLayout {
  const scale = fontSize / font.size;
  const lineAdvance = font.lineHeight * scale;
  const quads: GlyphQuad[] = [];

  let penX = 0;
  let lineY = 0;
  let maxWidth = 0;
  let prev = -1;

  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (cp === 10) { // newline
      if (penX > maxWidth) maxWidth = penX;
      penX = 0;
      lineY += lineAdvance;
      prev = -1;
      continue;
    }
    const glyph = font.chars.get(cp);
    if (!glyph) { prev = -1; continue; }

    if (prev !== -1) {
      const k = font.kernings.get(kernKey(prev, cp));
      if (k) penX += k * scale;
    }

    // Glyphs with zero area (e.g. space) advance but emit no quad.
    if (glyph.width > 0 && glyph.height > 0) {
      quads.push({
        x: penX + glyph.xoffset * scale,
        y: lineY + glyph.yoffset * scale,
        w: glyph.width * scale,
        h: glyph.height * scale,
        u0: glyph.x / font.scaleW,
        v0: glyph.y / font.scaleH,
        u1: (glyph.x + glyph.width) / font.scaleW,
        v1: (glyph.y + glyph.height) / font.scaleH,
      });
    }

    penX += glyph.xadvance * scale;
    prev = cp;
  }

  if (penX > maxWidth) maxWidth = penX;
  return { quads, width: maxWidth, height: lineY + lineAdvance };
}
