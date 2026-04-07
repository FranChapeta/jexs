/**
 * GPU particle emitter: initialization, emission, and rendering.
 * Extracted from GlNode.ts for modularity.
 */

import type { GlInstance, GpuParticleEmitter } from "./types.js";
import { GPU_PARTICLE_VERT_SRC, GPU_PARTICLE_FRAG_SRC, GPU_PARTICLE_INST_STRIDE, GPU_PARTICLE_INST_BYTES } from "./shaders.js";
import { _projM, _viewM } from "./math.js";

/**
 * Emit particles into a ring buffer.
 */
export function emitGpuParticles(inst: GlInstance, em: GpuParticleEmitter, x: number, y: number, z: number, count: number): void {
  const gl = inst.gl;
  const time = inst.lastTime / 1000;
  const S = GPU_PARTICLE_INST_STRIDE;
  const data = em.data;

  for (let i = 0; i < count; i++) {
    const idx = em.head * S;
    em.head = (em.head + 1) % em.maxParticles;

    const theta = (Math.random() - 0.5) * em.spread;
    const phi = Math.random() * Math.PI * 2;
    const ct = Math.cos(theta), st = Math.sin(theta);
    const cp = Math.cos(phi), sp = Math.sin(phi);
    const s = em.speed * (0.5 + Math.random() * 0.5);

    data[idx]     = x;
    data[idx + 1] = y;
    data[idx + 2] = z;
    data[idx + 3] = time;
    data[idx + 4] = (em.dirX * ct + st * cp) * s;
    data[idx + 5] = (em.dirY * ct + st * sp) * s;
    data[idx + 6] = (em.dirZ * ct + st * cp * sp) * s;
    data[idx + 7] = em.size;
    data[idx + 8]  = em.color[0];
    data[idx + 9]  = em.color[1];
    data[idx + 10] = em.color[2];
    data[idx + 11] = em.color[3];
    data[idx + 12] = em.colorEnd[0];
    data[idx + 13] = em.colorEnd[1];
    data[idx + 14] = em.colorEnd[2];
    data[idx + 15] = em.sizeEnd;
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, em.vbo);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
}

/**
 * Compile GPU particle shader program (called once lazily).
 * Requires a createProgram function since GlNode owns shader compilation.
 */
export function initGpuParticleProgram(
  inst: GlInstance,
  createProgram: (gl: WebGLRenderingContext, vert: string, frag: string, isWebGL2: boolean) => WebGLProgram | null,
): void {
  const gl = inst.gl;
  const prog = createProgram(gl, GPU_PARTICLE_VERT_SRC, GPU_PARTICLE_FRAG_SRC, inst.isWebGL2);
  if (!prog) { console.error("[GL] Failed to compile GPU particle shaders"); return; }
  inst.gpuParticleProg = prog;
  inst.gpuParticleLocs = {
    aCorner:     gl.getAttribLocation(prog, "a_corner"),
    aPosLife:    gl.getAttribLocation(prog, "a_posLife"),
    aVelSize:    gl.getAttribLocation(prog, "a_velSize"),
    aColorStart: gl.getAttribLocation(prog, "a_colorStart"),
    aColorEnd:   gl.getAttribLocation(prog, "a_colorEnd"),
    uProjection: gl.getUniformLocation(prog, "u_projection")!,
    uView:       gl.getUniformLocation(prog, "u_view")!,
    uEyePos:     gl.getUniformLocation(prog, "u_eyePos")!,
    uTime:       gl.getUniformLocation(prog, "u_time")!,
    uGravity:    gl.getUniformLocation(prog, "u_gravity")!,
    uLifetime:   gl.getUniformLocation(prog, "u_lifetime")!,
    uTexture:    gl.getUniformLocation(prog, "u_texture")!,
    uUseTexture: gl.getUniformLocation(prog, "u_useTexture")!,
  };
  const quadVerts = new Float32Array([
    -0.5, -0.5,  0.5, -0.5,  -0.5, 0.5,
     0.5, -0.5,  0.5,  0.5,  -0.5, 0.5,
  ]);
  inst.gpuParticleQuadBuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, inst.gpuParticleQuadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);
}

