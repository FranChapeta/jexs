/**
 * GL engine type definitions.
 * Extracted from GlNode.ts for modularity.
 */

import { EntityStore } from "@jexs/physics";
import { Context } from "@jexs/core";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GlCamera {
  x: number;
  y: number;
  zoom: number;
  rotation: number;
  follow: string | null;
  shake: number;
  shakeDuration: number;
  shakeDecay: number;
  shakeElapsed: number;
  shakeX: number;
  shakeY: number;
  shakeAngle: number;
  // Trauma-based shake (Vlambeer-style): offset = maxShake * trauma^2
  trauma: number;
  traumaDecay: number;    // trauma units lost per second (default 1)
  maxShake: number;       // max offset in pixels (default 10)
  maxShakeAngle: number;  // max rotational shake in degrees (default 3)
  // 3D camera fields
  z: number;
  fov: number;        // degrees
  near: number;
  far: number;
  lookAt: [number, number, number];
  up: [number, number, number];
  // FPS/TPS orbit camera (used with follow)
  pitch: number;
  yaw: number;
  followMode: "fps" | "tps" | null;
  followOffsetZ: number;  // eye-height offset above entity center
  tpsDistance: number;     // distance behind entity in TPS mode
  tpsHeight: number;      // height offset above entity in TPS mode
}

