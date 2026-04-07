// ─── WebGL2 shader auto-upgrade ──────────────────────────────────────────────

/** Convert a WebGL1 vertex shader to GLSL 300 es. */
export function upgradeVert(src: string): string {
  return "#version 300 es\n" + src
    .replace(/\battribute\b/g, "in")
    .replace(/\bvarying\b/g, "out");
}

/** Convert a WebGL1 fragment shader to GLSL 300 es. */
export function upgradeFrag(src: string): string {
  // Extract precision qualifier so it appears before any declarations in GLSL 300 es
  const precMatch = src.match(/precision\s+(lowp|mediump|highp)\s+float\s*;/);
  const prec = precMatch ? precMatch[1] : "mediump";
  let s = src
    .replace(/\bvarying\b/g, "in")
    .replace(/\btexture2D\b/g, "texture")
    .replace(/\bgl_FragColor\b/g, "_fragColor")
    .replace(/#extension GL_OES_standard_derivatives\s*:\s*enable\s*\n?/g, "")
    .replace(/precision\s+(lowp|mediump|highp)\s+float\s*;\n?/g, "");
  return `#version 300 es\nprecision ${prec} float;\nout vec4 _fragColor;\n` + s;
}

// ─── Shaders ────────────────────────────────────────────────────────────────

export const VERT_SRC = `
attribute vec2 a_position;
uniform mat3 u_transform;
uniform mat3 u_projection;
uniform vec4 u_uvRect;
varying vec2 v_uv;
void main() {
  v_uv = u_uvRect.xy + a_position * u_uvRect.zw;
  vec3 pos = u_projection * u_transform * vec3(a_position, 1.0);
  gl_Position = vec4(pos.xy, 0.0, 1.0);
  gl_PointSize = 4.0;
}`;

export const FRAG_SRC = `
precision mediump float;
uniform vec4 u_color;
uniform sampler2D u_texture;
uniform bool u_useTexture;
varying vec2 v_uv;
void main() {
  if (u_useTexture) {
    gl_FragColor = texture2D(u_texture, v_uv) * u_color;
  } else {
    gl_FragColor = u_color;
  }
}`;

// ─── Batched shaders (per-vertex color/uv, CPU pre-transformed positions) ──

export const BATCH_VERT_SRC = `
attribute vec2 a_position;
attribute vec4 a_color;
attribute vec2 a_uv;
attribute float a_useTexture;
uniform mat3 u_projection;
varying vec2 v_uv;
varying vec4 v_color;
varying float v_useTexture;
void main() {
  v_uv = a_uv;
  v_color = a_color;
  v_useTexture = a_useTexture;
  vec3 pos = u_projection * vec3(a_position, 1.0);
  gl_Position = vec4(pos.xy, 0.0, 1.0);
}`;

export const BATCH_FRAG_SRC = `
precision mediump float;
uniform sampler2D u_texture;
varying vec2 v_uv;
varying vec4 v_color;
varying float v_useTexture;
void main() {
  if (v_useTexture > 0.5) {
    gl_FragColor = texture2D(u_texture, v_uv) * v_color;
  } else {
    gl_FragColor = v_color;
  }
}`;

export const BATCH_STRIDE_FLOATS = 9;
export const BATCH_STRIDE_BYTES = BATCH_STRIDE_FLOATS * 4; // 36

// ─── Post-process shaders ────────────────────────────────────────────────────

export const POST_VERT_SRC = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

export const POST_FRAG_SRC = `
precision mediump float;
uniform sampler2D u_texture;
uniform float u_opacity;
varying vec2 v_uv;
void main() {
  gl_FragColor = texture2D(u_texture, v_uv) * u_opacity;
}`;

export const BLUR_FRAG_SRC = `
precision mediump float;
uniform sampler2D u_texture;
uniform vec2 u_direction;
uniform float u_radius;
varying vec2 v_uv;
void main() {
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (float i = -8.0; i <= 8.0; i += 1.0) {
    float w = exp(-0.5 * i * i / (u_radius * u_radius));
    sum += texture2D(u_texture, v_uv + u_direction * i) * w;
    total += w;
  }
  gl_FragColor = sum / total;
}`;

// FXAA fragment shader (Nvidia FXAA 3.11 simplified for WebGL1)
export const FXAA_FRAG_SRC = `
precision mediump float;
uniform sampler2D u_texture;
uniform vec2 u_texelSize;
varying vec2 v_uv;
void main() {
  float FXAA_SPAN_MAX = 8.0;
  float FXAA_REDUCE_MUL = 1.0/8.0;
  float FXAA_REDUCE_MIN = 1.0/128.0;
  vec3 rgbNW = texture2D(u_texture, v_uv + vec2(-1.0, -1.0) * u_texelSize).rgb;
  vec3 rgbNE = texture2D(u_texture, v_uv + vec2( 1.0, -1.0) * u_texelSize).rgb;
  vec3 rgbSW = texture2D(u_texture, v_uv + vec2(-1.0,  1.0) * u_texelSize).rgb;
  vec3 rgbSE = texture2D(u_texture, v_uv + vec2( 1.0,  1.0) * u_texelSize).rgb;
  vec3 rgbM  = texture2D(u_texture, v_uv).rgb;
  vec3 luma = vec3(0.299, 0.587, 0.114);
  float lumaNW = dot(rgbNW, luma);
  float lumaNE = dot(rgbNE, luma);
  float lumaSW = dot(rgbSW, luma);
  float lumaSE = dot(rgbSE, luma);
  float lumaM  = dot(rgbM,  luma);
  float lumaMin = min(lumaM, min(min(lumaNW, lumaNE), min(lumaSW, lumaSE)));
  float lumaMax = max(lumaM, max(max(lumaNW, lumaNE), max(lumaSW, lumaSE)));
  vec2 dir;
  dir.x = -((lumaNW + lumaNE) - (lumaSW + lumaSE));
  dir.y =  ((lumaNW + lumaSW) - (lumaNE + lumaSE));
  float dirReduce = max((lumaNW + lumaNE + lumaSW + lumaSE) * 0.25 * FXAA_REDUCE_MUL, FXAA_REDUCE_MIN);
  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = min(vec2(FXAA_SPAN_MAX), max(vec2(-FXAA_SPAN_MAX), dir * rcpDirMin)) * u_texelSize;
  vec3 rgbA = 0.5 * (
    texture2D(u_texture, v_uv + dir * (1.0/3.0 - 0.5)).rgb +
    texture2D(u_texture, v_uv + dir * (2.0/3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (
    texture2D(u_texture, v_uv + dir * -0.5).rgb +
    texture2D(u_texture, v_uv + dir *  0.5).rgb);
  float lumaB = dot(rgbB, luma);
  vec3 finalColor = (lumaB < lumaMin || lumaB > lumaMax) ? rgbA : rgbB;
  gl_FragColor = vec4(finalColor, 1.0);
}`;

// Bloom brightness extraction
export const BLOOM_BRIGHT_FRAG_SRC = `
precision mediump float;
uniform sampler2D u_texture;
uniform float u_threshold;
varying vec2 v_uv;
void main() {
  vec4 c = texture2D(u_texture, v_uv);
  float brightness = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor = (brightness > u_threshold) ? c : vec4(0.0);
}`;

// Bloom composite: add bloom texture on top of scene
export const BLOOM_COMPOSITE_FRAG_SRC = `
precision mediump float;
uniform sampler2D u_texture;
uniform sampler2D u_bloom;
uniform float u_intensity;
varying vec2 v_uv;
void main() {
  vec3 scene = texture2D(u_texture, v_uv).rgb;
  vec3 bloom = texture2D(u_bloom, v_uv).rgb;
  gl_FragColor = vec4(scene + bloom * u_intensity, 1.0);
}`;

export const POST_QUAD_VERTS = new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1]);

