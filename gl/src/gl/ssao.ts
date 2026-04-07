/**
 * Screen-space ambient occlusion initialization.
 * Extracted from GlNode.ts for modularity.
 */

import type { GlInstance } from "./types.js";
import { createFBO } from "./postProcess.js";
import {
  POST_VERT_SRC,
  SSAO_DEPTH_VERT_SRC, SSAO_DEPTH_FRAG_SRC,
  SSAO_FRAG_SRC, SSAO_BLUR_FRAG_SRC, SSAO_COMPOSITE_FRAG_SRC,
} from "./shaders.js";
import { mat4Perspective, mat4Ortho, mat4LookAt, mat4Model, _projM } from "./math.js";
import { SHAPE_3D } from "./geometry.js";
import {
  STRIDE, F_X, F_Y, F_Z, F_W, F_H, F_D,
  F_RX, F_RY, F_ANGLE, F_FLAGS, FLAG_VISIBLE,
} from "@jexs/physics";

type CreateProgram = (gl: WebGLRenderingContext, vert: string, frag: string, isWebGL2: boolean) => WebGLProgram | null;

/**
 * Render the SSAO depth + sampling + blur passes (before main 3D render).
 * Writes blurred AO into ssaoBlurTex. Restores GL state afterward.
 */
export function renderSsaoPass(
  inst: GlInstance, cw: number, ch: number,
  needsPost: boolean, clearColor: readonly [number, number, number, number],
): void {
  if (!inst.ssao || !inst.ssaoDepthProg || !inst.ssaoDepthLocs || !inst.ssaoDepthFbo) return;

  const gl = inst.gl;
  const store = inst.store;
  const cam = inst.camera;
  const sdl = inst.ssaoDepthLocs;
  const camFar = cam.far;

  // 1. Depth-only pass: render all entities to ssaoDepthFbo
  gl.bindFramebuffer(gl.FRAMEBUFFER, inst.ssaoDepthFbo);
  gl.viewport(0, 0, cw, ch);
  gl.clearColor(1, 1, 1, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);

  gl.useProgram(inst.ssaoDepthProg);
  const aspect = cw / ch;
  if (inst.ortho) {
    const halfH = cam.fov / 2;
    const halfW = halfH * aspect;
    mat4Ortho(-halfW, halfW, -halfH, halfH, cam.near, camFar);
  } else {
    mat4Perspective(cam.fov, aspect, cam.near, camFar);
  }
  gl.uniformMatrix4fv(sdl.uProjection, false, _projM);
  gl.uniformMatrix4fv(sdl.uView, false, mat4LookAt(
    [cam.x + cam.shakeX, cam.y + cam.shakeY, cam.z], cam.lookAt, cam.up,
  ));
  gl.uniform1f(sdl.uFar, camFar);

  for (let i = 0; i < store.count; i++) {
    const b = i * STRIDE;
    if (!(store.data[b + F_FLAGS] & FLAG_VISIBLE)) continue;
    const meta = store.meta[i];
    if (!meta) continue;
    const verts = SHAPE_3D[meta.type];
    if (!verts) continue;

    const model = mat4Model(
      store.data[b + F_X], store.data[b + F_Y], store.data[b + F_Z],
      store.data[b + F_W], store.data[b + F_H], store.data[b + F_D] || 1,
      store.data[b + F_RX], store.data[b + F_RY], store.data[b + F_ANGLE],
    );
    gl.uniformMatrix4fv(sdl.uModel, false, model);

    if (inst.prog3dBuf) {
      gl.bindBuffer(gl.ARRAY_BUFFER, inst.prog3dBuf);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(sdl.aPosition);
      gl.vertexAttribPointer(sdl.aPosition, 3, gl.FLOAT, false, 24, 0);
      if (sdl.aNormal >= 0) {
        gl.enableVertexAttribArray(sdl.aNormal);
        gl.vertexAttribPointer(sdl.aNormal, 3, gl.FLOAT, false, 24, 12);
      }
      gl.drawArrays(gl.TRIANGLES, 0, verts.length / 6);
    }
  }

  // 2. SSAO sampling pass (half-res)
  if (inst.ssaoProg && inst.ssaoLocs && inst.ssaoFbo && inst.ssaoDepthTex) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, inst.ssaoFbo);
    gl.viewport(0, 0, inst.ssaoWidth, inst.ssaoHeight);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(inst.ssaoProg);
    const sl = inst.ssaoLocs;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inst.ssaoDepthTex);
    gl.uniform1i(sl.uDepth, 0);
    gl.uniform2f(sl.uTexelSize, 1.0 / cw, 1.0 / ch);
    gl.uniform1f(sl.uRadius, inst.ssao.radius);
    gl.uniform1f(sl.uBias, inst.ssao.bias);
    gl.uniform1f(sl.uIntensity, inst.ssao.intensity);
    gl.uniformMatrix4fv(sl.uProjection, false, _projM);
    gl.uniform1f(sl.uFar, camFar);

    if (inst.postQuadBuf) {
      gl.bindBuffer(gl.ARRAY_BUFFER, inst.postQuadBuf);
      gl.enableVertexAttribArray(sl.aPosition);
      gl.vertexAttribPointer(sl.aPosition, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  // 3. Bilateral blur pass (half-res, edge-preserving)
  if (inst.ssaoBlurProg && inst.ssaoBlurLocs && inst.ssaoBlurFbo && inst.ssaoTex && inst.ssaoDepthTex) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, inst.ssaoBlurFbo);
    gl.viewport(0, 0, inst.ssaoWidth, inst.ssaoHeight);
    gl.useProgram(inst.ssaoBlurProg);
    const bl = inst.ssaoBlurLocs;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inst.ssaoTex);
    gl.uniform1i(bl.uTexture, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, inst.ssaoDepthTex);
    gl.uniform1i(bl.uDepth, 1);
    gl.uniform2f(bl.uTexelSize, 1.0 / inst.ssaoWidth, 1.0 / inst.ssaoHeight);
    gl.activeTexture(gl.TEXTURE0);

    if (inst.postQuadBuf) {
      gl.bindBuffer(gl.ARRAY_BUFFER, inst.postQuadBuf);
      gl.enableVertexAttribArray(bl.aPosition);
      gl.vertexAttribPointer(bl.aPosition, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  // Restore state for main render
  gl.bindFramebuffer(gl.FRAMEBUFFER, needsPost ? inst.fboA : null);
  gl.viewport(0, 0, cw, ch);
  gl.clearColor(clearColor[0], clearColor[1], clearColor[2], clearColor[3]);
  gl.enable(gl.DEPTH_TEST);
}

export function initSsao(inst: GlInstance, createProgram: CreateProgram): void {
  const gl = inst.gl;
  const w = inst.canvas.width, h = inst.canvas.height;
  const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);

  // Full-res depth FBO
  const depthResult = createFBO(gl, w, h);
  if (!depthResult) return;
  const depthRB = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, depthRB);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
  gl.bindFramebuffer(gl.FRAMEBUFFER, depthResult.fbo);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRB);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  inst.ssaoDepthFbo = depthResult.fbo;
  inst.ssaoDepthTex = depthResult.tex;
  gl.bindTexture(gl.TEXTURE_2D, depthResult.tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.bindTexture(gl.TEXTURE_2D, null);

  // Half-res SSAO FBO
  const ssaoResult = createFBO(gl, hw, hh);
  if (ssaoResult) { inst.ssaoFbo = ssaoResult.fbo; inst.ssaoTex = ssaoResult.tex; }

  // Half-res blur FBO
  const blurResult = createFBO(gl, hw, hh);
  if (blurResult) { inst.ssaoBlurFbo = blurResult.fbo; inst.ssaoBlurTex = blurResult.tex; }

  inst.ssaoWidth = hw;
  inst.ssaoHeight = hh;

  // Compile SSAO depth program (non-instanced)
  const dp = createProgram(gl, SSAO_DEPTH_VERT_SRC, SSAO_DEPTH_FRAG_SRC, inst.isWebGL2);
  if (dp) {
    inst.ssaoDepthProg = dp;
    inst.ssaoDepthLocs = {
      aPosition:   gl.getAttribLocation(dp, "a_position"),
      aNormal:     gl.getAttribLocation(dp, "a_normal"),
      uProjection: gl.getUniformLocation(dp, "u_projection")!,
      uView:       gl.getUniformLocation(dp, "u_view")!,
      uModel:      gl.getUniformLocation(dp, "u_model")!,
      uFar:        gl.getUniformLocation(dp, "u_far")!,
    };
  }

  // SSAO sampling program
  const sp = createProgram(gl, POST_VERT_SRC, SSAO_FRAG_SRC, inst.isWebGL2);
  if (sp) {
    inst.ssaoProg = sp;
    inst.ssaoLocs = {
      aPosition:   gl.getAttribLocation(sp, "a_position"),
      uDepth:      gl.getUniformLocation(sp, "u_depth")!,
      uTexelSize:  gl.getUniformLocation(sp, "u_texelSize")!,
      uRadius:     gl.getUniformLocation(sp, "u_radius")!,
      uBias:       gl.getUniformLocation(sp, "u_bias")!,
      uIntensity:  gl.getUniformLocation(sp, "u_intensity")!,
      uProjection: gl.getUniformLocation(sp, "u_projection")!,
      uFar:        gl.getUniformLocation(sp, "u_far")!,
    };
  }

  // Bilateral blur program
  const bp = createProgram(gl, POST_VERT_SRC, SSAO_BLUR_FRAG_SRC, inst.isWebGL2);
  if (bp) {
    inst.ssaoBlurProg = bp;
    inst.ssaoBlurLocs = {
      aPosition:  gl.getAttribLocation(bp, "a_position"),
      uTexture:   gl.getUniformLocation(bp, "u_texture")!,
      uDepth:     gl.getUniformLocation(bp, "u_depth")!,
      uTexelSize: gl.getUniformLocation(bp, "u_texelSize")!,
    };
  }

  // Composite program
  const cp = createProgram(gl, POST_VERT_SRC, SSAO_COMPOSITE_FRAG_SRC, inst.isWebGL2);
  if (cp) {
    inst.ssaoCompProg = cp;
    inst.ssaoCompLocs = {
      aPosition: gl.getAttribLocation(cp, "a_position"),
      uScene:    gl.getUniformLocation(cp, "u_scene")!,
      uSsao:     gl.getUniformLocation(cp, "u_ssao")!,
    };
  }
}