export interface GlInstance {
  canvas: HTMLCanvasElement;
  gl: WebGLRenderingContext;
  isWebGL2: boolean;
  // Default program (color + optional texture)
  program: WebGLProgram;
  positionBuf: WebGLBuffer;
  store: EntityStore;
  clearColor: [number, number, number, number];
  rafId: number | null;
  dirty: boolean;
  // Default program uniforms/attribs
  uTransform: WebGLUniformLocation;
  uProjection: WebGLUniformLocation;
  uColor: WebGLUniformLocation;
  uUvRect: WebGLUniformLocation;
  uUseTexture: WebGLUniformLocation;
  uTexture: WebGLUniformLocation;
  aPosition: number;
  resizeObserver: ResizeObserver | null;
  onFrame: unknown[] | null;
  frameContext: Context | null;
  frameLoopContext: Context | null;  // pre-allocated context for onFrame (avoids spread per frame)
  lastTime: number;
  fit: string;
  vpScale: number;
  vpOffsetX: number;
  vpOffsetY: number;
  camera: GlCamera;
  textures: Map<string, { tex: WebGLTexture; w: number; h: number }>;
  textCache: Map<string, { tex: WebGLTexture; w: number; h: number }>;
  atlases: Map<string, { texture: string; frames: [number, number, number, number][] }>;
  tilemaps: Map<string, { vbo: WebGLBuffer; vertCount: number; textureName: string; z: number; dirty: boolean; data: number[][]; atlas: string; tileW: number; tileH: number }>;
  shaders: Map<string, { program: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null> }>;
  // Performance metrics
  metrics: boolean;
  metricsEl: HTMLDivElement | null;
  metricsFrames: number;
  metricsTime: number;
  metricsFps: number;
  metricsDrawCalls: number;
  // Batched rendering
  batchProg: WebGLProgram;
  batchBuf: WebGLBuffer;
  batchData: Float32Array;
  batchCap: number;
  batchLocs: {
    aPosition: number;
    aColor: number;
    aUv: number;
    aUseTex: number;
    uProjection: WebGLUniformLocation;
    uTexture: WebGLUniformLocation;
  };
  // Post-processing (lazily allocated)
  fboA: WebGLFramebuffer | null;
  fboTexA: WebGLTexture | null;
  fboB: WebGLFramebuffer | null;
  fboTexB: WebGLTexture | null;
  fboWidth: number;
  fboHeight: number;
  postProg: WebGLProgram | null;
  postLocs: { uTexture: WebGLUniformLocation; uOpacity: WebGLUniformLocation; aPosition: number } | null;
  blurProg: WebGLProgram | null;
  blurLocs: { uTexture: WebGLUniformLocation; uDirection: WebGLUniformLocation; uRadius: WebGLUniformLocation; aPosition: number } | null;
  postQuadBuf: WebGLBuffer | null;
  blur: { radius: number } | null;
  transition: { type: "fade"; duration: number; elapsed: number } | null;
  tweens: GlTween[];
  // 3D mode
  mode3d: boolean;
  prog3d: WebGLProgram | null;
  prog3dLocs: {
    aPosition: number;
    aNormal: number;
    aColor: number;
    aUv: number;
    aUseTex: number;
    uEmissive: WebGLUniformLocation;
    uProjection: WebGLUniformLocation;
    uView: WebGLUniformLocation;
    uModel: WebGLUniformLocation;
    uTexture: WebGLUniformLocation;
    uLightDir: WebGLUniformLocation;
    uAmbient: WebGLUniformLocation;
    uEyePos: WebGLUniformLocation;
    uShininess: WebGLUniformLocation;
    uLightColor: WebGLUniformLocation;
    uAmbientColor: WebGLUniformLocation;
    uNumPL: WebGLUniformLocation;
    uPlPos: WebGLUniformLocation;
    uPlColor: WebGLUniformLocation;
    uPlRadius: WebGLUniformLocation;
    uPlCone: WebGLUniformLocation;
    uPlDir: WebGLUniformLocation;
    uFogColor: WebGLUniformLocation;
    uFogNear: WebGLUniformLocation;
    uFogFar: WebGLUniformLocation;
    // Shadow uniforms (cascaded)
    uShadowMap: WebGLUniformLocation;
    uLightViewProj: WebGLUniformLocation;
    uCascadeSplits: WebGLUniformLocation;
    uShadowEnabled: WebGLUniformLocation;
    uShadowBias: WebGLUniformLocation;
    uShadowTexelSize: WebGLUniformLocation;
    uShadowSoftness: WebGLUniformLocation;
    // Normal mapping uniforms
    uNormalMap: WebGLUniformLocation;
    uNormalMapEnabled: WebGLUniformLocation;
    uNormalScale: WebGLUniformLocation;
    // SSAO uniforms
    uSsaoMap: WebGLUniformLocation;
    uSsaoEnabled: WebGLUniformLocation;
    uSsaoTexelSize: WebGLUniformLocation;
  } | null;
  prog3dBuf: WebGLBuffer | null;
  batch3dData: Float32Array;
  batch3dCap: number;
  batchShrinkFrames: number;     // frames below 25% usage (shrink after 120)
  batch3dShrinkFrames: number;
  // Instanced 3D rendering (ANGLE_instanced_arrays)
  extInstanced: ANGLE_instanced_arrays | null;
  progInst: WebGLProgram | null;
  progInstLocs: {
    aPosition: number;
    aNormal: number;
    aModel0: number;
    aModel1: number;
    aModel2: number;
    aModel3: number;
    aColor: number;
    aUvRect: number;
    aExtra: number;
    uProjection: WebGLUniformLocation;
    uView: WebGLUniformLocation;
    uTexture: WebGLUniformLocation;
    uLightDir: WebGLUniformLocation;
    uAmbient: WebGLUniformLocation;
    uEyePos: WebGLUniformLocation;
    uShininess: WebGLUniformLocation;
    uLightColor: WebGLUniformLocation;
    uAmbientColor: WebGLUniformLocation;
    uNumPL: WebGLUniformLocation;
    uPlPos: WebGLUniformLocation;
    uPlColor: WebGLUniformLocation;
    uPlRadius: WebGLUniformLocation;
    uPlCone: WebGLUniformLocation;
    uPlDir: WebGLUniformLocation;
    uFogColor: WebGLUniformLocation;
    uFogNear: WebGLUniformLocation;
    uFogFar: WebGLUniformLocation;
    // Shadow uniforms (cascaded)
    uShadowMap: WebGLUniformLocation;
    uLightViewProj: WebGLUniformLocation;
    uCascadeSplits: WebGLUniformLocation;
    uShadowEnabled: WebGLUniformLocation;
    uShadowBias: WebGLUniformLocation;
    uShadowTexelSize: WebGLUniformLocation;
    uShadowSoftness: WebGLUniformLocation;
    // Normal mapping uniforms
    uNormalMap: WebGLUniformLocation;
    uNormalMapEnabled: WebGLUniformLocation;
    uNormalScale: WebGLUniformLocation;
    // SSAO uniforms
    uSsaoMap: WebGLUniformLocation;
    uSsaoEnabled: WebGLUniformLocation;
    uSsaoTexelSize: WebGLUniformLocation;
  } | null;
  geoVBOs: Map<Float32Array, { buf: WebGLBuffer; vertCount: number }>;
  instanceBuf: WebGLBuffer | null;
  instanceData: Float32Array;
  instanceCap: number;
  lightDir: [number, number, number];
  lightColor: [number, number, number];
  ambientColor: [number, number, number];
  ambient: number;
  shininess: number;
  // Point/spot lights (max 8)
  pointLights: Float32Array;   // packed: [x,y,z, r,g,b, radius, coneAngle, dirX,dirY,dirZ, pad] * 8
  pointLightCount: number;
  lightSlots: number[];         // cached slots of entities with type "light"
  lightsDirty: boolean;         // rebuild lightSlots on next frame
  // Skybox gradient
  skyboxProg: WebGLProgram | null;
  skyboxLocs: { aPosition: number; uSkyTop: WebGLUniformLocation; uSkyBottom: WebGLUniformLocation; uSunPos: WebGLUniformLocation; uAspect: WebGLUniformLocation } | null;
  skyboxBuf: WebGLBuffer | null;
  skyTop: [number, number, number] | null;
  skyBottom: [number, number, number] | null;
  // Fog
  fogColor: [number, number, number];
  fogNear: number;
  fogFar: number;
  // Orthographic camera
  ortho: boolean;
  // FXAA
  fxaa: boolean;
  fxaaProg: WebGLProgram | null;
  fxaaLocs: { uTexture: WebGLUniformLocation; uTexelSize: WebGLUniformLocation; aPosition: number } | null;
  // Bloom
  bloom: { threshold: number; intensity: number; radius: number } | null;
  bloomBrightProg: WebGLProgram | null;
  bloomBrightLocs: { uTexture: WebGLUniformLocation; uThreshold: WebGLUniformLocation; aPosition: number } | null;
  bloomCompProg: WebGLProgram | null;
  bloomCompLocs: { uTexture: WebGLUniformLocation; uBloom: WebGLUniformLocation; uIntensity: WebGLUniformLocation; aPosition: number } | null;
  fboC: WebGLFramebuffer | null;
  fboTexC: WebGLTexture | null;
  // Trails
  trails: Map<string, GlTrail>;
  // GPU Particle emitters
  gpuParticles: Map<string, GpuParticleEmitter>;
  gpuParticleProg: WebGLProgram | null;
  gpuParticleLocs: {
    aCorner: number;
    aPosLife: number;
    aVelSize: number;
    aColorStart: number;
    aColorEnd: number;
    uProjection: WebGLUniformLocation;
    uView: WebGLUniformLocation;
    uEyePos: WebGLUniformLocation;
    uTime: WebGLUniformLocation;
    uGravity: WebGLUniformLocation;
    uLifetime: WebGLUniformLocation;
    uTexture: WebGLUniformLocation;
    uUseTexture: WebGLUniformLocation;
  } | null;
  gpuParticleQuadBuf: WebGLBuffer | null;
  // Shadow mapping (cascaded, 3 cascades)
  shadow: { resolution: number; bias: number; softness: number; far: number } | null;
  shadowCascadeSplits: Float32Array;
  shadowFbo: WebGLFramebuffer | null;
  shadowTex: WebGLTexture | null;
  shadowProg: WebGLProgram | null;
  shadowLocs: { aPosition: number; uLightViewProj: WebGLUniformLocation; uModel: WebGLUniformLocation } | null;
  shadowInstProg: WebGLProgram | null;
  shadowInstLocs: {
    aPosition: number; aModel0: number; aModel1: number; aModel2: number; aModel3: number;
    uLightViewProj: WebGLUniformLocation;
  } | null;
  /** Light view-projection matrix (computed per frame, used by both shadow pass and main pass). */
  shadowLightVP: Float32Array;
  // SSAO (half-resolution, depth-only, bilateral blur — engine-standard)
  ssao: { radius: number; bias: number; intensity: number } | null;
  ssaoDepthFbo: WebGLFramebuffer | null;  // full-res depth pass
  ssaoDepthTex: WebGLTexture | null;
  ssaoFbo: WebGLFramebuffer | null;       // half-res SSAO result
  ssaoTex: WebGLTexture | null;
  ssaoBlurFbo: WebGLFramebuffer | null;   // half-res blur result
  ssaoBlurTex: WebGLTexture | null;
  ssaoWidth: number;                      // half-res dimensions
  ssaoHeight: number;
  ssaoDepthProg: WebGLProgram | null;
  ssaoDepthLocs: {
    aPosition: number; aNormal: number;
    uProjection: WebGLUniformLocation; uView: WebGLUniformLocation; uModel: WebGLUniformLocation;
    uFar: WebGLUniformLocation;
  } | null;
  ssaoProg: WebGLProgram | null;
  ssaoLocs: {
    aPosition: number;
    uDepth: WebGLUniformLocation; uTexelSize: WebGLUniformLocation;
    uRadius: WebGLUniformLocation; uBias: WebGLUniformLocation; uIntensity: WebGLUniformLocation;
    uProjection: WebGLUniformLocation; uFar: WebGLUniformLocation;
  } | null;
  ssaoBlurProg: WebGLProgram | null;
  ssaoBlurLocs: { aPosition: number; uTexture: WebGLUniformLocation; uDepth: WebGLUniformLocation; uTexelSize: WebGLUniformLocation } | null;
  ssaoCompProg: WebGLProgram | null;
  ssaoCompLocs: { aPosition: number; uScene: WebGLUniformLocation; uSsao: WebGLUniformLocation } | null;
}

