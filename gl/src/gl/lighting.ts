/**
 * Point/spot light collection and uniform upload.
 * Extracted from GlNode.ts for modularity.
 */

import {
  STRIDE, F_X, F_Y, F_W, F_H, F_Z, F_D,
  F_CR, F_CG, F_CB, F_FLAGS, FLAG_VISIBLE,
} from "@jexs/physics";
import type { EntityStore } from "@jexs/physics";
import type { GlInstance } from "./types.js";
import { _plPos, _plCol, _plRad, _plCone, _plDir } from "./math.js";

export interface PointLightLocs {
  uNumPL: WebGLUniformLocation;
  uPlPos: WebGLUniformLocation;
  uPlColor: WebGLUniformLocation;
  uPlRadius: WebGLUniformLocation;
  uPlCone: WebGLUniformLocation;
  uPlDir: WebGLUniformLocation;
}

/**
 * Rebuild light slot cache if dirty, then collect point light data
 * from the entity store into inst.pointLights.
 */
export function collectPointLights(inst: GlInstance, store: EntityStore): void {
  const d = store.data;

  // Rebuild light slot cache when dirty (entity added/removed)
  if (inst.lightsDirty) {
    inst.lightSlots.length = 0;
    for (let si = 0; si < store.count; si++) {
      const meta = store.meta[si];
      if (meta && meta.type === "light") inst.lightSlots.push(si);
    }
    inst.lightsDirty = false;
  }

  // Read light data from cached slots
  inst.pointLightCount = 0;
  const pl = inst.pointLights;
  for (let li = 0; li < inst.lightSlots.length && inst.pointLightCount < 8; li++) {
    const si = inst.lightSlots[li];
    const lb = si * STRIDE;
    if (!(d[lb + F_FLAGS] & FLAG_VISIBLE)) continue;
    const meta = store.meta[si]!;
    const oi = inst.pointLightCount * 12;
    pl[oi]     = d[lb + F_X] + d[lb + F_W] * 0.5;
    pl[oi + 1] = d[lb + F_Y] + d[lb + F_H] * 0.5;
    pl[oi + 2] = d[lb + F_Z] + (d[lb + F_D] || 0);
    pl[oi + 3] = d[lb + F_CR]; pl[oi + 4] = d[lb + F_CG]; pl[oi + 5] = d[lb + F_CB];
    pl[oi + 6] = (meta.custom?.radius as number) ?? 30;
    pl[oi + 7] = (meta.custom?.coneAngle as number) ?? 0;
    pl[oi + 8] = (meta.custom?.dirX as number) ?? 0;
    pl[oi + 9] = (meta.custom?.dirY as number) ?? 0;
    pl[oi + 10] = (meta.custom?.dirZ as number) ?? -1;
    pl[oi + 11] = 0;
    inst.pointLightCount++;
  }
}

/**
 * Upload point light uniforms to a shader program using preallocated buffers.
 */
export interface SceneUniformLocs {
  uLightDir: WebGLUniformLocation; uAmbient: WebGLUniformLocation;
  uEyePos: WebGLUniformLocation; uShininess: WebGLUniformLocation;
  uLightColor: WebGLUniformLocation; uAmbientColor: WebGLUniformLocation;
  uTexture: WebGLUniformLocation;
  uFogColor: WebGLUniformLocation; uFogNear: WebGLUniformLocation; uFogFar: WebGLUniformLocation;
  uShadowMap: WebGLUniformLocation; uLightViewProj: WebGLUniformLocation;
  uCascadeSplits: WebGLUniformLocation;
  uShadowEnabled: WebGLUniformLocation; uShadowBias: WebGLUniformLocation;
  uShadowTexelSize: WebGLUniformLocation; uShadowSoftness: WebGLUniformLocation;
  uNormalMap: WebGLUniformLocation; uNormalMapEnabled: WebGLUniformLocation;
  uNormalScale: WebGLUniformLocation;
  uSsaoMap: WebGLUniformLocation; uSsaoEnabled: WebGLUniformLocation;
  uSsaoTexelSize: WebGLUniformLocation;
}