// ─── Skybox atmospheric shaders ─────────────────────────────────────────────
export const SKYBOX_VERT_SRC = `
attribute vec2 a_position;
varying vec2 v_pos;
void main() {
  gl_Position = vec4(a_position, 0.9999, 1.0);
  v_pos = a_position;
}`;

export const SKYBOX_FRAG_SRC = `
precision mediump float;
uniform vec3 u_skyTop;
uniform vec3 u_skyBottom;
uniform vec2 u_sunPos;
uniform float u_aspect;
varying vec2 v_pos;
void main() {
  vec2 p = v_pos;
  p.x *= u_aspect;
  vec2 sp = u_sunPos;
  sp.x *= u_aspect;
  float height = v_pos.y * 0.5 + 0.5;
  vec3 zenith = u_skyTop;
  vec3 horizon = mix(u_skyBottom, u_skyTop, 0.35);
  float hCurve = height * height;
  vec3 sky = mix(horizon, zenith, hCurve);
  float sunDist = length(p - sp);
  float glow = exp(-sunDist * sunDist * 2.5);
  float halo = exp(-sunDist * 0.8);
  float disc = smoothstep(0.08, 0.03, sunDist);
  sky = mix(sky, u_skyBottom, glow * 0.8);
  sky += u_skyBottom * halo * 0.25;
  sky += vec3(1.0, 0.97, 0.85) * disc;
  float horizonGlow = exp(-height * height * 8.0);
  sky = mix(sky, u_skyBottom * 0.5 + vec3(0.15), horizonGlow * 0.3);
  gl_FragColor = vec4(sky, 1.0);
}`;

