/**
 * Text-to-texture rendering via canvas.
 * Extracted from GlNode.ts for modularity.
 */

import type { EntityMeta } from "@jexs/physics";
import type { GlInstance } from "./types.js";

type CreateTexture = (gl: WebGLRenderingContext, source: TexImageSource, linear?: boolean) => WebGLTexture | null;

/**
 * Render text content to a WebGL texture via an offscreen canvas.
 * Updates inst.textures and meta.textureName.
 */
export function renderTextTexture(inst: GlInstance, id: string, meta: EntityMeta, createTexture: CreateTexture): void {
  if (!meta.text) return;
  const { content, font, fill } = meta.text;
  const texName = `__text_${id}`;

  // Delete old texture
  const old = inst.textures.get(texName);
  if (old) inst.gl.deleteTexture(old.tex);

  // Measure & render
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  ctx.font = font;
  const m = ctx.measureText(content);
  const w = Math.ceil(m.width) || 1;
  const sizeMatch = font.match(/(\d+(?:\.\d+)?)px/);
  const h = Math.ceil((sizeMatch ? parseFloat(sizeMatch[1]) : 16) * 1.4);
  c.width = w;
  c.height = h;
  ctx.font = font;
  ctx.fillStyle = fill;
  ctx.textBaseline = "top";
  ctx.fillText(content, 0, 0);

  const tex = createTexture(inst.gl, c, true);
  if (tex) {
    inst.textures.set(texName, { tex, w, h });
    meta.textureName = texName;
  }
}