/**
 * Render all GPU particle emitters. Returns draw call count.
 * Also handles continuous emission ticking.
 */
export function renderGpuParticles(
  inst: GlInstance, gl: WebGLRenderingContext,
  camX: number, camY: number, camZ: number, delta: number,
): number {
  if (inst.gpuParticles.size === 0 || !inst.gpuParticleProg || !inst.gpuParticleLocs || !inst.extInstanced) return 0;

  const ext = inst.extInstanced;
  const gpl = inst.gpuParticleLocs;
  let drawCalls = 0;

  gl.useProgram(inst.gpuParticleProg);
  gl.uniformMatrix4fv(gpl.uProjection, false, _projM);
  gl.uniformMatrix4fv(gpl.uView, false, _viewM);
  gl.uniform3f(gpl.uEyePos, camX, camY, camZ);
  gl.uniform1f(gpl.uTime, inst.lastTime / 1000);

  gl.depthMask(false);

  for (const em of inst.gpuParticles.values()) {
    // Continuous emission
    if (em.continuous && delta > 0) {
      em.accumulator += em.rate * delta;
      const toEmit = Math.floor(em.accumulator);
      if (toEmit > 0) {
        em.accumulator -= toEmit;
        emitGpuParticles(inst, em, em.x, em.y, em.z, toEmit);
      }
    }

    gl.uniform3f(gpl.uGravity, em.gravity[0], em.gravity[1], em.gravity[2]);
    gl.uniform1f(gpl.uLifetime, em.lifetime);

    // Texture
    const texInfo = em.texture ? inst.textures.get(em.texture) : null;
    if (texInfo) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texInfo.tex);
      gl.uniform1f(gpl.uUseTexture, 1.0);
      gl.uniform1i(gpl.uTexture, 0);
    } else {
      gl.uniform1f(gpl.uUseTexture, 0.0);
    }

    // Blend mode
    if (em.blend === "additive") {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    }

    // Bind shared quad geometry
    gl.bindBuffer(gl.ARRAY_BUFFER, inst.gpuParticleQuadBuf);
    gl.enableVertexAttribArray(gpl.aCorner);
    gl.vertexAttribPointer(gpl.aCorner, 2, gl.FLOAT, false, 0, 0);

    // Bind per-instance data
    gl.bindBuffer(gl.ARRAY_BUFFER, em.vbo);
    const attrs = [gpl.aPosLife, gpl.aVelSize, gpl.aColorStart, gpl.aColorEnd];
    for (let i = 0; i < 4; i++) {
      gl.enableVertexAttribArray(attrs[i]);
      gl.vertexAttribPointer(attrs[i], 4, gl.FLOAT, false, GPU_PARTICLE_INST_BYTES, i * 16);
      ext.vertexAttribDivisorANGLE(attrs[i], 1);
    }

    ext.drawArraysInstancedANGLE(gl.TRIANGLES, 0, 6, em.maxParticles);
    drawCalls++;

    for (const a of attrs) ext.vertexAttribDivisorANGLE(a, 0);

    if (em.blend === "additive") {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
  }

  gl.depthMask(true);
  return drawCalls;
}

/**
 * Check if any emitters have active particles or are continuous.
 */
export function hasActiveParticles(inst: GlInstance): boolean {
  const now = inst.lastTime / 1000;
  for (const em of inst.gpuParticles.values()) {
    if (em.continuous) return true;
    for (let i = 0; i < em.maxParticles; i++) {
      const spawn = em.data[i * GPU_PARTICLE_INST_STRIDE + 3];
      if (now - spawn < em.lifetime) return true;
    }
  }
  return false;
}