// ─── 3D Shaders ─────────────────────────────────────────────────────────────
// Per-vertex: position(3) + normal(3) + color(4) + uv(2) + useTex(1) = 13 floats
export const STRIDE_3D = 13;
export const STRIDE_3D_BYTES = STRIDE_3D * 4;

export const VERT_3D_SRC = `
attribute vec3 a_position;
attribute vec3 a_normal;
attribute vec4 a_color;
attribute vec2 a_uv;
attribute float a_useTexture;
uniform mat4 u_projection;
uniform mat4 u_view;
uniform mat4 u_model;
uniform float u_emissive;
varying vec2 v_uv;
varying vec4 v_color;
varying float v_useTexture;
varying vec3 v_normal;
varying vec3 v_worldPos;
varying float v_emissive;
varying float v_viewZ;
void main() {
  vec4 worldPos = u_model * vec4(a_position, 1.0);
  v_worldPos = worldPos.xyz;
  v_normal = mat3(u_model) * a_normal;
  v_uv = a_uv;
  v_color = a_color;
  v_useTexture = a_useTexture;
  v_emissive = u_emissive;
  v_viewZ = -(u_view * worldPos).z;
  gl_Position = u_projection * u_view * worldPos;
}`;

export const FRAG_3D_SRC = `
precision mediump float;
#extension GL_OES_standard_derivatives : enable
uniform sampler2D u_texture;
uniform vec3 u_lightDir;
uniform float u_ambient;
uniform vec3 u_eyePos;
uniform float u_shininess;
uniform vec3 u_lightColor;
uniform vec3 u_ambientColor;
// Point/spot lights (max 8)
uniform int u_numPL;
uniform vec3 u_plPos[8];
uniform vec3 u_plColor[8];
uniform float u_plRadius[8];
uniform float u_plCone[8];
uniform vec3 u_plDir[8];
// Fog
uniform vec3 u_fogColor;
uniform float u_fogNear;
uniform float u_fogFar;
// Shadow mapping (cascaded, 3 cascades)
uniform sampler2D u_shadowMap;
uniform mat4 u_lightViewProj[3];
uniform vec3 u_cascadeSplits;
uniform float u_shadowEnabled;
uniform float u_shadowBias;
uniform float u_shadowTexelSize;
uniform float u_shadowSoftness;
// Normal mapping
uniform sampler2D u_normalMap;
uniform float u_normalMapEnabled;
uniform float u_normalScale;
// SSAO (sampled in screen space, multiplied into ambient)
uniform sampler2D u_ssaoMap;
uniform float u_ssaoEnabled;
uniform vec2 u_ssaoTexelSize;
varying vec2 v_uv;
varying vec4 v_color;
varying float v_useTexture;
varying vec3 v_normal;
varying vec3 v_worldPos;
varying float v_emissive;
varying float v_viewZ;

// Unpack depth from RGBA (matches SHADOW_FRAG_SRC encoding)
float unpackDepth(vec4 c) {
  return dot(c, vec4(1.0, 1.0/255.0, 1.0/65025.0, 1.0/16581375.0));
}

// Poisson disk shadow sample with per-pixel rotation
float poissonShadow(vec2 base, vec2 offset, float r, float ca, float sa, float d, float ci) {
  vec2 o = vec2(ca * offset.x - sa * offset.y, sa * offset.x + ca * offset.y) * r;
  vec2 atlasUV = vec2((base.x + o.x + ci) / 3.0, base.y + o.y);
  return step(d, unpackDepth(texture2D(u_shadowMap, atlasUV)));
}

// Cascaded shadow map with rotated Poisson disk PCF (8 samples)
float calcShadow(vec3 worldPos, float viewZ) {
  // Select cascade by view-space depth
  float ci;
  vec4 ls;
  if (viewZ < u_cascadeSplits.x) {
    ci = 0.0;
    ls = u_lightViewProj[0] * vec4(worldPos, 1.0);
  } else if (viewZ < u_cascadeSplits.y) {
    ci = 1.0;
    ls = u_lightViewProj[1] * vec4(worldPos, 1.0);
  } else {
    ci = 2.0;
    ls = u_lightViewProj[2] * vec4(worldPos, 1.0);
  }
  vec3 pc = ls.xyz / ls.w * 0.5 + 0.5;
  if (pc.x < 0.0 || pc.x > 1.0 || pc.y < 0.0 || pc.y > 1.0 || pc.z > 1.0) return 1.0;

  float d = pc.z - u_shadowBias;
  // Softer shadows for further cascades (covers larger area)
  float r = u_shadowSoftness * u_shadowTexelSize * (1.0 + ci * 0.5);

  // Per-pixel Poisson disk rotation to reduce banding
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  float ca = cos(n * 6.283185), sa = sin(n * 6.283185);

  // 8-sample rotated Poisson disk PCF
  float s = 0.0;
  s += poissonShadow(pc.xy, vec2(-0.942, -0.399), r, ca, sa, d, ci);
  s += poissonShadow(pc.xy, vec2( 0.946, -0.769), r, ca, sa, d, ci);
  s += poissonShadow(pc.xy, vec2(-0.094, -0.929), r, ca, sa, d, ci);
  s += poissonShadow(pc.xy, vec2( 0.345,  0.294), r, ca, sa, d, ci);
  s += poissonShadow(pc.xy, vec2(-0.916,  0.458), r, ca, sa, d, ci);
  s += poissonShadow(pc.xy, vec2(-0.815, -0.879), r, ca, sa, d, ci);
  s += poissonShadow(pc.xy, vec2(-0.383,  0.277), r, ca, sa, d, ci);
  s += poissonShadow(pc.xy, vec2( 0.975,  0.756), r, ca, sa, d, ci);
  return s * 0.125;
}

void main() {
  vec4 base = v_color;
  if (v_useTexture > 0.5) {
    base *= texture2D(u_texture, v_uv);
  }
  // Emissive: skip lighting, output color directly
  if (v_emissive > 0.5) {
    vec3 finalColor = base.rgb;
    if (u_fogFar > 0.0) {
      float dist = length(u_eyePos - v_worldPos);
      float fogFactor = clamp((u_fogFar - dist) / (u_fogFar - u_fogNear), 0.0, 1.0);
      finalColor = mix(u_fogColor, finalColor, fogFactor);
    }
    gl_FragColor = vec4(finalColor, base.a);
    return;
  }
  vec3 n = normalize(v_normal);
  // Normal mapping: perturb n using screen-space tangent frame (dFdx/dFdy)
  if (u_normalMapEnabled > 0.5) {
    vec3 dp1 = dFdx(v_worldPos);
    vec3 dp2 = dFdy(v_worldPos);
    vec2 duv1 = dFdx(v_uv);
    vec2 duv2 = dFdy(v_uv);
    vec3 dp2perp = cross(dp2, n);
    vec3 dp1perp = cross(n, dp1);
    vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
    vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
    float invmax = inversesqrt(max(dot(T, T), dot(B, B)));
    mat3 TBN = mat3(T * invmax, B * invmax, n);
    vec3 mapN = texture2D(u_normalMap, v_uv).xyz * 2.0 - 1.0;
    mapN.xy *= u_normalScale;
    n = normalize(TBN * mapN);
  }
  vec3 viewDir = normalize(u_eyePos - v_worldPos);
  // Directional light
  vec3 ld = normalize(-u_lightDir);
  float diff = max(dot(n, ld), 0.0);
  float spec = 0.0;
  if (diff > 0.0 && u_shininess > 0.0) {
    vec3 halfDir = normalize(ld + viewDir);
    spec = pow(max(dot(n, halfDir), 0.0), u_shininess);
  }
  // Shadow attenuation for directional light (cascaded)
  float shadow = 1.0;
  if (u_shadowEnabled > 0.5) {
    shadow = calcShadow(v_worldPos, v_viewZ);
  }
  // SSAO: attenuate ambient occlusion from screen-space texture
  float ao = 1.0;
  if (u_ssaoEnabled > 0.5) {
    ao = texture2D(u_ssaoMap, gl_FragCoord.xy * u_ssaoTexelSize).r;
  }
  vec3 lit = u_ambientColor * u_ambient * ao + u_lightColor * diff * shadow;
  spec *= shadow;
  // Point/spot lights
  for (int i = 0; i < 8; i++) {
    if (i >= u_numPL) break;
    vec3 toLight = u_plPos[i] - v_worldPos;
    float dist = length(toLight);
    if (dist > u_plRadius[i]) continue;
    vec3 plD = toLight / dist;
    float atten = 1.0 - dist / u_plRadius[i];
    atten = atten * atten;
    float plDiff = max(dot(n, plD), 0.0);
    // Spot cone
    if (u_plCone[i] > 0.0) {
      float cosA = dot(-plD, normalize(u_plDir[i]));
      float cosC = cos(u_plCone[i]);
      if (cosA < cosC) continue;
      atten *= smoothstep(cosC, cosC + 0.15, cosA);
    }
    lit += u_plColor[i] * plDiff * atten;
    if (plDiff > 0.0 && u_shininess > 0.0) {
      vec3 plH = normalize(plD + viewDir);
      spec += pow(max(dot(n, plH), 0.0), u_shininess) * atten * 0.3;
    }
  }
  vec3 finalColor = base.rgb * lit + u_lightColor * spec * 0.3;
  // Fog
  if (u_fogFar > 0.0) {
    float dist = length(u_eyePos - v_worldPos);
    float fogFactor = clamp((u_fogFar - dist) / (u_fogFar - u_fogNear), 0.0, 1.0);
    finalColor = mix(u_fogColor, finalColor, fogFactor);
  }
  gl_FragColor = vec4(finalColor, base.a);
}`;

