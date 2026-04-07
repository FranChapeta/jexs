/**
 * 3D program initialization: main 3D shader, instanced shader, geometry VBOs, skybox.
 * Extracted from GlNode.ts for modularity.
 */

import type { GlInstance } from "./types.js";
import {
  VERT_3D_SRC, FRAG_3D_SRC, VERT_3D_INST_SRC,
  SKYBOX_VERT_SRC, SKYBOX_FRAG_SRC,
  GEO_STRIDE_BYTES, INST_STRIDE_BYTES,
  POST_QUAD_VERTS,
} from "./shaders.js";
import {
  CUBE_VERTS, CYLINDER_VERTS, SPHERE_VERTS, CONE_VERTS, RAMP_VERTS,
  FLAT_QUAD_VERTS, FLAT_CIRCLE_VERTS, FLAT_TRI_VERTS,
} from "./geometry.js";

type CreateProgram = (gl: WebGLRenderingContext, vert: string, frag: string, isWebGL2: boolean) => WebGLProgram | null;

export function init3dProgram(inst: GlInstance, createProgram: CreateProgram): void {
  const gl = inst.gl;
  const prog = createProgram(gl, VERT_3D_SRC, FRAG_3D_SRC, inst.isWebGL2);
  if (!prog) { console.error("[GL] Failed to compile 3D shaders"); return; }
  inst.prog3d = prog;
  inst.prog3dBuf = gl.createBuffer()!;
  inst.prog3dLocs = {
    aPosition:   gl.getAttribLocation(prog, "a_position"),
    aNormal:     gl.getAttribLocation(prog, "a_normal"),
    aColor:      gl.getAttribLocation(prog, "a_color"),
    aUv:         gl.getAttribLocation(prog, "a_uv"),
    aUseTex:     gl.getAttribLocation(prog, "a_useTexture"),
    uEmissive:   gl.getUniformLocation(prog, "u_emissive")!,
    uProjection: gl.getUniformLocation(prog, "u_projection")!,
    uView:       gl.getUniformLocation(prog, "u_view")!,
    uModel:      gl.getUniformLocation(prog, "u_model")!,
    uTexture:    gl.getUniformLocation(prog, "u_texture")!,
    uLightDir:   gl.getUniformLocation(prog, "u_lightDir")!,
    uAmbient:    gl.getUniformLocation(prog, "u_ambient")!,
    uEyePos:     gl.getUniformLocation(prog, "u_eyePos")!,
    uShininess:  gl.getUniformLocation(prog, "u_shininess")!,
    uLightColor:   gl.getUniformLocation(prog, "u_lightColor")!,
    uAmbientColor: gl.getUniformLocation(prog, "u_ambientColor")!,
    uNumPL:    gl.getUniformLocation(prog, "u_numPL")!,
    uPlPos:    gl.getUniformLocation(prog, "u_plPos")!,
    uPlColor:  gl.getUniformLocation(prog, "u_plColor")!,
    uPlRadius: gl.getUniformLocation(prog, "u_plRadius")!,
    uPlCone:   gl.getUniformLocation(prog, "u_plCone")!,
    uPlDir:    gl.getUniformLocation(prog, "u_plDir")!,
    uFogColor: gl.getUniformLocation(prog, "u_fogColor")!,
    uFogNear:  gl.getUniformLocation(prog, "u_fogNear")!,
    uFogFar:   gl.getUniformLocation(prog, "u_fogFar")!,
    uShadowMap:       gl.getUniformLocation(prog, "u_shadowMap")!,
    uLightViewProj:   gl.getUniformLocation(prog, "u_lightViewProj[0]")!,
    uCascadeSplits:   gl.getUniformLocation(prog, "u_cascadeSplits")!,
    uShadowEnabled:   gl.getUniformLocation(prog, "u_shadowEnabled")!,
    uShadowBias:      gl.getUniformLocation(prog, "u_shadowBias")!,
    uShadowTexelSize: gl.getUniformLocation(prog, "u_shadowTexelSize")!,
    uShadowSoftness:  gl.getUniformLocation(prog, "u_shadowSoftness")!,
    uNormalMap:        gl.getUniformLocation(prog, "u_normalMap")!,
    uNormalMapEnabled: gl.getUniformLocation(prog, "u_normalMapEnabled")!,
    uNormalScale:      gl.getUniformLocation(prog, "u_normalScale")!,
    uSsaoMap:          gl.getUniformLocation(prog, "u_ssaoMap")!,
    uSsaoEnabled:      gl.getUniformLocation(prog, "u_ssaoEnabled")!,
    uSsaoTexelSize:    gl.getUniformLocation(prog, "u_ssaoTexelSize")!,
  };

  // Enable OES_standard_derivatives for normal mapping (WebGL1 only; built-in for WebGL2)
  if (!inst.isWebGL2) gl.getExtension("OES_standard_derivatives");

  // ── Instanced rendering setup ──────────────────────────────────────────
  const ext: ANGLE_instanced_arrays | null = inst.isWebGL2
    ? {
        drawArraysInstancedANGLE: (m: number, f: number, c: number, p: number) =>
          (gl as WebGL2RenderingContext).drawArraysInstanced(m, f, c, p),
        drawElementsInstancedANGLE: (m: number, c: number, t: number, o: number, p: number) =>
          (gl as WebGL2RenderingContext).drawElementsInstanced(m, c, t, o, p),
        vertexAttribDivisorANGLE: (i: number, d: number) =>
          (gl as WebGL2RenderingContext).vertexAttribDivisor(i, d),
        VERTEX_ATTRIB_ARRAY_DIVISOR_ANGLE: 0x88FE,
      }
    : gl.getExtension("ANGLE_instanced_arrays");
  if (ext) {
    inst.extInstanced = ext;
    const ip = createProgram(gl, VERT_3D_INST_SRC, FRAG_3D_SRC, inst.isWebGL2);
    if (ip) {
      inst.progInst = ip;
      inst.progInstLocs = {
        aPosition: gl.getAttribLocation(ip, "a_position"),
        aNormal:   gl.getAttribLocation(ip, "a_normal"),
        aModel0:   gl.getAttribLocation(ip, "a_model0"),
        aModel1:   gl.getAttribLocation(ip, "a_model1"),
        aModel2:   gl.getAttribLocation(ip, "a_model2"),
        aModel3:   gl.getAttribLocation(ip, "a_model3"),
        aColor:    gl.getAttribLocation(ip, "a_color"),
        aUvRect:   gl.getAttribLocation(ip, "a_uvRect"),
        aExtra:    gl.getAttribLocation(ip, "a_extra"),
        uProjection: gl.getUniformLocation(ip, "u_projection")!,
        uView:       gl.getUniformLocation(ip, "u_view")!,
        uTexture:    gl.getUniformLocation(ip, "u_texture")!,
        uLightDir:   gl.getUniformLocation(ip, "u_lightDir")!,
        uAmbient:    gl.getUniformLocation(ip, "u_ambient")!,
        uEyePos:     gl.getUniformLocation(ip, "u_eyePos")!,
        uShininess:  gl.getUniformLocation(ip, "u_shininess")!,
        uLightColor:   gl.getUniformLocation(ip, "u_lightColor")!,
        uAmbientColor: gl.getUniformLocation(ip, "u_ambientColor")!,
        uNumPL:    gl.getUniformLocation(ip, "u_numPL")!,
        uPlPos:    gl.getUniformLocation(ip, "u_plPos")!,
        uPlColor:  gl.getUniformLocation(ip, "u_plColor")!,
        uPlRadius: gl.getUniformLocation(ip, "u_plRadius")!,
        uPlCone:   gl.getUniformLocation(ip, "u_plCone")!,
        uPlDir:    gl.getUniformLocation(ip, "u_plDir")!,
        uFogColor: gl.getUniformLocation(ip, "u_fogColor")!,
        uFogNear:  gl.getUniformLocation(ip, "u_fogNear")!,
        uFogFar:   gl.getUniformLocation(ip, "u_fogFar")!,
        uShadowMap:       gl.getUniformLocation(ip, "u_shadowMap")!,
        uLightViewProj:   gl.getUniformLocation(ip, "u_lightViewProj[0]")!,
        uCascadeSplits:   gl.getUniformLocation(ip, "u_cascadeSplits")!,
        uShadowEnabled:   gl.getUniformLocation(ip, "u_shadowEnabled")!,
        uShadowBias:      gl.getUniformLocation(ip, "u_shadowBias")!,
        uShadowTexelSize: gl.getUniformLocation(ip, "u_shadowTexelSize")!,
        uShadowSoftness:  gl.getUniformLocation(ip, "u_shadowSoftness")!,
        uNormalMap:        gl.getUniformLocation(ip, "u_normalMap")!,
        uNormalMapEnabled: gl.getUniformLocation(ip, "u_normalMapEnabled")!,
        uNormalScale:      gl.getUniformLocation(ip, "u_normalScale")!,
        uSsaoMap:          gl.getUniformLocation(ip, "u_ssaoMap")!,
        uSsaoEnabled:      gl.getUniformLocation(ip, "u_ssaoEnabled")!,
        uSsaoTexelSize:    gl.getUniformLocation(ip, "u_ssaoTexelSize")!,
      };
      inst.instanceBuf = gl.createBuffer()!;

      // Create static geometry VBOs for all shape types
      const shapes = [
        CUBE_VERTS, CYLINDER_VERTS, SPHERE_VERTS, CONE_VERTS, RAMP_VERTS,
        FLAT_QUAD_VERTS, FLAT_CIRCLE_VERTS, FLAT_TRI_VERTS,
      ];
      for (const geo of shapes) {
        const buf = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, geo, gl.STATIC_DRAW);
        inst.geoVBOs.set(geo, { buf, vertCount: geo.length / 6 });
      }
    }
  }

  // ── Skybox gradient program ───────────────────────────────────────────
  const skyProg = createProgram(gl, SKYBOX_VERT_SRC, SKYBOX_FRAG_SRC, inst.isWebGL2);
  if (skyProg) {
    inst.skyboxProg = skyProg;
    inst.skyboxLocs = {
      aPosition:  gl.getAttribLocation(skyProg, "a_position"),
      uSkyTop:    gl.getUniformLocation(skyProg, "u_skyTop")!,
      uSkyBottom: gl.getUniformLocation(skyProg, "u_skyBottom")!,
      uSunPos:    gl.getUniformLocation(skyProg, "u_sunPos")!,
      uAspect:    gl.getUniformLocation(skyProg, "u_aspect")!,
    };
    const sbuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, sbuf);
    gl.bufferData(gl.ARRAY_BUFFER, POST_QUAD_VERTS, gl.STATIC_DRAW);
    inst.skyboxBuf = sbuf;
  }
}
