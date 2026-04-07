/**
 * Post-processing pipeline: FBO management, bloom, blur, FXAA, transitions.
 * Extracted from GlNode.ts for modularity.
 */

import type { GlInstance } from "./types.js";
import {
  POST_VERT_SRC, POST_FRAG_SRC, BLUR_FRAG_SRC, FXAA_FRAG_SRC,
  BLOOM_BRIGHT_FRAG_SRC, BLOOM_COMPOSITE_FRAG_SRC,
  POST_QUAD_VERTS,
} from "./shaders.js";

type CreateProgram = (gl: WebGLRenderingContext, vert: string, frag: string, isWebGL2: boolean) => WebGLProgram | null;

/**
 * Ensure post-processing FBOs exist and match canvas size.
 * Lazily initializes post-process, blur, FXAA, and bloom programs.
 * Returns true if FBOs are ready.
 */
export function ensureFBOs(inst: GlInstance, createProgramFn: CreateProgram): boolean {
  const gl = inst.gl;
  const w = inst.canvas.width, h = inst.canvas.height;
  if (inst.fboA && inst.fboWidth === w && inst.fboHeight === h) return true;

  // Clean up old
  if (inst.fboA) gl.deleteFramebuffer(inst.fboA);
  if (inst.fboTexA) gl.deleteTexture(inst.fboTexA);
  if (inst.fboB) gl.deleteFramebuffer(inst.fboB);
  if (inst.fboTexB) gl.deleteTexture(inst.fboTexB);

  const a = createFBO(gl, w, h);
  const b = createFBO(gl, w, h);
  if (!a || !b) return false;

  inst.fboA = a.fbo; inst.fboTexA = a.tex;
  inst.fboB = b.fbo; inst.fboTexB = b.tex;
  inst.fboWidth = w; inst.fboHeight = h;

  // Third FBO for bloom
  if (inst.fboC) gl.deleteFramebuffer(inst.fboC);
  if (inst.fboTexC) gl.deleteTexture(inst.fboTexC);
  const c = createFBO(gl, w, h);
  inst.fboC = c?.fbo ?? null;
  inst.fboTexC = c?.tex ?? null;

  // Lazy-init post-process programs and quad buffer
  if (!inst.postProg) {
    const pp = createProgramFn(gl, POST_VERT_SRC, POST_FRAG_SRC, inst.isWebGL2);
    const bp = createProgramFn(gl, POST_VERT_SRC, BLUR_FRAG_SRC, inst.isWebGL2);
    inst.postProg = pp;
    inst.blurProg = bp;
    if (pp) inst.postLocs = {
      uTexture: gl.getUniformLocation(pp, "u_texture")!, uOpacity: gl.getUniformLocation(pp, "u_opacity")!,
      aPosition: gl.getAttribLocation(pp, "a_position"),
    };
    if (bp) inst.blurLocs = {
      uTexture: gl.getUniformLocation(bp, "u_texture")!, uDirection: gl.getUniformLocation(bp, "u_direction")!,
      uRadius: gl.getUniformLocation(bp, "u_radius")!, aPosition: gl.getAttribLocation(bp, "a_position"),
    };
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, POST_QUAD_VERTS, gl.STATIC_DRAW);
    inst.postQuadBuf = buf;
  }
  // FXAA program
  if (!inst.fxaaProg && inst.fxaa) {
    const fp = createProgramFn(gl, POST_VERT_SRC, FXAA_FRAG_SRC, inst.isWebGL2);
    inst.fxaaProg = fp;
    if (fp) inst.fxaaLocs = {
      uTexture: gl.getUniformLocation(fp, "u_texture")!,
      uTexelSize: gl.getUniformLocation(fp, "u_texelSize")!,
      aPosition: gl.getAttribLocation(fp, "a_position"),
    };
  }
  // Bloom programs
  if (!inst.bloomBrightProg && inst.bloom) {
    const bbp = createProgramFn(gl, POST_VERT_SRC, BLOOM_BRIGHT_FRAG_SRC, inst.isWebGL2);
    inst.bloomBrightProg = bbp;
    if (bbp) inst.bloomBrightLocs = {
      uTexture: gl.getUniformLocation(bbp, "u_texture")!,
      uThreshold: gl.getUniformLocation(bbp, "u_threshold")!,
      aPosition: gl.getAttribLocation(bbp, "a_position"),
    };
    const bcp = createProgramFn(gl, POST_VERT_SRC, BLOOM_COMPOSITE_FRAG_SRC, inst.isWebGL2);
    inst.bloomCompProg = bcp;
    if (bcp) inst.bloomCompLocs = {
      uTexture: gl.getUniformLocation(bcp, "u_texture")!,
      uBloom: gl.getUniformLocation(bcp, "u_bloom")!,
      uIntensity: gl.getUniformLocation(bcp, "u_intensity")!,
      aPosition: gl.getAttribLocation(bcp, "a_position"),
    };
  }
  return true;
}