// ─── Instanced 3D vertex shader (model matrix as per-instance attribute) ────
export const VERT_3D_INST_SRC = `
attribute vec3 a_position;
attribute vec3 a_normal;
attribute vec4 a_model0;
attribute vec4 a_model1;
attribute vec4 a_model2;
attribute vec4 a_model3;
attribute vec4 a_color;
attribute vec4 a_uvRect;
attribute vec4 a_extra;
uniform mat4 u_projection;
uniform mat4 u_view;
varying vec2 v_uv;
varying vec4 v_color;
varying float v_useTexture;
varying vec3 v_normal;
varying vec3 v_worldPos;
varying float v_emissive;
varying float v_viewZ;
void main() {
  mat4 model = mat4(a_model0, a_model1, a_model2, a_model3);
  vec4 worldPos = model * vec4(a_position, 1.0);
  v_worldPos = worldPos.xyz;
  mat3 m3 = mat3(a_model0.xyz, a_model1.xyz, a_model2.xyz);
  v_normal = m3 * (a_normal * a_extra.xyz);
  v_uv = a_uvRect.xy + a_position.xy * a_uvRect.zw;
  v_color = a_color;
  float ew = a_extra.w;
  v_emissive = step(1.5, ew);
  v_useTexture = ew - v_emissive * 2.0;
  v_viewZ = -(u_view * worldPos).z;
  gl_Position = u_projection * u_view * worldPos;
}`;

