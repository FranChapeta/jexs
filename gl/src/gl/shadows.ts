/**
 * Cascaded shadow map initialization and cascade computation.
 * Extracted from GlNode.ts for modularity.
 */

import type { GlInstance } from "./types.js";
import { mat4LookAt, mat4Ortho, mat4Multiply, mat4Model } from "./math.js";
import {
  SHADOW_VERT_SRC, SHADOW_FRAG_SRC, SHADOW_INST_VERT_SRC,
} from "./shaders.js";
import { SHAPE_3D } from "./geometry.js";
import {
  STRIDE, F_X, F_Y, F_Z, F_W, F_H, F_D,
  F_RX, F_RY, F_ANGLE, F_FLAGS, FLAG_VISIBLE,
} from "@jexs/physics";

type CreateProgram = (gl: WebGLRenderingContext, vert: string, frag: string, isWebGL2: boolean) => WebGLProgram | null;

export function initShadow(inst: GlInstance, createProgram: CreateProgram): void {
  const gl = inst.gl;
  if (!inst.shadow) return;
  const res = inst.shadow.resolution;
  const atlasW = res * 3;

  const fbo = gl.createFramebuffer();
  const tex = gl.createTexture();
  if (!fbo || !tex) return;

  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, atlasW, res, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  const depthBuf = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuf);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, atlasW, res);

  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuf);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);

  inst.shadowFbo = fbo;
  inst.shadowTex = tex;

  const sp = createProgram(gl, SHADOW_VERT_SRC, SHADOW_FRAG_SRC, inst.isWebGL2);
  if (sp) {
    inst.shadowProg = sp;
    inst.shadowLocs = {
      aPosition:      gl.getAttribLocation(sp, "a_position"),
      uLightViewProj: gl.getUniformLocation(sp, "u_lightViewProj")!,
      uModel:         gl.getUniformLocation(sp, "u_model")!,
    };
  }

  if (inst.extInstanced) {
    const sip = createProgram(gl, SHADOW_INST_VERT_SRC, SHADOW_FRAG_SRC, inst.isWebGL2);
    if (sip) {
      inst.shadowInstProg = sip;
      inst.shadowInstLocs = {
        aPosition: gl.getAttribLocation(sip, "a_position"),
        aModel0:   gl.getAttribLocation(sip, "a_model0"),
        aModel1:   gl.getAttribLocation(sip, "a_model1"),
        aModel2:   gl.getAttribLocation(sip, "a_model2"),
        aModel3:   gl.getAttribLocation(sip, "a_model3"),
        uLightViewProj: gl.getUniformLocation(sip, "u_lightViewProj")!,
      };
    }
  }
}

/**
 * Render the cascaded shadow depth pass.
 * Writes depth into the shadow atlas FBO. Restores GL state afterward.
 */
export function renderShadowPass(
  inst: GlInstance, needsPost: boolean,
  clearColor: readonly [number, number, number, number],
  cw: number, ch: number,
): void {
  if (!inst.shadow || !inst.shadowFbo || !inst.shadowProg || !inst.shadowLocs) return;

  const gl = inst.gl;
  const store = inst.store;
  computeShadowCascades(inst);
  const res = inst.shadow.resolution;

  gl.bindFramebuffer(gl.FRAMEBUFFER, inst.shadowFbo);
  gl.viewport(0, 0, res * 3, res);
  gl.clearColor(1, 1, 1, 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);

  gl.useProgram(inst.shadowProg);
  const aPos = inst.shadowLocs.aPosition;

  for (let cascade = 0; cascade < 3; cascade++) {
    gl.viewport(cascade * res, 0, res, res);
    gl.uniformMatrix4fv(inst.shadowLocs.uLightViewProj, false,
      inst.shadowLightVP.subarray(cascade * 16, cascade * 16 + 16));

    for (let i = 0; i < store.count; i++) {
      const b = i * STRIDE;
      if (!(store.data[b + F_FLAGS] & FLAG_VISIBLE)) continue;
      const meta = store.meta[i];
      if (!meta || meta.emissive) continue;
      const verts = SHAPE_3D[meta.type];
      if (!verts) continue;

      const model = mat4Model(
        store.data[b + F_X], store.data[b + F_Y], store.data[b + F_Z],
        store.data[b + F_W], store.data[b + F_H], store.data[b + F_D] || 1,
        store.data[b + F_RX], store.data[b + F_RY], store.data[b + F_ANGLE],
      );
      gl.uniformMatrix4fv(inst.shadowLocs.uModel, false, model);

      if (inst.prog3dBuf) {
        gl.bindBuffer(gl.ARRAY_BUFFER, inst.prog3dBuf);
        gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 24, 0);
        gl.drawArrays(gl.TRIANGLES, 0, verts.length / 6);
      }
    }
  }

  // Restore state
  gl.bindFramebuffer(gl.FRAMEBUFFER, needsPost ? inst.fboA : null);
  gl.viewport(0, 0, cw, ch);
  gl.clearColor(clearColor[0], clearColor[1], clearColor[2], clearColor[3]);
}