/** Upload shared scene uniforms (lighting, fog, shadow, texture unit) to a 3D program. */
export function setSceneUniforms(
  gl: WebGLRenderingContext, inst: GlInstance, locs: SceneUniformLocs,
  eyeX: number, eyeY: number, eyeZ: number,
): void {
  gl.uniform3fv(locs.uLightDir, inst.lightDir);
  gl.uniform1f(locs.uAmbient, inst.ambient);
  gl.uniform3f(locs.uEyePos, eyeX, eyeY, eyeZ);
  gl.uniform1f(locs.uShininess, inst.shininess);
  gl.uniform3fv(locs.uLightColor, inst.lightColor);
  gl.uniform3fv(locs.uAmbientColor, inst.ambientColor);
  gl.uniform1i(locs.uTexture, 0);
  gl.uniform3fv(locs.uFogColor, inst.fogColor);
  gl.uniform1f(locs.uFogNear, inst.fogNear);
  gl.uniform1f(locs.uFogFar, inst.fogFar);
  // Shadow uniforms (cascaded)
  if (inst.shadow && inst.shadowTex) {
    gl.uniform1f(locs.uShadowEnabled, 1.0);
    gl.uniform1f(locs.uShadowBias, inst.shadow.bias);
    gl.uniform1f(locs.uShadowTexelSize, 1.0 / inst.shadow.resolution);
    gl.uniform1f(locs.uShadowSoftness, inst.shadow.softness);
    gl.uniform3fv(locs.uCascadeSplits, inst.shadowCascadeSplits);
    gl.uniformMatrix4fv(locs.uLightViewProj, false, inst.shadowLightVP);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, inst.shadowTex);
    gl.uniform1i(locs.uShadowMap, 1);
    gl.activeTexture(gl.TEXTURE0);
  } else {
    gl.uniform1f(locs.uShadowEnabled, 0.0);
  }
  // Normal map defaults
  gl.uniform1f(locs.uNormalMapEnabled, 0.0);
  gl.uniform1f(locs.uNormalScale, 1.0);
  gl.uniform1i(locs.uNormalMap, 2);
  // SSAO
  if (inst.ssao && inst.ssaoBlurTex) {
    gl.uniform1f(locs.uSsaoEnabled, 1.0);
    gl.uniform2f(locs.uSsaoTexelSize, 1.0 / inst.store.width, 1.0 / inst.store.height);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, inst.ssaoBlurTex);
    gl.uniform1i(locs.uSsaoMap, 3);
    gl.activeTexture(gl.TEXTURE0);
  } else {
    gl.uniform1f(locs.uSsaoEnabled, 0.0);
  }
}

export function uploadPointLights(gl: WebGLRenderingContext, inst: GlInstance, locs: PointLightLocs): void {
  const n = inst.pointLightCount;
  const pl = inst.pointLights;
  gl.uniform1i(locs.uNumPL, n);
  if (n > 0) {
    for (let i = 0; i < n; i++) {
      const o = i * 12;
      _plPos[i*3] = pl[o]; _plPos[i*3+1] = pl[o+1]; _plPos[i*3+2] = pl[o+2];
      _plCol[i*3] = pl[o+3]; _plCol[i*3+1] = pl[o+4]; _plCol[i*3+2] = pl[o+5];
      _plRad[i] = pl[o+6]; _plCone[i] = pl[o+7];
      _plDir[i*3] = pl[o+8]; _plDir[i*3+1] = pl[o+9]; _plDir[i*3+2] = pl[o+10];
    }
    gl.uniform3fv(locs.uPlPos, _plPos.subarray(0, n * 3));
    gl.uniform3fv(locs.uPlColor, _plCol.subarray(0, n * 3));
    gl.uniform1fv(locs.uPlRadius, _plRad.subarray(0, n));
    gl.uniform1fv(locs.uPlCone, _plCone.subarray(0, n));
    gl.uniform3fv(locs.uPlDir, _plDir.subarray(0, n * 3));
  }
}