// ─── Shadow depth pass shaders ───────────────────────────────────────────────

/** Vertex shader for shadow depth pass (non-instanced). Outputs light-space position. */
export const SHADOW_VERT_SRC = `
attribute vec3 a_position;
uniform mat4 u_lightViewProj;
uniform mat4 u_model;
void main() {
  gl_Position = u_lightViewProj * u_model * vec4(a_position, 1.0);
}`;

/** Fragment shader for shadow depth pass. Writes depth to color for WebGL1 compat. */
export const SHADOW_FRAG_SRC = `
precision mediump float;
void main() {
  float d = gl_FragCoord.z;
  // Pack depth into RGBA for WebGL1 (no depth texture extension needed)
  vec4 enc = vec4(1.0, 255.0, 65025.0, 16581375.0) * d;
  enc = fract(enc);
  enc -= enc.yzww * vec4(1.0/255.0, 1.0/255.0, 1.0/255.0, 0.0);
  gl_FragColor = enc;
}`;

/** Vertex shader for shadow depth pass (instanced). */
export const SHADOW_INST_VERT_SRC = `
attribute vec3 a_position;
attribute vec4 a_model0;
attribute vec4 a_model1;
attribute vec4 a_model2;
attribute vec4 a_model3;
uniform mat4 u_lightViewProj;
void main() {
  mat4 model = mat4(a_model0, a_model1, a_model2, a_model3);
  gl_Position = u_lightViewProj * model * vec4(a_position, 1.0);
}`;