export function parseBloom(raw: unknown): { threshold: number; intensity: number; radius: number } | null {
  if (raw && typeof raw === "object") {
    return {
      threshold: Number((raw as Record<string, unknown>)["threshold"] ?? 0.8),
      intensity: Number((raw as Record<string, unknown>)["intensity"] ?? 0.5),
      radius: Number((raw as Record<string, unknown>)["radius"] ?? 4),
    };
  }
  return raw ? { threshold: 0.8, intensity: 0.5, radius: 4 } : null;
}

export function createFBO(gl: WebGLRenderingContext, w: number, h: number): { fbo: WebGLFramebuffer; tex: WebGLTexture } | null {
  const fbo = gl.createFramebuffer();
  const tex = gl.createTexture();
  if (!fbo || !tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return { fbo, tex };
}

export function drawFullscreenQuad(inst: GlInstance, prog: WebGLProgram, aPos: number): void {
  const gl = inst.gl;
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, inst.postQuadBuf);
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

/**
 * Run the full post-processing chain (bloom → blur → FXAA → transition → blit).
 * Returns the number of draw calls issued.
 */
export function applyPostProcessing(inst: GlInstance, cw: number, ch: number): number {
  const gl = inst.gl;
  let drawCalls = 0;

  // Disable blending for post-process passes
  gl.disable(gl.BLEND);

  let srcTex = inst.fboTexA!;
  let curFbo: WebGLFramebuffer | null = inst.fboA!;
  const altFbo = inst.fboB!, altTex = inst.fboTexB!;

  // Bloom: extract bright → blur → composite
  if (inst.bloom && inst.bloomBrightProg && inst.bloomBrightLocs && inst.bloomCompProg && inst.bloomCompLocs && inst.blurProg && inst.blurLocs && inst.fboC) {
    const bloom = inst.bloom;
    const bbl = inst.bloomBrightLocs, bcl = inst.bloomCompLocs;
    const bp = inst.blurProg, bl = inst.blurLocs;

    // 1. Extract bright pixels: fboA → fboC
    gl.bindFramebuffer(gl.FRAMEBUFFER, inst.fboC);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.useProgram(inst.bloomBrightProg);
    gl.uniform1i(bbl.uTexture, 0);
    gl.uniform1f(bbl.uThreshold, bloom.threshold);
    drawFullscreenQuad(inst, inst.bloomBrightProg, bbl.aPosition);
    drawCalls++;

    // 2. Blur bright: fboC → fboB (horizontal)
    gl.bindFramebuffer(gl.FRAMEBUFFER, inst.fboB);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(bp);
    gl.bindTexture(gl.TEXTURE_2D, inst.fboTexC);
    gl.uniform1i(bl.uTexture, 0);
    gl.uniform2f(bl.uDirection, 1 / cw, 0);
    gl.uniform1f(bl.uRadius, bloom.radius);
    drawFullscreenQuad(inst, bp, bl.aPosition);
    drawCalls++;

    // 3. Blur bright: fboB → fboC (vertical)
    gl.bindFramebuffer(gl.FRAMEBUFFER, inst.fboC);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindTexture(gl.TEXTURE_2D, inst.fboTexB);
    gl.uniform2f(bl.uDirection, 0, 1 / ch);
    drawFullscreenQuad(inst, bp, bl.aPosition);
    drawCalls++;

    // 4. Composite: scene (fboA) + bloom (fboC) → fboB
    gl.bindFramebuffer(gl.FRAMEBUFFER, inst.fboB);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(inst.bloomCompProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex); // scene
    gl.uniform1i(bcl.uTexture, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, inst.fboTexC!); // bloom
    gl.uniform1i(bcl.uBloom, 1);
    gl.uniform1f(bcl.uIntensity, bloom.intensity);
    drawFullscreenQuad(inst, inst.bloomCompProg, bcl.aPosition);
    gl.activeTexture(gl.TEXTURE0); // restore
    drawCalls++;

    srcTex = inst.fboTexB!;
    curFbo = inst.fboB!;
  }

  // Blur: two-pass separable Gaussian (horizontal then vertical)
  if (inst.blur && inst.blurProg && inst.blurLocs) {
    const bp = inst.blurProg, bl = inst.blurLocs;

    // Horizontal: src → alt
    const dstH = curFbo === inst.fboA ? altFbo : inst.fboA!;
    const dstHTex = curFbo === inst.fboA ? altTex : inst.fboTexA!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstH);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(bp);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(bl.uTexture, 0);
    gl.uniform2f(bl.uDirection, 1 / cw, 0);
    gl.uniform1f(bl.uRadius, inst.blur.radius);
    drawFullscreenQuad(inst, bp, bl.aPosition);
    drawCalls++;

    // Vertical: dstH → curFbo (or fboA)
    const dstV = curFbo === inst.fboA ? inst.fboA! : altFbo;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dstV);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindTexture(gl.TEXTURE_2D, dstHTex);
    gl.uniform2f(bl.uDirection, 0, 1 / ch);
    drawFullscreenQuad(inst, bp, bl.aPosition);
    drawCalls++;

    srcTex = dstV === inst.fboA ? inst.fboTexA! : altTex;
  }

  // FXAA: anti-aliasing pass
  if (inst.fxaa && inst.fxaaProg && inst.fxaaLocs) {
    const fl = inst.fxaaLocs;
    const hasMore = !!(inst.transition);
    gl.bindFramebuffer(gl.FRAMEBUFFER, hasMore ? altFbo : null);
    if (hasMore) gl.clear(gl.COLOR_BUFFER_BIT);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.useProgram(inst.fxaaProg);
    gl.uniform1i(fl.uTexture, 0);
    gl.uniform2f(fl.uTexelSize, 1 / cw, 1 / ch);
    drawFullscreenQuad(inst, inst.fxaaProg, fl.aPosition);
    drawCalls++;
    if (hasMore) srcTex = altTex;
  }

  // Transition: fade
  if (inst.transition && inst.postProg && inst.postLocs) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    const pp = inst.postProg, pl = inst.postLocs;
    gl.useProgram(pp);
    gl.uniform1i(pl.uTexture, 0);
    const t = Math.min(inst.transition.elapsed / inst.transition.duration, 1);
    gl.uniform1f(pl.uOpacity, t);
    drawFullscreenQuad(inst, pp, pl.aPosition);
    drawCalls++;
  } else if (!inst.fxaa || !inst.fxaaProg) {
    // If no FXAA and no transition, blit srcTex to screen
    if (inst.blur || inst.bloom) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      const pp = inst.postProg!, pl = inst.postLocs!;
      gl.useProgram(pp);
      gl.uniform1i(pl.uTexture, 0);
      gl.uniform1f(pl.uOpacity, 1.0);
      drawFullscreenQuad(inst, pp, pl.aPosition);
      drawCalls++;
    }
  }

  // Restore blend state
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  return drawCalls;
}