export function computeShadowCascades(inst: GlInstance): void {
  if (!inst.shadow) return;
  const cam = inst.camera;
  const near = cam.near;
  const far = Math.min(cam.far, inst.shadow.far);
  const aspect = inst.canvas.width / inst.canvas.height;
  const tanHalf = Math.tan(cam.fov * Math.PI / 360);
  const ld = inst.lightDir;

  const ex = cam.x + cam.shakeX, ey = cam.y + cam.shakeY, ez = cam.z;
  const la = cam.lookAt;
  let fx = la[0] - ex, fy = la[1] - ey, fz = la[2] - ez;
  const fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
  fx /= fl; fy /= fl; fz /= fl;
  const up = cam.up;
  let rx = fy * up[2] - fz * up[1], ry = fz * up[0] - fx * up[2], rz = fx * up[1] - fy * up[0];
  const rl = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;

  const splits = inst.shadowCascadeSplits;
  for (let i = 0; i < 3; i++) {
    const p = (i + 1) / 3;
    splits[i] = 0.5 * (near * Math.pow(far / near, p)) + 0.5 * (near + (far - near) * p);
  }

  for (let c = 0; c < 3; c++) {
    const cNear = c === 0 ? near : splits[c - 1];
    const cFar = splits[c];
    const nh = cNear * tanHalf, nw = nh * aspect;
    const fh = cFar * tanHalf, fw = fh * aspect;

    let scx = 0, scy = 0, scz = 0;
    const corners = new Float32Array(24);
    let ci = 0;
    for (let zi = 0; zi < 2; zi++) {
      const z = zi === 0 ? cNear : cFar;
      const hw = zi === 0 ? nw : fw;
      const hh = zi === 0 ? nh : fh;
      for (let sx = -1; sx <= 1; sx += 2) {
        for (let sy = -1; sy <= 1; sy += 2) {
          const px = ex + fx * z + rx * hw * sx + ux * hh * sy;
          const py = ey + fy * z + ry * hw * sx + uy * hh * sy;
          const pz = ez + fz * z + rz * hw * sx + uz * hh * sy;
          corners[ci] = px; corners[ci + 1] = py; corners[ci + 2] = pz;
          scx += px; scy += py; scz += pz;
          ci += 3;
        }
      }
    }
    scx /= 8; scy /= 8; scz /= 8;

    let maxR2 = 0;
    for (let j = 0; j < 24; j += 3) {
      const dx = corners[j] - scx, dy = corners[j + 1] - scy, dz = corners[j + 2] - scz;
      maxR2 = Math.max(maxR2, dx * dx + dy * dy + dz * dz);
    }
    const radius = Math.ceil(Math.sqrt(maxR2) * 16) / 16;

    const lp = [scx - ld[0] * radius * 2, scy - ld[1] * radius * 2, scz - ld[2] * radius * 2];
    const lv = mat4LookAt(lp, [scx, scy, scz], [0, 1, 0]);
    const lo = mat4Ortho(-radius, radius, -radius, radius, 0.1, radius * 4);
    const lvp = mat4Multiply(lo, lv);

    const res = inst.shadow!.resolution;
    const worldPerTexel = (radius * 2) / res;
    lvp[12] = Math.round(lvp[12] / worldPerTexel) * worldPerTexel;
    lvp[13] = Math.round(lvp[13] / worldPerTexel) * worldPerTexel;

    inst.shadowLightVP.set(lvp, c * 16);
  }
}