export const INST_STRIDE = 28; // floats per instance: model(16) + color(4) + uvRect(4) + extra(4)
export const INST_STRIDE_BYTES = INST_STRIDE * 4;
export const GEO_STRIDE_BYTES = 24; // 6 floats per vertex (pos3+normal3) in geometry VBOs

// ─── GPU Particle shaders (stateless: position computed from initial conditions + time) ──

/** Per-instance data: 16 floats
 *  a_posLife:    (x, y, z, spawnTime)
 *  a_velSize:    (vx, vy, vz, sizeStart)
 *  a_colorStart: (r, g, b, a)
 *  a_colorEnd:   (r, g, b, sizeEnd)  — sizeEnd packed in .w
 */
export const GPU_PARTICLE_VERT_SRC = `
attribute vec2 a_corner;
attribute vec4 a_posLife;
attribute vec4 a_velSize;
attribute vec4 a_colorStart;
attribute vec4 a_colorEnd;
uniform mat4 u_projection;
uniform mat4 u_view;
uniform vec3 u_eyePos;
uniform float u_time;
uniform vec3 u_gravity;
uniform float u_lifetime;
varying vec4 v_color;
varying vec2 v_uv;
void main() {
  float spawnTime = a_posLife.w;
  float t = u_time - spawnTime;
  float lifeT = t / u_lifetime;
  if (lifeT > 1.0 || lifeT < 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec3 pos = a_posLife.xyz + a_velSize.xyz * t + 0.5 * u_gravity * t * t;
  float sizeEnd = a_colorEnd.w;
  float sz = mix(a_velSize.w, sizeEnd, lifeT);
  // Billboard facing camera
  vec3 toCamera = normalize(u_eyePos - pos);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCamera));
  vec3 up = cross(toCamera, right);
  vec3 worldPos = pos + (right * a_corner.x + up * a_corner.y) * sz;
  gl_Position = u_projection * u_view * vec4(worldPos, 1.0);
  v_color = vec4(mix(a_colorStart.rgb, a_colorEnd.rgb, lifeT),
                 mix(a_colorStart.a, 0.0, lifeT));
  v_uv = a_corner + 0.5;
}`;