export interface GlTrail {
  entityId: string;
  length: number;        // max points in ring buffer
  width: number;
  color: [number, number, number, number];
  points: Float32Array;  // ring buffer: [x, y] * length
  head: number;          // next write index
  count: number;         // current number of valid points
}

export interface GlTween {
  slot: number;
  fields: number[];        // F_X, F_Y, etc.
  starts: number[];        // start values
  ends: number[];          // target values
  duration: number;
  elapsed: number;
  easing: (t: number) => number;
  then: unknown[] | null;  // steps to run on complete
  context: Context | null;
}

export interface GpuParticleEmitter {
  id: string;
  maxParticles: number;
  lifetime: number;
  gravity: [number, number, number];
  /** Ring buffer write head (next slot to emit into). */
  head: number;
  /** Instance data: 16 floats per particle (posLife, velSize, colorStart, colorEnd). */
  data: Float32Array;
  vbo: WebGLBuffer;
  /** Emitter origin (updated each emit call). */
  x: number; y: number; z: number;
  speed: number;
  spread: number;
  dirX: number; dirY: number; dirZ: number;
  size: number; sizeEnd: number;
  color: [number, number, number, number];
  colorEnd: [number, number, number, number];
  /** Whether to continuously emit. */
  continuous: boolean;
  rate: number;         // particles per second
  accumulator: number;  // fractional particle accumulator
  texture: string | null;
  blend: "additive" | "normal";
}
