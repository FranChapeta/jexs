/**
 * MSDF text GL render path (Tier 2). Renders crisp, scalable text from an
 * author-supplied multi-channel signed-distance-field atlas + metrics, using the
 * standard median-of-3 reconstruction in the fragment shader.
 *
 * Pure GL here; parsing/layout is in `msdfText.ts`. The instance owns the shader
 * program (built lazily on first MSDF text) and a glyph-quad VBO; per text entity
 * we lay out the string into atlas-UV quads and draw them in one call.
 *
 * Coordinate space matches the default 2D path: quads are emitted in the entity's
 * local pixel space and positioned by the same `u_projection` mat3 the renderer
 * already computes (camera/fixed), so MSDF text lives in the same world as canvas
 * text and sprites.
 */
import { layoutText, type MsdfFont } from "./msdfText.js";

/** Lazily-built MSDF program + its locations. */
export interface MsdfProgram {
  program: WebGLProgram;
  aPos: number;        // vec2 glyph position (pixels, entity-local)
  aUv: number;         // vec2 atlas UV
  uProjection: WebGLUniformLocation | null;
  uOffset: WebGLUniformLocation | null;    // entity translation (pixels)
  uColor: WebGLUniformLocation | null;
  uAtlas: WebGLUniformLocation | null;
  uPxRange: WebGLUniformLocation | null;   // distanceRange scaled to screen px
  buffer: WebGLBuffer;
}

const VERT = `
attribute vec2 a_pos;
attribute vec2 a_uv;
uniform mat3 u_projection;
uniform vec2 u_offset;
varying vec2 v_uv;
void main() {
  v_uv = a_uv;
  vec3 p = u_projection * vec3(a_pos + u_offset, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`;

// Median-of-3 MSDF reconstruction. `u_pxRange` scales the SDF distance into
// screen pixels so the antialiasing width stays ~1px at any glyph size.
const FRAG = `
precision mediump float;
uniform sampler2D u_atlas;
uniform vec4 u_color;
uniform float u_pxRange;
varying vec2 v_uv;
float median(float r, float g, float b) {
  return max(min(r, g), min(max(r, g), b));
}
void main() {
  vec3 s = texture2D(u_atlas, v_uv).rgb;
  float sd = median(s.r, s.g, s.b);
  float screenPxDistance = u_pxRange * (sd - 0.5);
  float alpha = clamp(screenPxDistance + 0.5, 0.0, 1.0);
  if (alpha < 0.001) discard;
  gl_FragColor = vec4(u_color.rgb, u_color.a * alpha);
}`;

type CreateProgram = (gl: WebGLRenderingContext, vert: string, frag: string, isWebGL2: boolean) => WebGLProgram | null;

/** Build the MSDF program (call once per instance, lazily). */
export function initMsdfProgram(
  gl: WebGLRenderingContext,
  createProgram: CreateProgram,
  isWebGL2: boolean,
): MsdfProgram | null {
  const program = createProgram(gl, VERT, FRAG, isWebGL2);
  if (!program) return null;
  return {
    program,
    aPos: gl.getAttribLocation(program, "a_pos"),
    aUv: gl.getAttribLocation(program, "a_uv"),
    uProjection: gl.getUniformLocation(program, "u_projection"),
    uOffset: gl.getUniformLocation(program, "u_offset"),
    uColor: gl.getUniformLocation(program, "u_color"),
    uAtlas: gl.getUniformLocation(program, "u_atlas"),
    uPxRange: gl.getUniformLocation(program, "u_pxRange"),
    buffer: gl.createBuffer()!,
  };
}

/** Scratch interleaved [x,y,u,v] * 6 verts per glyph, grown as needed. */
let _quadData = new Float32Array(0);

/**
 * Draw `text` in `font` at the entity's pixel position. `projection` is the same
 * mat3 the renderer uses for this entity (camera or base). `color` is RGBA 0..1.
 * Returns the laid-out width/height so the caller can size the entity.
 */
export function drawMsdfText(
  gl: WebGLRenderingContext,
  mp: MsdfProgram,
  font: MsdfFont,
  tex: WebGLTexture,
  text: string,
  fontSize: number,
  projection: Float32Array,
  offsetX: number,
  offsetY: number,
  color: [number, number, number, number],
): { width: number; height: number } {
  const layout = layoutText(text, font, fontSize);
  const n = layout.quads.length;
  if (n === 0) return { width: layout.width, height: layout.height };

  const floats = n * 6 * 4; // 6 verts/glyph, 4 floats/vert (x,y,u,v)
  if (_quadData.length < floats) _quadData = new Float32Array(floats);
  const data = _quadData;

  let o = 0;
  for (const q of layout.quads) {
    const x0 = q.x, y0 = q.y, x1 = q.x + q.w, y1 = q.y + q.h;
    const u0 = q.u0, v0 = q.v0, u1 = q.u1, v1 = q.v1;
    // Two triangles (CCW): (x0,y0)(x1,y0)(x0,y1) + (x0,y1)(x1,y0)(x1,y1)
    data[o++] = x0; data[o++] = y0; data[o++] = u0; data[o++] = v0;
    data[o++] = x1; data[o++] = y0; data[o++] = u1; data[o++] = v0;
    data[o++] = x0; data[o++] = y1; data[o++] = u0; data[o++] = v1;
    data[o++] = x0; data[o++] = y1; data[o++] = u0; data[o++] = v1;
    data[o++] = x1; data[o++] = y0; data[o++] = u1; data[o++] = v0;
    data[o++] = x1; data[o++] = y1; data[o++] = u1; data[o++] = v1;
  }

  gl.useProgram(mp.program);
  gl.bindBuffer(gl.ARRAY_BUFFER, mp.buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, floats), gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(mp.aPos);
  gl.vertexAttribPointer(mp.aPos, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(mp.aUv);
  gl.vertexAttribPointer(mp.aUv, 2, gl.FLOAT, false, 16, 8);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(mp.uAtlas, 0);
  gl.uniformMatrix3fv(mp.uProjection, false, projection);
  gl.uniform2f(mp.uOffset, offsetX, offsetY);
  gl.uniform4f(mp.uColor, color[0], color[1], color[2], color[3]);
  // Screen px range: distanceRange (atlas px) scaled by the glyph render scale.
  const scale = fontSize / font.size;
  gl.uniform1f(mp.uPxRange, Math.max(1, (font.distanceRange || 2) * scale));

  gl.drawArrays(gl.TRIANGLES, 0, n * 6);
  return { width: layout.width, height: layout.height };
}