export const GPU_PARTICLE_FRAG_SRC = `
precision mediump float;
uniform sampler2D u_texture;
uniform float u_useTexture;
varying vec4 v_color;
varying vec2 v_uv;
void main() {
  if (v_color.a <= 0.0) discard;
  vec4 c = v_color;
  if (u_useTexture > 0.5) {
    c *= texture2D(u_texture, v_uv);
  }
  gl_FragColor = c;
}`;

export const GPU_PARTICLE_INST_STRIDE = 16; // floats per instance
export const GPU_PARTICLE_INST_BYTES = GPU_PARTICLE_INST_STRIDE * 4;

// ─── SSAO Shaders (engine-standard: depth-only pass, reconstruct normals from depth) ────

/** Minimal vertex shader for SSAO depth pass (non-instanced). */
export const SSAO_DEPTH_VERT_SRC = `
attribute vec3 a_position;
attribute vec3 a_normal;
uniform mat4 u_projection;
uniform mat4 u_view;
uniform mat4 u_model;
varying vec3 v_worldPos;
void main() {
  vec4 wp = u_model * vec4(a_position, 1.0);
  v_worldPos = wp.xyz;
  gl_Position = u_projection * u_view * wp;
}`;

/** Minimal vertex shader for SSAO depth pass (instanced). */
export const SSAO_DEPTH_INST_VERT_SRC = `
attribute vec3 a_position;
attribute vec3 a_normal;
attribute vec4 a_model0;
attribute vec4 a_model1;
attribute vec4 a_model2;
attribute vec4 a_model3;
uniform mat4 u_projection;
uniform mat4 u_view;
varying vec3 v_worldPos;
void main() {
  mat4 model = mat4(a_model0, a_model1, a_model2, a_model3);
  vec4 wp = model * vec4(a_position, 1.0);
  v_worldPos = wp.xyz;
  gl_Position = u_projection * u_view * wp;
}`;

/** Depth-only pass: pack linear depth into RGBA for WebGL1 precision. */
export const SSAO_DEPTH_FRAG_SRC = `
precision highp float;
varying vec3 v_worldPos;
uniform mat4 u_view;
uniform float u_far;
void main() {
  float z = -(u_view * vec4(v_worldPos, 1.0)).z / u_far;
  // Pack into RGBA for full precision on WebGL1
  vec4 enc = vec4(1.0, 255.0, 65025.0, 16581375.0) * clamp(z, 0.0, 1.0);
  enc = fract(enc);
  enc -= enc.yzww * vec4(1.0/255.0, 1.0/255.0, 1.0/255.0, 0.0);
  gl_FragColor = enc;
}`;

/** SSAO sampling: depth-only input, normals reconstructed from depth cross-product.
 *  Runs at half resolution for performance (standard in Unity/Unreal). */
