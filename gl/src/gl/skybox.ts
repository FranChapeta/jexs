/**
 * Equirectangular env skybox — draws a registered texture (LDR panorama or float
 * HDR) as a backdrop sampled by the camera's view direction. Complements the
 * procedural `skyTop`/`skyBottom` gradient sky (shaders.ts): when `inst.envSky`
 * is set, this textured backdrop is drawn instead.
 *
 * A fullscreen triangle is drawn at the far plane; each fragment reconstructs its
 * world-space view direction from the inverse view-projection, converts it to
 * equirectangular UV (atan2 longitude / asin latitude), and samples the env map.
 */

export interface EquirectSkyProgram {
  program: WebGLProgram;
  aPos: number;
  uInvViewProj: WebGLUniformLocation | null;
  uEnv: WebGLUniformLocation | null;
  uIntensity: WebGLUniformLocation | null;
  uRotation: WebGLUniformLocation | null;
  buffer: WebGLBuffer;
}

type CreateProgram = (gl: WebGLRenderingContext, vert: string, frag: string, isWebGL2: boolean) => WebGLProgram | null;

const VERT = `
attribute vec2 a_pos;
varying vec2 v_ndc;
void main() {
  v_ndc = a_pos;
  gl_Position = vec4(a_pos, 1.0, 1.0); // z=1 → far plane (behind everything)
}`;

const FRAG = `
precision highp float;
uniform mat4 u_invViewProj;
uniform sampler2D u_env;
uniform float u_intensity;
uniform float u_rotation;
varying vec2 v_ndc;
const float PI = 3.14159265359;
void main() {
  // Reconstruct world-space view ray from this NDC point.
  vec4 near = u_invViewProj * vec4(v_ndc, -1.0, 1.0);
  vec4 far  = u_invViewProj * vec4(v_ndc,  1.0, 1.0);
  vec3 dir = normalize(far.xyz / far.w - near.xyz / near.w);
  // Direction → equirectangular UV (with yaw rotation).
  float lon = atan(dir.z, dir.x) + u_rotation;
  float lat = asin(clamp(dir.y, -1.0, 1.0));
  vec2 uv = vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);
  vec3 c = texture2D(u_env, uv).rgb * u_intensity;
  gl_FragColor = vec4(c, 1.0);
}`;

/** Build the equirect skybox program (lazily, once per instance). */
export function initEquirectSky(
  gl: WebGLRenderingContext, createProgram: CreateProgram, isWebGL2: boolean,
): EquirectSkyProgram | null {
  const program = createProgram(gl, VERT, FRAG, isWebGL2);
  if (!program) return null;
  // Fullscreen triangle.
  const buffer = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  return {
    program,
    aPos: gl.getAttribLocation(program, "a_pos"),
    uInvViewProj: gl.getUniformLocation(program, "u_invViewProj"),
    uEnv: gl.getUniformLocation(program, "u_env"),
    uIntensity: gl.getUniformLocation(program, "u_intensity"),
    uRotation: gl.getUniformLocation(program, "u_rotation"),
    buffer,
  };
}

/** Draw the equirect skybox. `invViewProj` is inverse(projection*view). */
export function drawEquirectSky(
  gl: WebGLRenderingContext, sky: EquirectSkyProgram, env: WebGLTexture,
  invViewProj: Float32Array, intensity: number, rotation: number,
): void {
  gl.useProgram(sky.program);
  gl.depthMask(false);          // don't write depth — it's the backdrop
  gl.disable(gl.DEPTH_TEST);
  gl.bindBuffer(gl.ARRAY_BUFFER, sky.buffer);
  gl.enableVertexAttribArray(sky.aPos);
  gl.vertexAttribPointer(sky.aPos, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, env);
  gl.uniform1i(sky.uEnv, 0);
  gl.uniformMatrix4fv(sky.uInvViewProj, false, invViewProj);
  gl.uniform1f(sky.uIntensity, intensity);
  gl.uniform1f(sky.uRotation, rotation);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.depthMask(true);
  gl.enable(gl.DEPTH_TEST);
}