export const SSAO_FRAG_SRC = `
precision highp float;
uniform sampler2D u_depth;
uniform vec2 u_texelSize;
uniform float u_radius;
uniform float u_bias;
uniform float u_intensity;
uniform mat4 u_projection;
uniform float u_far;
varying vec2 v_uv;

float unpackDepth(vec4 c) {
  return dot(c, vec4(1.0, 1.0/255.0, 1.0/65025.0, 1.0/16581375.0));
}

// Reconstruct view-space position from UV + linear depth
vec3 viewPosFromDepth(vec2 uv, float d) {
  return vec3(
    (uv.x * 2.0 - 1.0) / u_projection[0][0],
    (uv.y * 2.0 - 1.0) / u_projection[1][1],
    -1.0
  ) * d * u_far;
}

// Reconstruct view-space normal from depth cross-products (no normal texture needed)
vec3 reconstructNormal(vec3 p) {
  vec3 px = viewPosFromDepth(v_uv + vec2(u_texelSize.x, 0.0),
            unpackDepth(texture2D(u_depth, v_uv + vec2(u_texelSize.x, 0.0))));
  vec3 py = viewPosFromDepth(v_uv + vec2(0.0, u_texelSize.y),
            unpackDepth(texture2D(u_depth, v_uv + vec2(0.0, u_texelSize.y))));
  return normalize(cross(px - p, py - p));
}

// Hash-based noise (avoids noise texture)
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  float d = unpackDepth(texture2D(u_depth, v_uv));
  if (d <= 0.0 || d >= 0.999) { gl_FragColor = vec4(1.0); return; }

  vec3 viewPos = viewPosFromDepth(v_uv, d);
  vec3 normal = reconstructNormal(viewPos);

  // Random rotation per-pixel (4x4 tiled noise, standard engine approach)
  float noise = hash(gl_FragCoord.xy);
  float angle = noise * 6.2831853;
  float ca = cos(angle), sa = sin(angle);

  // Build TBN from normal + random rotation
  vec3 tangent = normalize(vec3(ca, sa, 0.0) - normal * dot(vec3(ca, sa, 0.0), normal));
  vec3 bitangent = cross(normal, tangent);
  mat3 TBN = mat3(tangent, bitangent, normal);

  // 16-sample hemisphere kernel (Halton quasi-random, cosine-weighted)
  float occlusion = 0.0;
  for (int i = 0; i < 16; i++) {
    float fi = float(i);
    // Halton(2,3) quasi-random sequence
    float r1 = fract(fi * 0.5 + 0.5);
    float r2 = fract(fi * 0.333333 + 0.333333);
    float r3 = fract(fi * 0.2 + 0.1);
    vec3 k = normalize(vec3(r1 * 2.0 - 1.0, r2 * 2.0 - 1.0, r3));
    // Accelerating scale: more samples near origin (standard)
    float scale = mix(0.1, 1.0, (fi / 16.0) * (fi / 16.0));
    k *= scale;

    vec3 samplePos = viewPos + TBN * k * u_radius;

    // Project to screen space
    vec4 proj = u_projection * vec4(samplePos, 1.0);
    vec2 suv = proj.xy / proj.w * 0.5 + 0.5;

    float sampleZ = unpackDepth(texture2D(u_depth, suv)) * u_far;
    // Range check: fade out samples that are too far from the surface
    float rangeCheck = smoothstep(0.0, 1.0, u_radius / abs(-viewPos.z - sampleZ));
    occlusion += (sampleZ <= -samplePos.z - u_bias ? 1.0 : 0.0) * rangeCheck;
  }

  gl_FragColor = vec4(vec3(1.0 - (occlusion / 16.0) * u_intensity), 1.0);
}`;

/** Bilateral blur: edge-preserving (depth-aware) blur for SSAO. Standard in all engines. */
export const SSAO_BLUR_FRAG_SRC = `
precision highp float;
uniform sampler2D u_texture;
uniform sampler2D u_depth;
uniform vec2 u_texelSize;
varying vec2 v_uv;

float unpackDepth(vec4 c) {
  return dot(c, vec4(1.0, 1.0/255.0, 1.0/65025.0, 1.0/16581375.0));
}

void main() {
  float centerDepth = unpackDepth(texture2D(u_depth, v_uv));
  float result = 0.0;
  float totalWeight = 0.0;
  for (int x = -2; x <= 2; x++) {
    for (int y = -2; y <= 2; y++) {
      vec2 offset = vec2(float(x), float(y)) * u_texelSize;
      vec2 suv = v_uv + offset;
      float ao = texture2D(u_texture, suv).r;
      float sDepth = unpackDepth(texture2D(u_depth, suv));
      // Edge-preserving weight: reject samples across depth discontinuities
      float w = 1.0 - smoothstep(0.0, 0.02, abs(sDepth - centerDepth));
      result += ao * w;
      totalWeight += w;
    }
  }
  gl_FragColor = vec4(vec3(result / max(totalWeight, 0.001)), 1.0);
}`;

/** SSAO composite: multiply AO into the scene. */
export const SSAO_COMPOSITE_FRAG_SRC = `
precision mediump float;
uniform sampler2D u_scene;
uniform sampler2D u_ssao;
varying vec2 v_uv;
void main() {
  vec3 scene = texture2D(u_scene, v_uv).rgb;
  float ao = texture2D(u_ssao, v_uv).r;
  gl_FragColor = vec4(scene * ao, 1.0);
}`;
