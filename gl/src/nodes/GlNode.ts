import { Node, Context, NodeValue } from "@jexs/core";
import { resolve, resolveAll, resolveObj, runSteps } from "@jexs/core";
import {
  EntityStore,
  STRIDE,
  F_X, F_Y, F_W, F_H, F_ANGLE,
  F_CR, F_CG, F_CB, F_CA,
  F_FLAGS, F_Z,
  F_U, F_V, F_UW, F_UH, F_OPACITY,
  F_D, F_RX, F_RY,
  FLAG_VISIBLE, FLAG_FIXED,
  DIRTY_TEXT, DIRTY_VISUAL,
} from "@jexs/physics";

// ─── Extracted GL modules ────────────────────────────────────────────────────
import type { GlInstance, GpuParticleEmitter } from "../gl/types.js";
export type { GlCamera, GlInstance } from "../gl/types.js";
import { EASINGS, TWEENABLE_KEYS } from "../gl/easing.js";
import { tickTweens, cancelConflictingTweens } from "../gl/tweening.js";
import { updateCameraFollow, updateCameraShake } from "../gl/camera.js";
import { collectPointLights, uploadPointLights, setSceneUniforms } from "../gl/lighting.js";
import { parseBloom, ensureFBOs, applyPostProcessing } from "../gl/postProcess.js";
import { emitGpuParticles, initGpuParticleProgram, renderGpuParticles, hasActiveParticles } from "../gl/particleSystem.js";
import { updateTrails, renderTrails } from "../gl/trails.js";
import { initShadow, renderShadowPass } from "../gl/shadows.js";
import { initSsao, renderSsaoPass } from "../gl/ssao.js";
import { renderTextTexture } from "../gl/textRendering.js";
import { init3dProgram } from "../gl/setup3d.js";
import {
  upgradeVert, upgradeFrag,
  VERT_SRC, FRAG_SRC,
  BATCH_VERT_SRC, BATCH_FRAG_SRC,
  BATCH_STRIDE_FLOATS, BATCH_STRIDE_BYTES,
  STRIDE_3D, STRIDE_3D_BYTES,
  INST_STRIDE, INST_STRIDE_BYTES, GEO_STRIDE_BYTES,
  GPU_PARTICLE_INST_STRIDE,
} from "../gl/shaders.js";
import {
  QUAD_VERTS, TRI_VERTS, CIRCLE_VERTS, CIRCLE_TRI_VERTS,
  FLAT_QUAD_VERTS,
  CUBE_VERTS,
  getRoundedCubeVerts,
  SHAPE_3D, SHAPE_FLAT,
} from "../gl/geometry.js";
import {
  mat4Perspective, mat4Ortho, mat4LookAt,
  normalMat3, mat4Model, mat4Billboard,
  mat4Multiply, unprojectRay, rayAABB,
  MAT4_IDENTITY, bindTex,
  _projM, _viewM,
  _frustum,
} from "../gl/math.js";
import { raycastStore } from "@jexs/physics";

// ─── Module-level scratch buffers ────────────────────────────────────────────

const _color4 = new Float32Array(4);
const _uv4 = new Float32Array(4);
const _xform9 = new Float32Array(9);
const _projCam9 = new Float32Array(9);
const _projBase9 = new Float32Array(9);
// Scratch buffer for non-batchable 3D entity vertex data (grows as needed)
let _singleBuf = new Float32Array(120 * STRIDE_3D); // 120 verts covers circles

// Render performance tracing
let _glPerfAccum = { render: 0, onFrame: 0, frames: 0 };
let _glPerfLastLog = 0;

/** Enable verbose GL render logging. */
export let _glDebug = false;


/** Pre-transform 3D vertices (pos3+normal3 interleaved) into a batch buffer. Returns new offset. */
function writePreTransformed(
  srcVerts: Float32Array, model: Float32Array,
  cr: number, cg: number, cb: number, ca: number,
  u: number, v: number, uW: number, uH: number, useTex: number,
  out: Float32Array, offset: number,
): number {
  const totalVerts = srcVerts.length / 6;
  const nm = normalMat3(model);
  for (let i = 0; i < totalVerts; i++) {
    const si = i * 6;
    const px = srcVerts[si], py = srcVerts[si + 1], pz = srcVerts[si + 2];
    const nx = srcVerts[si + 3], ny = srcVerts[si + 4], nz = srcVerts[si + 5];
    out[offset++] = model[0] * px + model[4] * py + model[8] * pz + model[12];
    out[offset++] = model[1] * px + model[5] * py + model[9] * pz + model[13];
    out[offset++] = model[2] * px + model[6] * py + model[10] * pz + model[14];
    out[offset++] = nm[0] * nx + nm[3] * ny + nm[6] * nz;
    out[offset++] = nm[1] * nx + nm[4] * ny + nm[7] * nz;
    out[offset++] = nm[2] * nx + nm[5] * ny + nm[8] * nz;
    out[offset++] = cr; out[offset++] = cg; out[offset++] = cb; out[offset++] = ca;
    out[offset++] = u + px * uW; out[offset++] = v + py * uH;
    out[offset++] = useTex;
  }
  return offset;
}

// ─── GlNode ─────────────────────────────────────────────────────────────────

export class GlNode extends Node {
  static instances = new Map<string, GlInstance>();

  // ── gl-init ─────────────────────────────────────────────────────────────

  /**
   * Initializes a WebGL canvas (WebGL2 with WebGL1 fallback). Pass the canvas CSS selector as `gl-init`.
   * Use `width`/`height` to set logical size, `clear` for background color, `depth: true` for 3D depth test.
   * Pass `on-frame` steps to run every animation frame — receives `$dt` (delta seconds) and `$time` in context.
   * @param {string} gl-init CSS selector for the canvas element.
   * @param {number} width Logical canvas width in pixels.
   * @param {number} height Logical canvas height in pixels.
   * @param {number[]} clear Background clear color as `[r, g, b, a]` (default `[0,0,0,1]`).
   * @param {boolean} depth Enable depth testing for 3D rendering.
   * @param {expr[]} on-frame Steps to run each animation frame (`$dt`, `$time` available).
   * @example
   * { "gl-init": "#canvas", "width": 800, "height": 600, "clear": [0, 0, 0, 1], "on-frame": [] }
   */
  ["gl-init"](def: Record<string, unknown>, context: Context): NodeValue {
    // "on-frame" is a lazy step template — exclude from resolution
    const onFrame = Array.isArray(def["on-frame"]) ? def["on-frame"] as unknown[] : null;
    const resolvable: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(def)) { if (k !== "on-frame") resolvable[k] = v; }

    return resolveObj(resolvable, context, r => {
      const selector = String(r["gl-init"]);

      const prev = GlNode.instances.get(selector);
      if (prev) GlNode.destroyInstance(prev, selector);

      const canvas = GlNode.resolveCanvas(selector);
      if (!canvas) { console.error("[GL] No element found for selector:", selector); return null; }

      const dpr = window.devicePixelRatio || 1;
      canvas.width = r["width"] !== undefined ? Number(r["width"]) * dpr : (canvas.clientWidth || 300) * dpr;
      canvas.height = r["height"] !== undefined ? Number(r["height"]) * dpr : (canvas.clientHeight || 150) * dpr;

      // Try WebGL2 first, fall back to WebGL1
      const gl2 = canvas.getContext("webgl2", { antialias: true }) as WebGL2RenderingContext | null;
      const gl = (gl2 || canvas.getContext("webgl", { antialias: true })) as WebGLRenderingContext | null;
      const isWebGL2 = !!gl2;
      if (!gl) { console.error("[GL] WebGL not supported"); return null; }
      if (isWebGL2) console.log("[GL] Using WebGL2");

      const clearColor = (r["clear"] ?? [0, 0, 0, 1]) as [number, number, number, number];
      const enableDepth = !!def["depth"];

      const setupGL = (): {
        program: WebGLProgram; positionBuf: WebGLBuffer;
        uTransform: WebGLUniformLocation; uProjection: WebGLUniformLocation;
        uColor: WebGLUniformLocation; uUvRect: WebGLUniformLocation;
        uUseTexture: WebGLUniformLocation; uTexture: WebGLUniformLocation;
        aPosition: number;
        batchProg: WebGLProgram; batchBuf: WebGLBuffer;
        batchLocs: GlInstance["batchLocs"];
      } | null => {
        const program = GlNode.createProgram(gl, VERT_SRC, FRAG_SRC, isWebGL2);
        if (!program) return null;
        const batchProg = GlNode.createProgram(gl, BATCH_VERT_SRC, BATCH_FRAG_SRC, isWebGL2);
        if (!batchProg) return null;
        if (enableDepth) gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        return {
          program,
          positionBuf: gl.createBuffer()!,
          uTransform: gl.getUniformLocation(program, "u_transform")!,
          uProjection: gl.getUniformLocation(program, "u_projection")!,
          uColor: gl.getUniformLocation(program, "u_color")!,
          uUvRect: gl.getUniformLocation(program, "u_uvRect")!,
          uUseTexture: gl.getUniformLocation(program, "u_useTexture")!,
          uTexture: gl.getUniformLocation(program, "u_texture")!,
          aPosition: gl.getAttribLocation(program, "a_position"),
          batchProg,
          batchBuf: gl.createBuffer()!,
          batchLocs: {
            aPosition: gl.getAttribLocation(batchProg, "a_position"),
            aColor: gl.getAttribLocation(batchProg, "a_color"),
            aUv: gl.getAttribLocation(batchProg, "a_uv"),
            aUseTex: gl.getAttribLocation(batchProg, "a_useTexture"),
            uProjection: gl.getUniformLocation(batchProg, "u_projection")!,
            uTexture: gl.getUniformLocation(batchProg, "u_texture")!,
          },
        };
      };

      const initial = setupGL();
      if (!initial) return null;

      const store = new EntityStore();
      const vw = r["virtualWidth"] ? Number(r["virtualWidth"]) : 0;
      const vh = r["virtualHeight"] ? Number(r["virtualHeight"]) : 0;
      store.width = vw || canvas.width;
      store.height = vh || canvas.height;
      store.virtualWidth = vw;
      store.virtualHeight = vh;

      const fit = r["fit"] ? String(r["fit"]) : "contain";

      const inst: GlInstance = {
        canvas,
        gl,
        isWebGL2,
        ...initial,
        store,
        clearColor,
        rafId: null,
        dirty: true,
        resizeObserver: null,
        onFrame,
        frameContext: context,
        frameLoopContext: null,
        onFrameRunning: false,
        onFramePending: false,
        onFrameLatestTime: 0,
        onFrameLatestDelta: 0,
        lastTime: 0,
        fit,
        vpScale: 1,
        vpOffsetX: 0,
        vpOffsetY: 0,
        camera: { x: 0, y: 0, zoom: 1, rotation: 0, follow: null, shake: 0, shakeDuration: 0.3, shakeDecay: 1, shakeElapsed: 0, shakeX: 0, shakeY: 0, shakeAngle: 0, trauma: 0, traumaDecay: 1, maxShake: 10, maxShakeAngle: 3, z: 0, fov: 60, near: 0.1, far: 1000, lookAt: [0, 0, 0], up: [0, 1, 0], pitch: 0, yaw: 0, followMode: null, followOffsetZ: 0, tpsDistance: 8, tpsHeight: 6 },
        textures: new Map(),
        textCache: new Map(),
        atlases: new Map(),
        tilemaps: new Map(),
        shaders: new Map(),
        metrics: !!def["metrics"],
        metricsEl: null,
        metricsFrames: 0,
        metricsTime: 0,
        metricsFps: 0,
        metricsDrawCalls: 0,
        batchData: new Float32Array(1024 * 6 * BATCH_STRIDE_FLOATS),
        batchCap: 1024 * 6,
        fboA: null, fboTexA: null,
        fboB: null, fboTexB: null,
        fboWidth: 0, fboHeight: 0,
        postProg: null, postLocs: null, blurProg: null, blurLocs: null, postQuadBuf: null,
        blur: null, transition: null,
        tweens: [],
        mode3d: !!(def["perspective"] || def["mode3d"]),
        prog3d: null, prog3dLocs: null, prog3dBuf: null,
        batch3dData: new Float32Array(0), batch3dCap: 0,
        batchShrinkFrames: 0, batch3dShrinkFrames: 0,
        extInstanced: null,
        progInst: null, progInstLocs: null,
        geoVBOs: new Map(), instanceBuf: null,
        instanceData: new Float32Array(0), instanceCap: 0,
        lightDir: [-0.5, -0.7, -1.0],
        lightColor: [1, 1, 1],
        ambientColor: [1, 1, 1],
        ambient: 0.3,
        shininess: 32,
        pointLights: new Float32Array(96), // 12 floats * 8 lights
        pointLightCount: 0,
        lightSlots: [],
        lightsDirty: true,
        skyboxProg: null, skyboxLocs: null, skyboxBuf: null,
        skyTop: null, skyBottom: null,
        fogColor: [0.7, 0.75, 0.85],
        fogNear: 0,
        fogFar: 0,
        ortho: false,
        fxaa: false,
        fxaaProg: null, fxaaLocs: null,
        bloom: null,
        bloomBrightProg: null, bloomBrightLocs: null,
        bloomCompProg: null, bloomCompLocs: null,
        fboC: null, fboTexC: null,
        trails: new Map(),
        // GPU Particles (lazily initialized)
        gpuParticles: new Map(),
        gpuParticleProg: null,
        gpuParticleLocs: null,
        gpuParticleQuadBuf: null,
        // Shadow mapping (cascaded, lazily initialized)
        shadow: null,
        shadowCascadeSplits: new Float32Array(3),
        shadowFbo: null, shadowTex: null,
        shadowProg: null, shadowLocs: null,
        shadowInstProg: null, shadowInstLocs: null,
        shadowLightVP: new Float32Array(48),
        // SSAO (lazily initialized)
        ssao: null,
        ssaoDepthFbo: null, ssaoDepthTex: null,
        ssaoFbo: null, ssaoTex: null,
        ssaoBlurFbo: null, ssaoBlurTex: null,
        ssaoWidth: 0, ssaoHeight: 0,
        ssaoDepthProg: null, ssaoDepthLocs: null,
        ssaoProg: null, ssaoLocs: null,
        ssaoBlurProg: null, ssaoBlurLocs: null,
        ssaoCompProg: null, ssaoCompLocs: null,
      };

      if (inst.mode3d) {
        gl.enable(gl.DEPTH_TEST);
        init3dProgram(inst, GlNode.createProgram);
        inst.camera.z = r["cameraZ"] !== undefined ? Number(r["cameraZ"]) : 5;
        if (r["fov"] !== undefined) inst.camera.fov = Number(r["fov"]);
      }

      if (r["lightDir"] !== undefined) inst.lightDir = r["lightDir"] as [number, number, number];
      if (r["ambient"] !== undefined) inst.ambient = Number(r["ambient"]);
      if (r["shininess"] !== undefined) inst.shininess = Number(r["shininess"]);
      if (r["lightColor"] !== undefined) inst.lightColor = r["lightColor"] as [number, number, number];
      if (r["ambientColor"] !== undefined) inst.ambientColor = r["ambientColor"] as [number, number, number];
      if (r["skyTop"] !== undefined) inst.skyTop = r["skyTop"] as [number, number, number];
      if (r["skyBottom"] !== undefined) inst.skyBottom = r["skyBottom"] as [number, number, number];
      if (r["fogColor"] !== undefined) inst.fogColor = r["fogColor"] as [number, number, number];
      if (r["fogNear"] !== undefined) inst.fogNear = Number(r["fogNear"]);
      if (r["fogFar"] !== undefined) inst.fogFar = Number(r["fogFar"]);
      if (r["ortho"] !== undefined) inst.ortho = !!r["ortho"];
      if (r["fxaa"] !== undefined) inst.fxaa = !!r["fxaa"];
      if (r["bloom"] !== undefined) { const bloom = parseBloom(r["bloom"]); if (bloom) inst.bloom = bloom; }
      if (r["shadow"] !== undefined && r["shadow"] && typeof r["shadow"] === "object") {
        const s = r["shadow"] as Record<string, unknown>;
        inst.shadow = {
          resolution: Number(s.resolution ?? 1024),
          bias: Number(s.bias ?? 0.005),
          softness: Number(s.softness ?? 2),
          far: Number(s.far ?? 100),
        };
        initShadow(inst, GlNode.createProgram);
      }

      if (def["resize"] !== false) {
        const ro = new ResizeObserver(() => {
          const d = window.devicePixelRatio || 1;
          const pw = Math.round(canvas.clientWidth * d);
          const ph = Math.round(canvas.clientHeight * d);
          if (pw !== canvas.width || ph !== canvas.height) {
            canvas.width = pw;
            canvas.height = ph;
            if (!inst.store.virtualWidth) {
              inst.store.width = canvas.clientWidth;
              inst.store.height = canvas.clientHeight;
            }
            const reloaded = setupGL();
            if (reloaded) Object.assign(inst, reloaded);
            if (inst.mode3d) init3dProgram(inst, GlNode.createProgram);
            inst.fboWidth = 0; // force FBO re-creation on next post-process render
            inst.dirty = true;
            GlNode.scheduleRender(inst);
          }
        });
        ro.observe(canvas);
        inst.resizeObserver = ro;
      }

      GlNode.instances.set(selector, inst);

      if (inst.metrics) {
        const el = document.createElement("div");
        el.style.cssText = "position:absolute;top:4px;left:4px;background:rgba(0,0,0,.7);color:#0f0;font:11px/1.4 monospace;padding:4px 6px;pointer-events:none;z-index:999;border-radius:3px;white-space:pre";
        canvas.parentElement?.style.setProperty("position", "relative");
        canvas.parentElement?.appendChild(el);
        inst.metricsEl = el;
      }

      (context as Record<string, unknown>)._glSelector = selector;

      if (!context._entityStores) context._entityStores = {};
      (context._entityStores as Record<string, EntityStore>)[selector] = store;

      // Entity mutations (via EntityNode) trigger rendering
      store.onChange = () => {
        inst.dirty = true;
        inst.lightsDirty = true;
        GlNode.scheduleRender(inst);
      };

      (context as Record<string, unknown>)._onPhysicsStep = (sel: string) => {
        const i = GlNode.instances.get(sel);
        if (i) { i.dirty = true; GlNode.scheduleRender(i); }
      };

      GlNode.scheduleRender(inst);
      return null;
    }); // resolveObj
  }

  // ── gl-destroy ──────────────────────────────────────────────────────────

  /** Destroys the active WebGL instance and releases GPU resources, textures, and the entity store. */
  ["gl-destroy"](_def: Record<string, unknown>, context: Context): NodeValue {
    const selector = context._glSelector as string;
    if (!selector) return null;
    const inst = GlNode.instances.get(selector);
    if (inst) GlNode.destroyInstance(inst, selector);
    if (context._entityStores) {
      delete (context._entityStores as Record<string, EntityStore>)[selector];
    }
    delete (context as Record<string, unknown>)._glSelector;
    return null;
  }

  // ── gl-hit ──────────────────────────────────────────────────────────────

  /**
   * Hit-tests a point against all visible entities (front-to-back). Returns the topmost entity id or `null`.
   * Supports 2D (AABB/circle) and 3D (ray-AABB) automatically based on the current render mode.
   * @param {boolean} gl-hit Pass `true` to perform the hit test.
   * @param {number} x Screen X coordinate.
   * @param {number} y Screen Y coordinate.
   * @example
   * { "gl-hit": true, "x": { "var": "$event.clientX" }, "y": { "var": "$event.clientY" } }
   */
  ["gl-hit"](def: Record<string, unknown>, context: Context): NodeValue {
    const inst = GlNode.getInst(context);
    if (!inst) return null;

    return resolveObj(def, context, r => {
      let px = Number(r["x"]);
      let py = Number(r["y"]);
      if (inst.store.virtualWidth) {
        px = (px - inst.vpOffsetX) / inst.vpScale;
        py = (py - inst.vpOffsetY) / inst.vpScale;
      }

      const { store } = inst;
      const d = store.data;

      // ── 3D ray-cast hit testing ──────────────────────────────────────────
      if (inst.mode3d && inst.prog3dLocs) {
        const cam = inst.camera;
        const cw = inst.canvas.width, ch = inst.canvas.height;
        const aspect = cw / ch;
        const proj = mat4Perspective(cam.fov, aspect, cam.near, cam.far);
        const view = mat4LookAt(
          [cam.x + cam.shakeX, cam.y + cam.shakeY, cam.z],
          cam.lookAt, cam.up,
        );
        const ray = unprojectRay(px, py, store.width, store.height, proj, view);
        if (!ray) return null;
        const [ox, oy, oz] = ray.origin;
        const [rdx, rdy, rdz] = ray.dir;

        // Test all entities, find closest hit (front-to-back by draw order, but pick nearest by distance)
        let bestDist = Infinity;
        let bestId: string | null = null;
        for (let i = store.order.length - 1; i >= 0; i--) {
          const slot = store.order[i];
          const b = slot * STRIDE;
          if (!(d[b + F_FLAGS] & FLAG_VISIBLE)) continue;
          const meta = store.meta[slot]!;
          if (meta.type === "pivot" || meta.type === "line" || meta.type === "line-strip" || meta.type === "points") continue;
          const ex = d[b + F_X], ey = d[b + F_Y], ez = d[b + F_Z];
          const ew = d[b + F_W], eh = d[b + F_H], ed = d[b + F_D] || 0.01;
          const t = rayAABB(ox, oy, oz, rdx, rdy, rdz, ex, ey, ez, ex + ew, ey + eh, ez + ed);
          if (t >= 0 && t < bestDist) {
            bestDist = t;
            bestId = meta.id;
          }
        }
        return bestId;
      }

      // ── 2D hit testing ───────────────────────────────────────────────────
      const cam = inst.camera;
      if (cam.zoom !== 1 || cam.x !== 0 || cam.y !== 0) {
        const vw = inst.store.virtualWidth || inst.store.width;
        const vh = inst.store.virtualHeight || inst.store.height;
        px = (px - vw / 2) / cam.zoom + cam.x + vw / 2;
        py = (py - vh / 2) / cam.zoom + cam.y + vh / 2;
      }

      for (let i = store.order.length - 1; i >= 0; i--) {
        const slot = store.order[i];
        const b = slot * STRIDE;
        if (!(d[b + F_FLAGS] & FLAG_VISIBLE)) continue;
        const meta = store.meta[slot];
        if (!meta) continue;
        if (meta.type === "pivot") continue;
        const x = d[b + F_X], y = d[b + F_Y], w = d[b + F_W], h = d[b + F_H];
        if (meta.type === "circle") {
          const cx = x + w / 2, cy = y + h / 2;
          const rx = w / 2, ry = h / 2;
          if (rx <= 0 || ry <= 0) continue;
          const dx = (px - cx) / rx, dy = (py - cy) / ry;
          if (dx * dx + dy * dy <= 1) return meta.id;
        } else if (meta.type !== "line" && meta.type !== "line-strip") {
          if (px >= x && px <= x + w && py >= y && py <= y + h) return meta.id;
        }
      }
      return null;
    }); // resolveObj
  }

  // ── gl-camera ───────────────────────────────────────────────────────────

  /**
   * Controls the camera. In 2D: `x`, `y`, `zoom`, `rotation`, `follow` (entity id).
   * Shake: `shake` (intensity), `shakeDuration`, `shakeDecay`. Trauma: `trauma` (0–1 accumulated).
   * In 3D: `z`, `fov`, `near`, `far`, `lookAt` ([x,y,z]), `up` ([x,y,z]).
   * @param {boolean} gl-camera Pass `true` to update the camera.
   * @param {number} x Camera X position.
   * @param {number} y Camera Y position.
   * @param {number} zoom Camera zoom factor.
   * @param {string} follow Entity ID to follow.
   * @param {number} shake Shake intensity.
   * @example
   * { "gl-camera": true, "follow": "player", "zoom": 1.5 }
   */
  ["gl-camera"](def: Record<string, unknown>, context: Context): NodeValue {
    const inst = GlNode.getInst(context);
    if (!inst) return null;

    return resolveObj(def, context, r => {
      const cam = inst.camera;
      if (r["x"] !== undefined) cam.x = Number(r["x"]);
      if (r["y"] !== undefined) cam.y = Number(r["y"]);
      if (r["zoom"] !== undefined) cam.zoom = Number(r["zoom"]);
      if (r["rotation"] !== undefined) cam.rotation = Number(r["rotation"]);
      if (r["follow"] !== undefined) cam.follow = r["follow"] ? String(r["follow"]) : null;

      if (r["shake"] !== undefined) {
        cam.shake = Number(r["shake"]);
        cam.shakeElapsed = 0;
        if (r["shakeDuration"] !== undefined) cam.shakeDuration = Number(r["shakeDuration"]);
        if (r["shakeDecay"] !== undefined) cam.shakeDecay = Number(r["shakeDecay"]);
      }
      if (r["trauma"] !== undefined) {
        cam.trauma = Math.min(1, cam.trauma + Number(r["trauma"]));
        if (r["traumaDecay"] !== undefined) cam.traumaDecay = Number(r["traumaDecay"]);
        if (r["maxShake"] !== undefined) cam.maxShake = Number(r["maxShake"]);
        if (r["maxShakeAngle"] !== undefined) cam.maxShakeAngle = Number(r["maxShakeAngle"]);
      }

      if (r["z"] !== undefined) cam.z = Number(r["z"]);
      if (r["fov"] !== undefined) cam.fov = Number(r["fov"]);
      if (r["near"] !== undefined) cam.near = Number(r["near"]);
      if (r["far"] !== undefined) cam.far = Number(r["far"]);
      if (r["lookAt"] !== undefined) cam.lookAt = r["lookAt"] as [number, number, number];
      if (r["up"] !== undefined) cam.up = r["up"] as [number, number, number];

      if (r["pitch"] !== undefined) cam.pitch = Number(r["pitch"]);
      if (r["yaw"] !== undefined) cam.yaw = Number(r["yaw"]);
      if (r["followMode"] !== undefined) cam.followMode = r["followMode"] as "fps" | "tps" | null;
      if (r["followOffsetZ"] !== undefined) cam.followOffsetZ = Number(r["followOffsetZ"]);
      if (r["tpsDistance"] !== undefined) cam.tpsDistance = Number(r["tpsDistance"]);
      if (r["tpsHeight"] !== undefined) cam.tpsHeight = Number(r["tpsHeight"]);

      if (r["lightDir"] !== undefined) inst.lightDir = r["lightDir"] as [number, number, number];
      if (r["ambient"] !== undefined) inst.ambient = Number(r["ambient"]);
      if (r["shininess"] !== undefined) inst.shininess = Number(r["shininess"]);
      if (r["lightColor"] !== undefined) inst.lightColor = r["lightColor"] as [number, number, number];
      if (r["ambientColor"] !== undefined) inst.ambientColor = r["ambientColor"] as [number, number, number];
      if (r["skyTop"] !== undefined) inst.skyTop = r["skyTop"] as [number, number, number];
      if (r["skyBottom"] !== undefined) inst.skyBottom = r["skyBottom"] as [number, number, number];
      if (r["fogColor"] !== undefined) inst.fogColor = r["fogColor"] as [number, number, number];
      if (r["fogNear"] !== undefined) inst.fogNear = Number(r["fogNear"]);
      if (r["fogFar"] !== undefined) inst.fogFar = Number(r["fogFar"]);
      if (r["ortho"] !== undefined) inst.ortho = !!r["ortho"];
      if (r["fxaa"] !== undefined) inst.fxaa = !!r["fxaa"];
      if (r["bloom"] !== undefined) inst.bloom = parseBloom(r["bloom"]);
      if (r["shadow"] !== undefined) {
        if (r["shadow"] && typeof r["shadow"] === "object") {
          const s = r["shadow"] as Record<string, unknown>;
          inst.shadow = {
            resolution: Number(s.resolution ?? 1024),
            bias: Number(s.bias ?? 0.005),
            softness: Number(s.softness ?? 2),
            far: Number(s.far ?? 100),
          };
          if (!inst.shadowFbo) initShadow(inst, GlNode.createProgram);
        } else {
          inst.shadow = null;
        }
      }

      inst.dirty = true;
      GlNode.scheduleRender(inst);
      return null;
    });
  }

  // ── gl-texture ──────────────────────────────────────────────────────────

  /**
   * Loads an image from `src` and registers it as a named texture. Assign to entities via `texture: "name"`.
   * @param {string} gl-texture Texture name.
   * @param {string} src URL of the image to load.
   * @example
   * { "gl-texture": "ship", "src": "/assets/ship.png" }
   */
  ["gl-texture"](def: Record<string, unknown>, context: Context): NodeValue {
    const inst = GlNode.getInst(context);
    if (!inst) return null;
    return resolveAll([def["gl-texture"], def["src"]], context, ([nameV, srcV]) => {
      const name = String(nameV);
      const src = String(srcV);
      const img = new Image();
      img.crossOrigin = "anonymous";
      return new Promise<NodeValue>((res) => {
        img.onload = () => {
          const tex = GlNode.createTexture(inst.gl, img);
          if (tex) inst.textures.set(name, { tex, w: img.width, h: img.height });
          inst.dirty = true;
          GlNode.scheduleRender(inst);
          res(null);
        };
        img.onerror = () => {
          console.error("[GL] Failed to load texture:", src);
          res(null);
        };
        img.src = src;
      });
    });
  }

  // ── gl-atlas ───────────────────────────────────────────────────────────
  // Pre-compute UV rects for a spritesheet: { "gl-atlas": "name", "src": "sheet.png", "cols": 8, "rows": 4 }

  /**
   * Loads a spritesheet and pre-computes UV rects for each frame. Pass `cols` and `rows` to define the grid.
   * Returns the total frame count. Use frame indices with `gl-animate` or `gl-frame`.
   * @param {string} gl-atlas Atlas name.
   * @param {string} src URL of the spritesheet image.
   * @param {number} cols Number of columns in the grid.
   * @param {number} rows Number of rows in the grid.
   * @example
   * { "gl-atlas": "tiles", "src": "/assets/tiles.png", "cols": 8, "rows": 4 }
   */
  ["gl-atlas"](def: Record<string, unknown>, context: Context): NodeValue {
    const inst = GlNode.getInst(context);
    if (!inst) return null;
    return resolveObj(def, context, r => {
      const name = String(r["gl-atlas"]);
      const src = String(r["src"]);
      const cols = Number(r["cols"]) || 1;
      const rows = Number(r["rows"]) || 1;
      const img = new Image();
      img.crossOrigin = "anonymous";
      return new Promise<NodeValue>((res) => {
        img.onload = () => {
          const tex = GlNode.createTexture(inst.gl, img);
          if (tex) inst.textures.set(name, { tex, w: img.width, h: img.height });
          const frames: [number, number, number, number][] = [];
          const uW = 1 / cols, vH = 1 / rows;
          for (let ri = 0; ri < rows; ri++) {
            for (let ci = 0; ci < cols; ci++) {
              frames.push([ci * uW, ri * vH, uW, vH]);
            }
          }
          inst.atlases.set(name, { texture: name, frames });
          inst.dirty = true;
          GlNode.scheduleRender(inst);
          res(frames.length);
        };
        img.onerror = () => {
          console.error("[GL] Failed to load atlas texture:", src);
          res(null);
        };
        img.src = src;
      });
    });
  }

  // ── gl-animate ──────────────────────────────────────────────────────────

  /**
   * Starts a frame animation on an entity from an atlas. Pass `atlas`, `frames` (array of frame indices),
   * `fps`, and `loop`. Set `stop: true` to cancel the current animation.
   * @param {string} gl-animate Entity ID to animate.
   * @param {string} atlas Atlas name (registered via `gl-atlas`).
   * @param {number[]} frames Array of frame indices from the atlas.
   * @param {number} fps Frames per second for the animation.
   * @param {boolean} loop Whether to loop the animation.
   * @param {boolean} stop Pass `true` to stop the current animation.
   * @example
   * { "gl-animate": "player", "atlas": "sprites", "frames": [0, 1, 2, 3], "fps": 12, "loop": true }
   */
  ["gl-animate"](def: Record<string, unknown>, context: Context): NodeValue {
    const inst = GlNode.getInst(context);
    if (!inst) return null;
    return resolveObj(def, context, r => {
      const id = String(r["gl-animate"]);
      const slot = inst.store.slot(id);
      if (slot === -1) return null;
      const meta = inst.store.meta[slot]!;
      if (r["stop"]) { meta.anim = undefined; return null; }
      let frames: [number, number, number, number][];
      if (r["atlas"] !== undefined) {
        const atlasName = String(r["atlas"]);
        const atlas = inst.atlases.get(atlasName);
        if (!atlas) { console.error("[GL] Atlas not found:", atlasName); return null; }
        const indices = r["frames"] as number[];
        frames = indices.map(i => atlas.frames[i] ?? atlas.frames[0]);
        meta.textureName = atlas.texture;
      } else {
        frames = r["frames"] as [number, number, number, number][];
      }
      const fps = r["fps"] !== undefined ? Number(r["fps"]) : 12;
      const loop = r["loop"] !== undefined ? this.toBoolean(r["loop"]) : true;
      meta.anim = { frames, fps, loop, current: 0, elapsed: 0 };
      if (frames.length > 0) {
        const d = inst.store.data;
        const b = slot * STRIDE;
        d[b + F_U] = frames[0][0]; d[b + F_V] = frames[0][1];
        d[b + F_UW] = frames[0][2]; d[b + F_UH] = frames[0][3];
      }
      inst.dirty = true;
      GlNode.scheduleRender(inst);
      return null;
    });
  }

  // ── gl-frame — set entity UV from atlas frame index ─────────────────────
  // { "gl-frame": "entityId", "atlas": "name", "frame": 5 }

  /**
   * Sets a static atlas frame on an entity (no animation). Pass entity id, `atlas`, and `frame` index.
   * @param {string} gl-frame Entity ID.
   * @param {string} atlas Atlas name (registered via `gl-atlas`).
   * @param {number} frame Frame index within the atlas.
   * @example
   * { "gl-frame": "player", "atlas": "sprites", "frame": 5 }
   */
  ["gl-frame"](def: Record<string, unknown>, context: Context): NodeValue {
    const inst = GlNode.getInst(context);
    if (!inst) return null;
    return resolveObj(def, context, r => {
      const id = String(r["gl-frame"]);
      const slot = inst.store.slot(id);
      if (slot === -1) return null;
      const atlasName = String(r["atlas"]);
      const atlas = inst.atlases.get(atlasName);
      if (!atlas) { console.error("[GL] Atlas not found:", atlasName); return null; }
      const frame = Number(r["frame"]) | 0;
      const uv = atlas.frames[frame];
      if (!uv) return null;
      const d = inst.store.data;
      const b = slot * STRIDE;
      d[b + F_U] = uv[0]; d[b + F_V] = uv[1];
      d[b + F_UW] = uv[2]; d[b + F_UH] = uv[3];
      const meta = inst.store.meta[slot]!;
      meta.textureName = atlas.texture;
      meta.dirty |= DIRTY_VISUAL;
      inst.dirty = true;
      GlNode.scheduleRender(inst);
      return null;
    });
  }

  // ── gl-tilemap — efficient grid rendering using atlas ──────────────────
  // { "gl-tilemap": "level1", "atlas": "tiles", "data": [[1,0,2],[3,1,0]], "tileWidth": 32, "tileHeight": 32 }

  /**
   * Builds an efficient GPU tilemap VBO from a 2D array of atlas frame indices.
   * Pass `atlas`, `data` (rows of frame indices), `tileWidth`, `tileHeight`, and optional `z`.
   * Returns the rendered tile count.
   * @param {string} gl-tilemap Tilemap entity ID.
   * @param {string} atlas Atlas name (registered via `gl-atlas`).
   * @param {number[][]} data 2D array of atlas frame indices (rows × columns).
   * @param {number} tileWidth Width of each tile in pixels (default `32`).
   * @param {number} tileHeight Height of each tile in pixels (default `32`).
   * @example
   * { "gl-tilemap": "level1", "atlas": "tiles", "data": [[1,0,2],[3,1,0]], "tileWidth": 32, "tileHeight": 32 }
   */
  ["gl-tilemap"](def: Record<string, unknown>, context: Context): NodeValue {
    const inst = GlNode.getInst(context);
    if (!inst) return null;
    return resolveObj(def, context, r => {
      const name = String(r["gl-tilemap"]);
      const atlasName = String(r["atlas"]);
      const atlas = inst.atlases.get(atlasName);
      if (!atlas) { console.error("[GL] Atlas not found for tilemap:", atlasName); return null; }
      const data = r["data"] as number[][];
      const tileW = Number(r["tileWidth"]) || 32;
      const tileH = Number(r["tileHeight"]) || 32;
      const z = r["z"] !== undefined ? Number(r["z"]) : -1;
      const existing = inst.tilemaps.get(name);
      const vbo = existing?.vbo ?? inst.gl.createBuffer();
      if (!vbo) return null;
      const { vertData, vertCount } = GlNode.buildTilemapVBO(data, tileW, tileH, atlas.frames);
      const gl = inst.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, vertData, gl.STATIC_DRAW);
      inst.tilemaps.set(name, { vbo, vertCount, textureName: atlas.texture, z, dirty: false, data, atlas: atlasName, tileW, tileH });
      inst.dirty = true;
      GlNode.scheduleRender(inst);
      return vertCount / 6;
    });
  }

  // { "gl-tilemap-set": "level1", "x": 3, "y": 2, "tile": 5 }
  ["gl-tilemap-set"](def: Record<string, unknown>, context: Context): NodeValue {
    const inst = GlNode.getInst(context);
    if (!inst) return null;
    return resolveObj(def, context, r => {
      const name = String(r["gl-tilemap-set"]);
      const tm = inst.tilemaps.get(name);
      if (!tm) return null;
      const tx = Number(r["x"]) | 0;
      const ty = Number(r["y"]) | 0;
      const tile = Number(r["tile"]) | 0;
      if (ty >= 0 && ty < tm.data.length && tx >= 0 && tx < (tm.data[0]?.length ?? 0)) {
        tm.data[ty][tx] = tile;
        const atlas = inst.atlases.get(tm.atlas);
        if (atlas) {
          const { vertData, vertCount } = GlNode.buildTilemapVBO(tm.data, tm.tileW, tm.tileH, atlas.frames);
          const gl = inst.gl;
          gl.bindBuffer(gl.ARRAY_BUFFER, tm.vbo);
          gl.bufferData(gl.ARRAY_BUFFER, vertData, gl.STATIC_DRAW);
          tm.vertCount = vertCount;
        }
        inst.dirty = true;
        GlNode.scheduleRender(inst);
      }
      return null;
    });
  }

  /** Build tilemap vertex data in batch format: (x,y, r,g,b,a, u,v, useTex) per vertex, 6 verts per tile. */
  private static buildTilemapVBO(data: number[][], tileW: number, tileH: number, frames: [number, number, number, number][]): { vertData: Float32Array; vertCount: number } {
    // Count non-empty tiles
    let count = 0;
    for (let r = 0; r < data.length; r++) {
      for (let c = 0; c < data[r].length; c++) {
        if (data[r][c] > 0) count++;
      }
    }
    // 6 verts per tile, BATCH_STRIDE_FLOATS (9) floats per vert
    const vertData = new Float32Array(count * 6 * BATCH_STRIDE_FLOATS);
    let offset = 0;

    const emitVert = (x: number, y: number, u: number, v: number) => {
      vertData[offset++] = x;   // position x
      vertData[offset++] = y;   // position y
      vertData[offset++] = 1;   // r
      vertData[offset++] = 1;   // g
      vertData[offset++] = 1;   // b
      vertData[offset++] = 1;   // a
      vertData[offset++] = u;   // tex u
      vertData[offset++] = v;   // tex v
      vertData[offset++] = 1;   // useTex
    };

    for (let r = 0; r < data.length; r++) {
      for (let c = 0; c < data[r].length; c++) {
        const tileIdx = data[r][c];
        if (tileIdx <= 0) continue;
        const frame = frames[tileIdx] ?? frames[0];
        if (!frame) continue;
        const x0 = c * tileW, y0 = r * tileH;
        const x1 = x0 + tileW, y1 = y0 + tileH;
        const [fu, fv, fuW, fvH] = frame;
        const u1 = fu + fuW, v1 = fv + fvH;
        // Triangle 1: top-left, top-right, bottom-left
        emitVert(x0, y0, fu, fv);
        emitVert(x1, y0, u1, fv);
        emitVert(x0, y1, fu, v1);
        // Triangle 2: top-right, bottom-right, bottom-left
        emitVert(x1, y0, u1, fv);
        emitVert(x1, y1, u1, v1);
        emitVert(x0, y1, fu, v1);
      }
    }
    return { vertData: vertData.subarray(0, offset), vertCount: count * 6 };
  }

  // ── gl-trail — attach a trail to an entity ─────────────────────────────
  // { "gl-trail": "player", "length": 20, "width": 2, "color": [1,0,0,1] }

  /**
   * Attaches a motion trail to an entity. The trail follows the entity's position each frame.
   * Pass entity id, `length` (max trail points), `width`, and `color`.
   * @param {string} gl-trail Entity ID to attach trail to.
   * @param {number} length Maximum number of trail points (default `20`).
   * @param {number} width Trail line width in pixels (default `2`).
   * @param {number[]} color Trail color as `[r, g, b, a]`.
   * @example
   * { "gl-trail": "player", "length": 20, "width": 3, "color": [1, 0.5, 0, 0.8] }
   */
  ["gl-trail"](def: Record<string, unknown>, context: Context): NodeValue {
    const inst = GlNode.getInst(context);
    if (!inst) return null;
    return resolveObj(def, context, r => {
      const entityId = String(r["gl-trail"]);
      const length = r["length"] !== undefined ? Number(r["length"]) : 20;
      const width = r["width"] !== undefined ? Number(r["width"]) : 2;
      const rawColor = (r["color"] ?? [1, 1, 1, 1]) as number[];
      const color: [number, number, number, number] = [rawColor[0] ?? 1, rawColor[1] ?? 1, rawColor[2] ?? 1, rawColor[3] ?? 1];
      inst.trails.set(entityId, { entityId, length, width, color, points: new Float32Array(length * 2), head: 0, count: 0 });
      return null;
    });
  }

  // { "gl-trail-remove": "player" }
  /** Removes the motion trail from an entity. */
  ["gl-trail-remove"](def: Record<string, unknown>, context: Context): NodeValue {
    const inst = GlNode.getInst(context);
    if (!inst) return null;
    return resolve(def["gl-trail-remove"], context, v => { inst.trails.delete(String(v)); return null; });
  }

  // ── gl-raycast — cast a ray and return sorted hits ─────────────────────
  // { "gl-raycast": true, "from": {"x":0,"y":0,"z":0}, "dir": {"x":1,"y":0,"z":0}, "mask": ["enemy"] }

  /**
   * Casts a ray from `from` in direction `dir` and returns all hit entities sorted by distance.
   * Pass `mask` (array of group names) to restrict which entities are tested.
   * @param {boolean} gl-raycast Pass `true` to cast.
   * @param {expr} from Origin vector `{x, y, z?}`.
   * @param {expr} dir Direction vector `{x, y, z?}`.
   * @param {string[]} mask Group names to test against (default: all groups).
   * @example
   * { "gl-raycast": true, "from": { "x": 0, "y": 0, "z": 0 }, "dir": { "x": 1, "y": 0, "z": 0 }, "mask": ["enemies"] }
   */
  ["gl-raycast"](def: Record<string, unknown>, context: Context): NodeValue {
    const inst = GlNode.getInst(context);
    if (!inst) return null;
    return resolveObj(def, context, r => {
      const from = r["from"] as { x: number; y: number; z?: number } | null;
      const dir = r["dir"] as { x: number; y: number; z?: number } | null;
      if (!from || !dir) return [];
      const maskArr = r["mask"] !== undefined ? r["mask"] as string[] : null;
      const maskSet = maskArr ? new Set(maskArr) : null;
      return raycastStore(inst.store, from.x, from.y, from.z ?? 0, dir.x, dir.y, dir.z ?? 0, maskSet);
    });
  }

  // ── gl-text ─────────────────────────────────────────────────────────────

  /**
   * Renders text onto a canvas texture and assigns it to an entity. Creates the entity if it doesn't exist.
   * Pass entity id, `text`, `font` (CSS font string), `fill` (color), and position `x`, `y`, `z`.
   * @param {string} gl-text Entity ID.
   * @param {string} text Text content to render.
   * @param {string} font CSS font string (e.g. `"24px Arial"`).
   * @param {string} fill CSS color string for the text fill.
   * @example
   * { "gl-text": "score-label", "text": { "var": "$score" }, "font": "24px Arial", "fill": "#fff", "x": 10, "y": 10 }
   */
  ["gl-text"](def: Record<string, unknown>, context: Context): NodeValue {
    const inst = GlNode.getInst(context);
    if (!inst) return null;
    return resolveObj(def, context, r => {
      const id = String(r["gl-text"]);
      const text = String(r["text"]);
      const font = r["font"] ? String(r["font"]) : "16px sans-serif";
      const fill = r["fill"] ? String(r["fill"]) : "#ffffff";
      let slot = inst.store.slot(id);
      if (slot === -1) {
        const x = r["x"] !== undefined ? Number(r["x"]) : 0;
        const y = r["y"] !== undefined ? Number(r["y"]) : 0;
        const z = r["z"] !== undefined ? Number(r["z"]) : 0;
        const fixed = r["fixed"] !== undefined ? this.toBoolean(r["fixed"]) : true;
        slot = inst.store.add(id, "quad", "default", ["default"], undefined, {
          x, y, w: 1, h: 1, z, color: [1, 1, 1, 1], visible: true, fixed,
        });
        if (z !== 0) { inst.store.zDirty = true; inst.store.zDirtyCount++; }
      }
      const meta = inst.store.meta[slot]!;
      meta.text = { content: text, font, fill };
      meta.textureName = `__text_${id}`;
      renderTextTexture(inst, id, meta, GlNode.createTexture);
      const texInfo = inst.textures.get(meta.textureName);
      if (texInfo) {
        const d = inst.store.data;
        const b = slot * STRIDE;
        d[b + F_W] = r["w"] !== undefined ? Number(r["w"]) : texInfo.w;
        d[b + F_H] = r["h"] !== undefined ? Number(r["h"]) : texInfo.h;
      }
      inst.dirty = true;
      GlNode.scheduleRender(inst);
      return null;
    });
  }

  // ── gl-shader ───────────────────────────────────────────────────────────

  /**
   * Compiles and registers a custom GLSL shader program. Pass `name`, `vert` (vertex source), and `frag` (fragment source).
   * Assign to entities with `shader: "name"`. Standard uniforms (`u_transform`, `u_texture`, `u_time`, etc.) are auto-bound.
   * @param {string} gl-shader Shader name.
   * @param {string} vert GLSL vertex shader source.
   * @param {string} frag GLSL fragment shader source.
   * @example
   * { "gl-shader": "glow", "vert": "...", "frag": "..." }
   */
  ["gl-shader"](def: Record<string, unknown>, context: Context): NodeValue {
    const inst = GlNode.getInst(context);
    if (!inst) return null;
    return resolveObj(def, context, r => {
      const name = String(r["gl-shader"]);
      const vert = r["vert"] ? String(r["vert"]) : VERT_SRC;
      const frag = r["frag"] ? String(r["frag"]) : FRAG_SRC;
      const program = GlNode.createProgram(inst.gl, vert, frag, inst.isWebGL2);
      if (!program) { console.error("[GL] Failed to compile shader:", name); return null; }
      const gl = inst.gl;
      const uniforms: Record<string, WebGLUniformLocation | null> = {
        u_transform: gl.getUniformLocation(program, "u_transform"),
        u_projection: gl.getUniformLocation(program, "u_projection"),
        u_color: gl.getUniformLocation(program, "u_color"),
        u_uvRect: gl.getUniformLocation(program, "u_uvRect"),
        u_useTexture: gl.getUniformLocation(program, "u_useTexture"),
        u_texture: gl.getUniformLocation(program, "u_texture"),
        u_time: gl.getUniformLocation(program, "u_time"),
        u_resolution: gl.getUniformLocation(program, "u_resolution"),
        u_view: gl.getUniformLocation(program, "u_view"),
        u_model: gl.getUniformLocation(program, "u_model"),
        u_lightDir: gl.getUniformLocation(program, "u_lightDir"),
        u_ambient: gl.getUniformLocation(program, "u_ambient"),
      };
      inst.shaders.set(name, { program, uniforms });
      return null;
    });
  }

  // ── gl-blur ─────────────────────────────────────────────────────────────

  /**
   * Applies a full-screen Gaussian blur post-process effect. Pass the blur radius in pixels; `0` disables it.
   * @param {number} gl-blur Blur radius in pixels (`0` to disable).
   * @example
   * { "gl-blur": 4 }
   */
  ["gl-blur"](def: Record<string, unknown>, context: Context): NodeValue {
    const inst = GlNode.getInst(context);
    if (!inst) return null;
    return resolve(def["gl-blur"], context, v => {
      const radius = Number(v);
      inst.blur = radius > 0 ? { radius } : null;
      inst.dirty = true;
      GlNode.scheduleRender(inst);
      return null;
    });
  }

  // ── gl-transition ──────────────────────────────────────────────────────

  /**
   * Plays a fade transition overlay. Pass `duration` in seconds (default 0.5).
   * @param {boolean} gl-transition Pass `true` to trigger.
   * @param {number} duration Transition duration in seconds (default `0.5`).
   * @example
   * { "gl-transition": true, "duration": 0.8 }
   */
  ["gl-transition"](def: Record<string, unknown>, context: Context): NodeValue {
    const inst = GlNode.getInst(context);
    if (!inst) return null;
    return resolveObj(def, context, r => {
      const duration = r["duration"] !== undefined ? Number(r["duration"]) : 0.5;
      inst.transition = { type: "fade", duration, elapsed: 0 };
      inst.dirty = true;
      GlNode.scheduleRender(inst);
      return null;
    });
  }

  // ── gl-tween ────────────────────────────────────────────────────────────

  /**
   * Animates numeric entity properties over time. Pass entity id, target values (`x`, `y`, `w`, `h`, `angle`, `opacity`, `color`, etc.),
   * `duration` (seconds), and `easing` (e.g. `"easeOutQuad"`, `"linear"`). Pass `then` steps to run on completion.
   * @param {string} gl-tween Entity ID.
   * @param {number} duration Animation duration in seconds (default `0.3`).
   * @param {"linear"|"easeOutQuad"|"easeInOutCubic"|"easeInOutQuad"|"easeOutBounce"|"easeOutElastic"} easing Easing function name.
   * @param {expr[]} then Steps to run when the tween completes.
   * @example
   * { "gl-tween": "player", "x": 400, "y": 300, "duration": 0.5, "easing": "easeInOutCubic" }
   */
  ["gl-tween"](def: Record<string, unknown>, context: Context): NodeValue {
    const inst = GlNode.getInst(context);
    if (!inst) return null;
    const thenBranch = Array.isArray(def["then"]) ? def["then"] as unknown[] : null;
    const resolvable: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(def)) { if (k !== "then") resolvable[k] = v; }
    return resolveObj(resolvable, context, r => {
      const id = String(r["gl-tween"]);
      const slot = inst.store.slot(id);
      if (slot === -1) return null;
      const duration = r["duration"] !== undefined ? Number(r["duration"]) : 0.3;
      const easingName = r["easing"] ? String(r["easing"]) : "easeOutQuad";
      const easing = EASINGS[easingName] ?? EASINGS.linear;
      const d = inst.store.data;
      const b = slot * STRIDE;
      const fields: number[] = [];
      const starts: number[] = [];
      const ends: number[] = [];
      for (const [key, offset] of Object.entries(TWEENABLE_KEYS)) {
        if (r[key] !== undefined) {
          fields.push(offset);
          starts.push(d[b + offset]);
          ends.push(Number(r[key]));
        }
      }
      if (r["color"] !== undefined) {
        const c = r["color"] as number[];
        const colorFields = [F_CR, F_CG, F_CB, F_CA];
        for (let i = 0; i < 4; i++) {
          fields.push(colorFields[i]);
          starts.push(d[b + colorFields[i]]);
          ends.push(c[i]);
        }
      }
      if (fields.length === 0) return null;
      cancelConflictingTweens(inst.tweens, slot, fields);
      inst.tweens.push({ slot, fields, starts, ends, duration, elapsed: 0, easing, then: thenBranch, context: thenBranch ? { ...context } : null });
      inst.dirty = true;
      GlNode.scheduleRender(inst);
      return null;
    });
  }

  // ── gl-ssao (screen-space ambient occlusion) ────────────────────────────
  // Usage: { "gl-ssao": true, "radius": 0.5, "bias": 0.025, "intensity": 1.5 }
  //        { "gl-ssao": false } to disable
  /**
   * Enables screen-space ambient occlusion (SSAO) for 3D scenes. Pass `radius`, `bias`, and `intensity`.
   * Set `gl-ssao: false` to disable.
   * @example
   * { "gl-ssao": true, "radius": 0.5, "bias": 0.025, "intensity": 1.5 }
   */
  ["gl-ssao"](def: Record<string, unknown>, context: Context): NodeValue {
    const inst = GlNode.getInst(context);
    if (!inst) return null;
    return resolve(def["gl-ssao"], context, enabled => {
      if (!enabled || enabled === "false") { inst.ssao = null; return null; }
      return resolveObj(def, context, r => {
        inst.ssao = {
          radius: Number(r["radius"] ?? 0.5),
          bias: Number(r["bias"] ?? 0.025),
          intensity: Number(r["intensity"] ?? 1.5),
        };
        if (!inst.ssaoProg) initSsao(inst, GlNode.createProgram);
        inst.dirty = true;
        GlNode.scheduleRender(inst);
        return null;
      });
    });
  }

  // ── gl-particle (GPU-accelerated stateless particle emitter) ─────────────
  // Simple burst: { "gl-particle": true, "x": 10, "y": 5, "z": 0, "count": 20,
  //                 "speed": 5, "life": 1, "size": 0.3, "sizeEnd": 0,
  //                 "color": [1,0.5,0,1], "colorEnd": [1,0,0,0] }
  // Create named emitter: { "gl-particle": "create", "id": "fire", "max": 5000,
  //                         "life": 1.5, "speed": 3, "continuous": true, "rate": 500 }
  // Emit burst: { "gl-particle": "emit", "id": "fire", "x": 0, "y": 0, "z": 0, "count": 100 }
  // Destroy: { "gl-particle": "destroy", "id": "fire" }
  /**
   * GPU-accelerated particle system. Pass `true` for a one-shot burst, or use operations:
   * - `"create"` — register a named emitter (`id`, `max`, `life`, `speed`, `continuous`, `rate`)
   * - `"emit"` — burst from a named emitter (`id`, `x`, `y`, `z`, `count`)
   * - `"destroy"` — remove a named emitter
   * All modes support `color`, `colorEnd`, `size`, `sizeEnd`, `life`, `speed`.
   * @example
   * { "gl-particle": true, "x": 100, "y": 200, "count": 30, "speed": 5, "life": 1, "color": [1,0.5,0,1] }
   */
  ["gl-particle"](def: Record<string, unknown>, context: Context): NodeValue {
    const inst = GlNode.getInst(context);
    if (!inst) return null;
    if (!inst.gpuParticleProg) initGpuParticleProgram(inst, GlNode.createProgram);
    return resolveObj(def, context, r => {
      const gl = inst.gl;
      const actionStr = String(r["gl-particle"]);

      if (actionStr === "destroy") {
        const id = String(r["id"] ?? "default");
        const em = inst.gpuParticles.get(id);
        if (em) { gl.deleteBuffer(em.vbo); inst.gpuParticles.delete(id); }
        return null;
      }

      if (actionStr === "emit") {
        const id = String(r["id"] ?? "default");
        const emitter = inst.gpuParticles.get(id);
        if (!emitter) return null;
        const count = Number(r["count"] ?? 10);
        const x = r["x"] !== undefined ? Number(r["x"]) : emitter.x;
        const y = r["y"] !== undefined ? Number(r["y"]) : emitter.y;
        const z = r["z"] !== undefined ? Number(r["z"]) : emitter.z;
        emitGpuParticles(inst, emitter, x, y, z, count);
        inst.dirty = true;
        GlNode.scheduleRender(inst);
        return null;
      }

      const isCreate = actionStr === "create";
      const id = isCreate ? String(r["id"] ?? "default") : "__burst_" + (++GlNode._burstId);
      const count = Number(r["count"] ?? (isCreate ? 5000 : 10));
      const maxP = Number(r["max"] ?? (isCreate ? Math.max(count, 5000) : Math.max(count * 4, 200)));
      const life = Number(r["life"] ?? 1.0);
      const grav = (r["gravity"] ?? [0, 0, 0]) as number[];
      const color = (r["color"] ?? [1, 1, 1, 1]) as number[];
      const colorEnd = (r["colorEnd"] ?? [color[0], color[1], color[2], 0]) as number[];

      const old = inst.gpuParticles.get(id);
      if (old) gl.deleteBuffer(old.vbo);

      const vbo = gl.createBuffer()!;
      const data = new Float32Array(maxP * GPU_PARTICLE_INST_STRIDE);
      for (let i = 0; i < maxP; i++) data[i * GPU_PARTICLE_INST_STRIDE + 3] = -1e6;
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);

      const emitter: GpuParticleEmitter = {
        id, maxParticles: maxP, lifetime: life,
        gravity: [grav[0] ?? 0, grav[1] ?? 0, grav[2] ?? 0],
        head: 0, data, vbo,
        x: 0, y: 0, z: 0,
        speed: Number(r["speed"] ?? 3),
        spread: Number(r["spread"] ?? Math.PI * 2),
        dirX: Number(r["dirX"] ?? 0),
        dirY: Number(r["dirY"] ?? -1),
        dirZ: Number(r["dirZ"] ?? 0),
        size: Number(r["size"] ?? 0.3),
        sizeEnd: r["sizeEnd"] !== undefined ? Number(r["sizeEnd"]) : 0,
        color: [color[0], color[1], color[2], color[3] ?? 1],
        colorEnd: [colorEnd[0], colorEnd[1], colorEnd[2], colorEnd[3] ?? 0],
        continuous: !!r["continuous"],
        rate: Number(r["rate"] ?? 100),
        accumulator: 0,
        texture: r["texture"] ? String(r["texture"]) : null,
        blend: (r["blend"] ?? "additive") as "additive" | "normal",
      };

      inst.gpuParticles.set(id, emitter);

      if (!emitter.continuous || !isCreate) {
        const x = r["x"] !== undefined ? Number(r["x"]) : 0;
        const y = r["y"] !== undefined ? Number(r["y"]) : 0;
        const z = r["z"] !== undefined ? Number(r["z"]) : 0;
        emitGpuParticles(inst, emitter, x, y, z, count);
      }

      inst.dirty = true;
      GlNode.scheduleRender(inst);
      return null;
    });
  }

  private static _burstId = 0;



  // ── Internal helpers ────────────────────────────────────────────────────

  private static getInst(context: Context): GlInstance | null {
    const selector = context._glSelector as string | undefined;
    return selector ? GlNode.instances.get(selector) ?? null : null;
  }

  private static resolveCanvas(selector: string): HTMLCanvasElement | null {
    let el = document.querySelector(selector) as HTMLElement | null;
    if (!el) el = document.getElementById(selector);
    if (!el) return null;
    if (el instanceof HTMLCanvasElement) return el;
    const canvas = document.createElement("canvas");
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    el.appendChild(canvas);
    return canvas;
  }

  private static destroyInstance(inst: GlInstance, selector: string): void {
    if (inst.rafId !== null) { cancelAnimationFrame(inst.rafId); inst.rafId = null; }
    if (inst.resizeObserver) inst.resizeObserver.disconnect();
    // Clean up textures
    for (const { tex } of inst.textures.values()) inst.gl.deleteTexture(tex);
    for (const { tex } of inst.textCache.values()) inst.gl.deleteTexture(tex);
    for (const { program } of inst.shaders.values()) inst.gl.deleteProgram(program);
    inst.gl.deleteProgram(inst.batchProg);
    inst.gl.deleteBuffer(inst.batchBuf);
    // Post-processing cleanup
    const gl = inst.gl;
    if (inst.fboA) gl.deleteFramebuffer(inst.fboA);
    if (inst.fboTexA) gl.deleteTexture(inst.fboTexA);
    if (inst.fboB) gl.deleteFramebuffer(inst.fboB);
    if (inst.fboTexB) gl.deleteTexture(inst.fboTexB);
    if (inst.postProg) gl.deleteProgram(inst.postProg);
    if (inst.blurProg) gl.deleteProgram(inst.blurProg);
    if (inst.postQuadBuf) gl.deleteBuffer(inst.postQuadBuf);
    // Skybox cleanup
    if (inst.skyboxProg) gl.deleteProgram(inst.skyboxProg);
    if (inst.skyboxBuf) gl.deleteBuffer(inst.skyboxBuf);
    // Shadow cleanup
    if (inst.shadowFbo) gl.deleteFramebuffer(inst.shadowFbo);
    if (inst.shadowTex) gl.deleteTexture(inst.shadowTex);
    if (inst.shadowProg) gl.deleteProgram(inst.shadowProg);
    if (inst.shadowInstProg) gl.deleteProgram(inst.shadowInstProg);
    // 3D cleanup
    if (inst.prog3d) gl.deleteProgram(inst.prog3d);
    if (inst.prog3dBuf) gl.deleteBuffer(inst.prog3dBuf);
    if (inst.progInst) gl.deleteProgram(inst.progInst);
    if (inst.instanceBuf) gl.deleteBuffer(inst.instanceBuf);
    for (const { buf } of inst.geoVBOs.values()) gl.deleteBuffer(buf);
    if (inst.metricsEl) inst.metricsEl.remove();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    GlNode.instances.delete(selector);
  }

  // ── 3D program init ───────────────────────────────────────────────────

  // ── FBO helpers ────────────────────────────────────────────────────────

  // ── Texture helpers ─────────────────────────────────────────────────────

  private static createTexture(gl: WebGLRenderingContext, source: TexImageSource, linear = false): WebGLTexture | null {
    const tex = gl.createTexture();
    if (!tex) return null;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const filter = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }


  // ── Render loop ─────────────────────────────────────────────────────────

  private static dispatchOnFrame(inst: GlInstance, time: number, delta: number): void {
    if (!inst.onFrame || !inst.frameContext) return;

    inst.onFrameLatestTime = time;
    inst.onFrameLatestDelta = delta;

    if (inst.onFrameRunning) {
      inst.onFramePending = true;
      return;
    }

    const runLatest = (): void => {
      if (!inst.onFrame || !inst.frameContext) {
        inst.onFrameRunning = false;
        inst.onFramePending = false;
        return;
      }

      inst.onFrameRunning = true;
      const frameCtx = {
        ...inst.frameContext,
        glTime: inst.onFrameLatestTime,
        glDelta: inst.onFrameLatestDelta,
      };

      Promise.resolve(runSteps(inst.onFrame, frameCtx))
        .catch(err => console.error("[GL] Error in on-frame steps:", err))
        .finally(() => {
          if (inst.onFramePending) {
            inst.onFramePending = false;
            runLatest();
            return;
          }
          inst.onFrameRunning = false;
        });
    };

    runLatest();
  }

  static scheduleRender(inst: GlInstance): void {
    if (inst.rafId !== null) return;
    inst.rafId = requestAnimationFrame((time) => {
      inst.rafId = null;
      const delta = inst.lastTime ? (time - inst.lastTime) / 1000 : 0;
      inst.lastTime = time;

      // Update tweens (animations are ticked inline during render)
      GlNode.tickTweensAndDispatch(inst, delta);

      // Update trail positions (auto-remove if entity gone)
      if (updateTrails(inst)) inst.dirty = true;

      // Camera follow + shake
      if (updateCameraFollow(inst)) inst.dirty = true;
      if (updateCameraShake(inst.camera, delta)) {
        inst.dirty = true;
        GlNode.scheduleRender(inst);
      }

      // Transition tick
      if (inst.transition) {
        inst.transition.elapsed += delta;
        if (inst.transition.elapsed >= inst.transition.duration) {
          inst.transition = null;
        }
        inst.dirty = true;
        GlNode.scheduleRender(inst);
      }

      // Keep rendering while blur is active (in case scene changes underneath)
      if (inst.blur) {
        inst.dirty = true;
      }

      // Apply fixed-timestep interpolation for smooth rendering.
      // Skip interpolation for the camera-follow entity so camera and
      // rendered position use the same raw physics position (prevents jitter).
      const store = inst.store;
      const hasInterp = store.interpolationAlpha < 1;
      const followSlot = inst.camera.follow ? store.slot(inst.camera.follow) : -1;
      if (hasInterp) store.applyInterpolation(followSlot);

      const _rt0 = performance.now();
      if (inst.dirty) GlNode.render(inst, delta);
      const _rt1 = performance.now();

      if (hasInterp) store.restoreFromInterpolation();

      if (inst.onFrame && inst.frameContext) {
        GlNode.dispatchOnFrame(inst, time, delta);
        GlNode.scheduleRender(inst);
      }

      const _rt2 = performance.now();

      // Performance metrics
      if (inst.metrics && inst.metricsEl) {
        inst.metricsFrames++;
        inst.metricsTime += delta;
        if (inst.metricsTime >= 0.5) {
          inst.metricsFps = Math.round(inst.metricsFrames / inst.metricsTime);
          inst.metricsFrames = 0;
          inst.metricsTime = 0;
          inst.metricsEl.textContent =
            `FPS: ${inst.metricsFps}\n` +
            `Entities: ${inst.store.count}\n` +
            `Draw calls: ${inst.metricsDrawCalls}`;
        }
      }

      // Render perf trace
      _glPerfAccum.render += _rt1 - _rt0;
      _glPerfAccum.onFrame += _rt2 - _rt1;
      _glPerfAccum.frames++;
      if (_glDebug && time - _glPerfLastLog > 2000) {
        const n = _glPerfAccum.frames || 1;
        console.log(
          `[GL] ${n} frames/2s | render: ${(_glPerfAccum.render / n).toFixed(2)}ms | ` +
          `onFrame: ${(_glPerfAccum.onFrame / n).toFixed(2)}ms`
        );
        _glPerfAccum = { render: 0, onFrame: 0, frames: 0 };
        _glPerfLastLog = time;
      }
    });
  }

  private static tickTweensAndDispatch(inst: GlInstance, dt: number): void {
    const callbacks = tickTweens(inst, dt);
    if (callbacks) {
      for (const cb of callbacks) {
        Promise.resolve(runSteps(cb.then, cb.context))
          .catch(err => console.error("[GL] Error in tween steps:", err));
      }
    }
    if (inst.tweens.length > 0 || callbacks) GlNode.scheduleRender(inst);
  }

  private static render(inst: GlInstance, delta: number): void {
    const { gl, canvas, program, positionBuf, store, clearColor } = inst;
    inst.dirty = false;

    const cw = canvas.width, ch = canvas.height;
    const vw = store.virtualWidth || cw;
    const vh = store.virtualHeight || ch;

    const needsPost = inst.blur !== null || inst.transition !== null || inst.fxaa || inst.bloom !== null;
    if (needsPost && ensureFBOs(inst, GlNode.createProgram)) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, inst.fboA);
    }

    // Clear entire canvas (or FBO)
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(...clearColor);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Compute viewport based on fit mode
    let vpX = 0, vpY = 0, vpW = cw, vpH = ch;
    let scale = 1;
    if (store.virtualWidth) {
      if (inst.fit === "stretch") {
        scale = 1;
      } else {
        const sx = cw / vw, sy = ch / vh;
        scale = inst.fit === "cover" ? Math.max(sx, sy) : Math.min(sx, sy);
        vpW = Math.round(vw * scale);
        vpH = Math.round(vh * scale);
        vpX = Math.round((cw - vpW) / 2);
        vpY = Math.round((ch - vpH) / 2);
      }
    }

    inst.vpScale = scale;
    inst.vpOffsetX = vpX;
    inst.vpOffsetY = vpY;

    gl.viewport(vpX, ch - vpY - vpH, vpW, vpH);

    // Sort by z if needed — insertion sort for nearly-sorted (few Z changes), built-in otherwise
    if (store.zDirty) {
      const d = store.data;
      const ord = store.order;
      if (store.zDirtyCount < 10) {
        for (let i = 1; i < ord.length; i++) {
          const key = ord[i];
          const keyZ = d[key * STRIDE + F_Z];
          let j = i - 1;
          while (j >= 0 && d[ord[j] * STRIDE + F_Z] > keyZ) { ord[j + 1] = ord[j]; j--; }
          ord[j + 1] = key;
        }
      } else {
        ord.sort((a, b) => d[a * STRIDE + F_Z] - d[b * STRIDE + F_Z]);
      }
      store.zDirty = false;
      store.zDirtyCount = 0;
    }

    // Build camera matrix
    const cam = inst.camera;
    const totalRotation = cam.rotation + cam.shakeAngle;
    const cosR = Math.cos(-totalRotation * Math.PI / 180);
    const sinR = Math.sin(-totalRotation * Math.PI / 180);
    const z = cam.zoom || 1;

    // Projection: virtual coords → NDC, with camera transform
    // Camera: translate(-cam.x, -cam.y) then scale(zoom) around center
    const cx = vw / 2, cy = vh / 2;
    // Combined: projection * cameraCenter * zoom * rotate * cameraUncenter * translate
    // For simplicity, build as: T(cx,cy) * S(z) * R * T(-cx,-cy) * T(-camX,-camY) * projection
    // But we can fold it all into one mat3:
    const tx = -cam.x + cam.shakeX;
    const ty = -cam.y + cam.shakeY;
    // Step 1: translate by (-camX, -camY)
    // Step 2: translate by (-cx, -cy) to center
    // Step 3: scale by zoom, rotate
    // Step 4: translate back by (cx, cy)
    // Step 5: project to NDC
    // Combined offset after step 1+2: (tx - cx, ty - cy)
    const ox = tx - cx, oy = ty - cy;
    // After rotate+scale: (ox*cosR*z - oy*sinR*z, ox*sinR*z + oy*cosR*z)
    // After step 4: add (cx, cy)
    const fx = z * cosR * ox - z * sinR * oy + cx;
    const fy = z * sinR * ox + z * cosR * oy + cy;

    // P * V in column-major order
    // P = [2/vw, 0, -1; 0, -2/vh, 1; 0, 0, 1]
    // V = T(cx,cy) * S(z) * R * T(-cx-camX, -cy-camY)
    const projCam = _projCam9;
    projCam[0] = 2 * z * cosR / vw; projCam[1] = -2 * z * sinR / vh; projCam[2] = 0;
    projCam[3] = -2 * z * sinR / vw; projCam[4] = -2 * z * cosR / vh; projCam[5] = 0;
    projCam[6] = 2 * fx / vw - 1; projCam[7] = -2 * fy / vh + 1; projCam[8] = 1;

    // Base projection (no camera) for fixed/UI entities
    const projBase = _projBase9;
    projBase[0] = 2 / vw; projBase[1] = 0; projBase[2] = 0;
    projBase[3] = 0; projBase[4] = -2 / vh; projBase[5] = 0;
    projBase[6] = -1; projBase[7] = 1; projBase[8] = 1;

    const d = store.data;
    let drawCalls = 0;
    let currentTexture: WebGLTexture | null = null;

    // ── Cascaded shadow depth pass (before main 3D render) ─────────────────
    if (inst.mode3d && inst.shadow) {
      renderShadowPass(inst, needsPost, clearColor, cw, ch);
    }

    // ── SSAO depth + sampling + blur passes (before main 3D render) ──────
    if (inst.mode3d && inst.ssao) {
      renderSsaoPass(inst, cw, ch, needsPost, clearColor);
    }

    // ── 3D mode setup ───────────────────────────────────────────────────────
    const useInstancing = !!(inst.extInstanced && inst.progInst && inst.progInstLocs);
    const is3d = inst.mode3d && inst.prog3d && inst.prog3dLocs;
    if (is3d) {
      gl.enable(gl.DEPTH_TEST);
      const locs3d = inst.prog3dLocs!;
      gl.useProgram(inst.prog3d);
      const aspect = cw / ch;
      if (inst.ortho) {
        const halfH = cam.fov / 2;
        const halfW = halfH * aspect;
        mat4Ortho(-halfW, halfW, -halfH, halfH, cam.near, cam.far);
      } else {
        mat4Perspective(cam.fov, aspect, cam.near, cam.far);
      }
      gl.uniformMatrix4fv(locs3d.uProjection, false, _projM);
      gl.uniformMatrix4fv(locs3d.uView, false, mat4LookAt(
        [cam.x + cam.shakeX, cam.y + cam.shakeY, cam.z],
        cam.lookAt, cam.up,
      ));
      setSceneUniforms(gl, inst, locs3d, cam.x + cam.shakeX, cam.y + cam.shakeY, cam.z);

      // Set up instanced program uniforms (shared view/projection/light)
      if (useInstancing) {
        const il = inst.progInstLocs!;
        gl.useProgram(inst.progInst);
        gl.uniformMatrix4fv(il.uProjection, false, _projM);
        gl.uniformMatrix4fv(il.uView, false, _viewM);
        setSceneUniforms(gl, inst, il, cam.x + cam.shakeX, cam.y + cam.shakeY, cam.z);
        gl.useProgram(inst.prog3d); // restore for non-batchable entities
      }

      // ── Skybox atmospheric pass ────────────────────────────────────────────
      if (inst.skyTop && inst.skyBottom && inst.skyboxProg && inst.skyboxLocs && inst.skyboxBuf) {
        // Compute sun screen position: project a point far along -lightDir
        const ld = inst.lightDir;
        const ldLen = Math.sqrt(ld[0] * ld[0] + ld[1] * ld[1] + ld[2] * ld[2]) || 1;
        const sx = cam.x + cam.shakeX - ld[0] / ldLen * 1000;
        const sy = cam.y + cam.shakeY - ld[1] / ldLen * 1000;
        const sz = cam.z - ld[2] / ldLen * 1000;
        // Multiply by view matrix
        const v = _viewM;
        const vx = v[0] * sx + v[4] * sy + v[8] * sz + v[12];
        const vy = v[1] * sx + v[5] * sy + v[9] * sz + v[13];
        const vz = v[2] * sx + v[6] * sy + v[10] * sz + v[14];
        const vw = v[3] * sx + v[7] * sy + v[11] * sz + v[15];
        // Multiply by projection matrix
        const p = _projM;
        const cx2 = p[0] * vx + p[4] * vy + p[8] * vz + p[12] * vw;
        const cy2 = p[1] * vx + p[5] * vy + p[9] * vz + p[13] * vw;
        const cw2 = p[3] * vx + p[7] * vy + p[11] * vz + p[15] * vw;
        const sunNdcX = cw2 !== 0 ? cx2 / cw2 : 0;
        const sunNdcY = cw2 !== 0 ? cy2 / cw2 : 0;

        gl.depthMask(false);
        gl.disable(gl.DEPTH_TEST);
        const sl = inst.skyboxLocs;
        gl.useProgram(inst.skyboxProg);
        gl.uniform3fv(sl.uSkyTop, inst.skyTop);
        gl.uniform3fv(sl.uSkyBottom, inst.skyBottom);
        gl.uniform2f(sl.uSunPos, sunNdcX, sunNdcY);
        gl.uniform1f(sl.uAspect, cw / ch);
        gl.bindBuffer(gl.ARRAY_BUFFER, inst.skyboxBuf);
        gl.enableVertexAttribArray(sl.aPosition);
        gl.vertexAttribPointer(sl.aPosition, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.disableVertexAttribArray(sl.aPosition);
        drawCalls++;
        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
        gl.useProgram(inst.prog3d); // restore
      }
    }

    // ── 3D frustum culling ──────────────────────────────────────────────────
    // Extract 6 frustum planes from VP matrix (Gribb-Hartmann method)
    if (is3d) {
      const vp = mat4Multiply(_projM, _viewM);
      for (let i = 0; i < 6; i++) {
        const row = i >> 1; // 0,0,1,1,2,2
        const sign = (i & 1) ? -1 : 1;
        const a = vp[3] + sign * vp[row];
        const b = vp[7] + sign * vp[4 + row];
        const c = vp[11] + sign * vp[8 + row];
        const dd = vp[15] + sign * vp[12 + row];
        const len = Math.sqrt(a * a + b * b + c * c) || 1;
        _frustum[i * 4] = a / len;
        _frustum[i * 4 + 1] = b / len;
        _frustum[i * 4 + 2] = c / len;
        _frustum[i * 4 + 3] = dd / len;
      }
    }

    // ── Culling bounds (2D only) ────────────────────────────────────────────
    // Camera visible region in world coords (axis-aligned bounding box)
    const halfW = vw / (2 * z), halfH = vh / (2 * z);
    const camCX = cam.x + vw / 2, camCY = cam.y + vh / 2;
    const cullL = camCX - halfW, cullR = camCX + halfW;
    const cullT = camCY - halfH, cullB = camCY + halfH;
    // Fixed entities use virtual viewport bounds
    const fixedL = 0, fixedR = vw, fixedT = 0, fixedB = vh;

    // ── Batch state ──────────────────────────────────────────────────────────
    const batchLocs = inst.batchLocs;
    let bd = inst.batchData;

    // Grow batch buffer if needed (estimate 12 verts per entity, circles use more but are rare)
    const neededFloats = store.count * 12 * BATCH_STRIDE_FLOATS;
    if (neededFloats > bd.length) {
      inst.batchCap = neededFloats * 2;
      bd = inst.batchData = new Float32Array(inst.batchCap);
    }

    let batchOffset = 0;       // write position in floats
    let batchStart = 0;        // start vertex of current batch
    let batchTex: WebGLTexture | null = null;
    let batchProj: Float32Array = projCam;
    let batchTexName: string | null = null;
    let batchFixed = false;
    let batchBlend: string | undefined;
    let inBatch = false;
    let usingBatchProg = false;

    const applyBlendMode = (mode: string | undefined) => {
      switch (mode) {
        case "additive": gl.blendFunc(gl.SRC_ALPHA, gl.ONE); break;
        case "multiply": gl.blendFunc(gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA); break;
        case "screen": gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR); break;
        default: gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); break;
      }
    };

    // ── Helpers ──────────────────────────────────────────────────────────────

    const setupBatchAttribs = () => {
      gl.bindBuffer(gl.ARRAY_BUFFER, inst.batchBuf);
      gl.enableVertexAttribArray(batchLocs.aPosition);
      gl.vertexAttribPointer(batchLocs.aPosition, 2, gl.FLOAT, false, BATCH_STRIDE_BYTES, 0);
      gl.enableVertexAttribArray(batchLocs.aColor);
      gl.vertexAttribPointer(batchLocs.aColor, 4, gl.FLOAT, false, BATCH_STRIDE_BYTES, 8);
      gl.enableVertexAttribArray(batchLocs.aUv);
      gl.vertexAttribPointer(batchLocs.aUv, 2, gl.FLOAT, false, BATCH_STRIDE_BYTES, 24);
      gl.enableVertexAttribArray(batchLocs.aUseTex);
      gl.vertexAttribPointer(batchLocs.aUseTex, 1, gl.FLOAT, false, BATCH_STRIDE_BYTES, 32);
    };

    const disableBatchAttribs = () => {
      gl.disableVertexAttribArray(batchLocs.aColor);
      gl.disableVertexAttribArray(batchLocs.aUv);
      gl.disableVertexAttribArray(batchLocs.aUseTex);
    };

    const switchToBatchProg = () => {
      gl.useProgram(inst.batchProg);
      setupBatchAttribs();
      gl.uniform1i(batchLocs.uTexture, 0);
      usingBatchProg = true;
    };

    const switchToLegacyProg = () => {
      disableBatchAttribs();
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuf);
      gl.enableVertexAttribArray(inst.aPosition);
      gl.vertexAttribPointer(inst.aPosition, 2, gl.FLOAT, false, 0, 0);
      gl.uniform1i(inst.uTexture, 0);
      usingBatchProg = false;
    };

    const flushBatch = () => {
      if (!inBatch) return;
      const vertCount = (batchOffset / BATCH_STRIDE_FLOATS) - batchStart;
      if (vertCount === 0) { inBatch = false; return; }

      if (!usingBatchProg) switchToBatchProg();

      // Upload used portion
      gl.bindBuffer(gl.ARRAY_BUFFER, inst.batchBuf);
      gl.bufferData(gl.ARRAY_BUFFER, bd.subarray(0, batchOffset), gl.DYNAMIC_DRAW);
      setupBatchAttribs();

      gl.uniformMatrix3fv(batchLocs.uProjection, false, batchProj);

      // Bind texture
      if (batchTex) {
        if (currentTexture !== batchTex) {
          currentTexture = bindTex(gl, batchTex, currentTexture);
        }
      }

      applyBlendMode(batchBlend);
      gl.drawArrays(gl.TRIANGLES, 0, vertCount);
      drawCalls++;
      if (batchBlend) applyBlendMode(undefined); // restore normal

      batchOffset = 0;
      batchStart = 0;
      inBatch = false;
    };

    const drawSingleEntity = (slot: number) => {
      if (usingBatchProg) switchToLegacyProg();

      const b = slot * STRIDE;
      const meta = store.meta[slot];
      if (!meta) return;
      const isFixed = !!(d[b + F_FLAGS] & FLAG_FIXED);
      const activeProj = isFixed ? projBase : projCam;

      // Handle custom shader or default program
      let currentProg = program;
      if (meta.shader) {
        const shaderInfo = inst.shaders.get(meta.shader);
        if (shaderInfo) {
          currentProg = shaderInfo.program;
          gl.useProgram(currentProg);
          if (shaderInfo.uniforms.u_projection) gl.uniformMatrix3fv(shaderInfo.uniforms.u_projection, false, activeProj);
          if (shaderInfo.uniforms.u_time) gl.uniform1f(shaderInfo.uniforms.u_time, inst.lastTime / 1000);
          if (shaderInfo.uniforms.u_resolution) gl.uniform2f(shaderInfo.uniforms.u_resolution, vw, vh);
          if (shaderInfo.uniforms.u_texture) gl.uniform1i(shaderInfo.uniforms.u_texture, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, positionBuf);
          const aPos = gl.getAttribLocation(currentProg, "a_position");
          gl.enableVertexAttribArray(aPos);
          gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
        }
      } else {
        gl.uniformMatrix3fv(inst.uProjection, false, activeProj);
      }

      // Geometry
      const verts = meta.vertices
        ? new Float32Array(meta.vertices)
        : meta.type === "triangle" ? TRI_VERTS
          : meta.type === "circle" ? CIRCLE_VERTS
            : QUAD_VERTS;
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);

      // Color
      const colorLoc = meta.shader
        ? (inst.shaders.get(meta.shader)?.uniforms.u_color ?? inst.uColor)
        : inst.uColor;
      const opacity = d[b + F_OPACITY];
      _color4[0] = d[b + F_CR]; _color4[1] = d[b + F_CG]; _color4[2] = d[b + F_CB]; _color4[3] = d[b + F_CA] * opacity;
      gl.uniform4fv(colorLoc, _color4);

      // UV rect
      const uvLoc = meta.shader
        ? (inst.shaders.get(meta.shader)?.uniforms.u_uvRect ?? inst.uUvRect)
        : inst.uUvRect;
      _uv4[0] = d[b + F_U]; _uv4[1] = d[b + F_V]; _uv4[2] = d[b + F_UW]; _uv4[3] = d[b + F_UH];
      gl.uniform4fv(uvLoc, _uv4);

      // Texture
      const texInfo = meta.textureName ? inst.textures.get(meta.textureName) : null;
      const useTexLoc = meta.shader
        ? (inst.shaders.get(meta.shader)?.uniforms.u_useTexture ?? inst.uUseTexture)
        : inst.uUseTexture;
      if (texInfo) {
        if (currentTexture !== texInfo.tex) {
          currentTexture = bindTex(gl, texInfo.tex, currentTexture);
        }
        gl.uniform1i(useTexLoc, 1);
      } else {
        gl.uniform1i(useTexLoc, 0);
      }

      // Transform (with parent chain if parented)
      const transformLoc = meta.shader
        ? (inst.shaders.get(meta.shader)?.uniforms.u_transform ?? inst.uTransform)
        : inst.uTransform;
      const wt = meta.parent ? store.getWorldTransform(slot) : null;
      const rad = ((wt ? wt[2] : d[b + F_ANGLE]) * Math.PI) / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      const ew = d[b + F_W], eh = d[b + F_H];
      _xform9[0] = ew * cos; _xform9[1] = ew * sin; _xform9[2] = 0;
      _xform9[3] = -eh * sin; _xform9[4] = eh * cos; _xform9[5] = 0;
      _xform9[6] = wt ? wt[0] : d[b + F_X]; _xform9[7] = wt ? wt[1] : d[b + F_Y]; _xform9[8] = 1;
      gl.uniformMatrix3fv(transformLoc, false, _xform9);

      // Line width
      if ((meta.type === "line" || meta.type === "line-strip") && meta.lineWidth) {
        gl.lineWidth(meta.lineWidth);
      }

      const mode = meta.type === "points" ? gl.POINTS
        : meta.type === "circle" ? gl.TRIANGLE_FAN
          : meta.type === "line" ? gl.LINES
            : meta.type === "line-strip" ? gl.LINE_STRIP
              : gl.TRIANGLES;
      applyBlendMode(meta.blend);
      gl.drawArrays(mode, 0, verts.length / 2);
      drawCalls++;
      if (meta.blend) applyBlendMode(undefined); // restore normal

      // Restore legacy program state if we used a custom shader
      if (meta.shader) {
        gl.useProgram(program);
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuf);
        gl.enableVertexAttribArray(inst.aPosition);
        gl.vertexAttribPointer(inst.aPosition, 2, gl.FLOAT, false, 0, 0);
      }
    };

    // ── 3D batch state ────────────────────────────────────────────────────────
    let b3dOffset = 0;
    let b3dTex: WebGLTexture | null = null;
    let b3dTexName: string | null = null;
    let b3dBlend: string | undefined;
    let b3dNormalTex: WebGLTexture | null = null;
    let b3dNormalName: string | null = null;
    let b3dNormalScale = 1.0;
    let in3dBatch = false;

    // Instanced batch state
    let instOffset = 0;        // write position in instance data (floats)
    let instGeo: Float32Array | null = null;  // current geometry for instanced batch
    let instCount = 0;         // instances in current batch

    if (is3d) {
      if (useInstancing) {
        // Instance buffer: INST_STRIDE floats per entity
        const neededInst = store.count * INST_STRIDE;
        if (neededInst > inst.instanceCap) {
          inst.instanceCap = neededInst * 2;
          inst.instanceData = new Float32Array(inst.instanceCap);
        }
      } else {
        // Grow persistent buffer if needed (worst case: 120 verts/entity for circles)
        const needed3d = store.count * 120 * STRIDE_3D;
        if (needed3d > inst.batch3dCap) {
          inst.batch3dCap = needed3d * 2;
          inst.batch3dData = new Float32Array(inst.batch3dCap);
        }
      }
    }
    const bd3d = inst.batch3dData;
    const instData = inst.instanceData;

    const setup3dAttribs = () => {
      const locs3d = inst.prog3dLocs!;
      gl.enableVertexAttribArray(locs3d.aPosition);
      gl.vertexAttribPointer(locs3d.aPosition, 3, gl.FLOAT, false, STRIDE_3D_BYTES, 0);
      gl.enableVertexAttribArray(locs3d.aNormal);
      gl.vertexAttribPointer(locs3d.aNormal, 3, gl.FLOAT, false, STRIDE_3D_BYTES, 12);
      gl.enableVertexAttribArray(locs3d.aColor);
      gl.vertexAttribPointer(locs3d.aColor, 4, gl.FLOAT, false, STRIDE_3D_BYTES, 24);
      gl.enableVertexAttribArray(locs3d.aUv);
      gl.vertexAttribPointer(locs3d.aUv, 2, gl.FLOAT, false, STRIDE_3D_BYTES, 40);
      gl.enableVertexAttribArray(locs3d.aUseTex);
      gl.vertexAttribPointer(locs3d.aUseTex, 1, gl.FLOAT, false, STRIDE_3D_BYTES, 48);
    };

    const flushInstanced = () => {
      if (instCount === 0 || !instGeo) return;
      const ext = inst.extInstanced!;
      const il = inst.progInstLocs!;
      gl.useProgram(inst.progInst);

      // Bind static geometry VBO (lazy-create for rounded shapes)
      let geoInfo = inst.geoVBOs.get(instGeo);
      if (!geoInfo) {
        const buf = gl.createBuffer()!;
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, instGeo, gl.STATIC_DRAW);
        geoInfo = { buf, vertCount: instGeo.length / 6 };
        inst.geoVBOs.set(instGeo, geoInfo);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, geoInfo.buf);
      gl.enableVertexAttribArray(il.aPosition);
      gl.vertexAttribPointer(il.aPosition, 3, gl.FLOAT, false, GEO_STRIDE_BYTES, 0);
      gl.enableVertexAttribArray(il.aNormal);
      gl.vertexAttribPointer(il.aNormal, 3, gl.FLOAT, false, GEO_STRIDE_BYTES, 12);

      // Upload instance data
      gl.bindBuffer(gl.ARRAY_BUFFER, inst.instanceBuf);
      gl.bufferData(gl.ARRAY_BUFFER, instData.subarray(0, instOffset), gl.DYNAMIC_DRAW);

      // Set up per-instance attributes (divisor = 1)
      const attrs = [il.aModel0, il.aModel1, il.aModel2, il.aModel3, il.aColor, il.aUvRect, il.aExtra];
      for (let i = 0; i < 7; i++) {
        gl.enableVertexAttribArray(attrs[i]);
        gl.vertexAttribPointer(attrs[i], 4, gl.FLOAT, false, INST_STRIDE_BYTES, i * 16);
        ext.vertexAttribDivisorANGLE(attrs[i], 1);
      }

      // Texture
      if (b3dTex) currentTexture = bindTex(gl, b3dTex, currentTexture);
      // Normal map
      if (b3dNormalTex) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, b3dNormalTex);
        gl.uniform1f(il.uNormalMapEnabled, 1.0);
        gl.uniform1f(il.uNormalScale, b3dNormalScale);
        gl.activeTexture(gl.TEXTURE0);
      } else {
        gl.uniform1f(il.uNormalMapEnabled, 0.0);
      }
      applyBlendMode(b3dBlend);
      ext.drawArraysInstancedANGLE(gl.TRIANGLES, 0, geoInfo.vertCount, instCount);
      drawCalls++;
      if (b3dBlend) applyBlendMode(undefined);

      // Reset divisors
      for (const a of attrs) ext.vertexAttribDivisorANGLE(a, 0);

      instOffset = 0;
      instCount = 0;
      instGeo = null;
      in3dBatch = false;
    };

    // Flush pre-transformed 3D vertices from a given buffer
    const flushPreTransformed = (buf: Float32Array) => {
      if (b3dOffset === 0) { in3dBatch = false; return; }
      if (b3dOffset > b3dPeakOffset) b3dPeakOffset = b3dOffset;
      gl.useProgram(inst.prog3d);
      gl.bindBuffer(gl.ARRAY_BUFFER, inst.prog3dBuf);
      gl.bufferData(gl.ARRAY_BUFFER, buf.subarray(0, b3dOffset), gl.DYNAMIC_DRAW);
      setup3dAttribs();
      if (b3dTex) currentTexture = bindTex(gl, b3dTex, currentTexture);
      // Normal map
      if (b3dNormalTex) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, b3dNormalTex);
        gl.uniform1f(inst.prog3dLocs!.uNormalMapEnabled, 1.0);
        gl.uniform1f(inst.prog3dLocs!.uNormalScale, b3dNormalScale);
        gl.activeTexture(gl.TEXTURE0);
      } else {
        gl.uniform1f(inst.prog3dLocs!.uNormalMapEnabled, 0.0);
      }
      gl.uniformMatrix4fv(inst.prog3dLocs!.uModel, false, MAT4_IDENTITY);
      gl.uniform1f(inst.prog3dLocs!.uEmissive, 0);
      applyBlendMode(b3dBlend);
      gl.drawArrays(gl.TRIANGLES, 0, b3dOffset / STRIDE_3D);
      drawCalls++;
      if (b3dBlend) applyBlendMode(undefined);
      b3dOffset = 0;
      in3dBatch = false;
    };

    const flush3dBatch = () => {
      if (useInstancing) { flushInstanced(); return; }
      if (!in3dBatch || b3dOffset === 0) { in3dBatch = false; return; }
      flushPreTransformed(bd3d);
    };

    // ── Transparent 3D entity queue (rendered in second pass with depth write off) ──
    let transparent3d: number[] | null = null;
    let b3dPeakOffset = 0; // track peak 3D buffer usage for shrink logic

    // ── Collect point/spot lights from cached light slot list ──────────────
    if (is3d) {
      collectPointLights(inst, store);
      gl.useProgram(inst.prog3d);
      uploadPointLights(gl, inst, inst.prog3dLocs!);
      if (useInstancing) {
        gl.useProgram(inst.progInst);
        uploadPointLights(gl, inst, inst.progInstLocs!);
        gl.useProgram(inst.prog3d);
      }
    }

    // ── Tilemap rendering (before entities, typically z < 0) ─────────────────
    if (!is3d && inst.tilemaps.size > 0) {
      if (!usingBatchProg) switchToBatchProg();
      for (const tm of inst.tilemaps.values()) {
        if (tm.vertCount === 0) continue;
        const texInfo = inst.textures.get(tm.textureName);
        if (texInfo) currentTexture = bindTex(gl, texInfo.tex, currentTexture);
        gl.uniformMatrix3fv(batchLocs.uProjection, false, projCam);
        gl.bindBuffer(gl.ARRAY_BUFFER, tm.vbo);
        setupBatchAttribs();
        gl.drawArrays(gl.TRIANGLES, 0, tm.vertCount);
        drawCalls++;
      }
      // Restore batch buffer binding for entity batching
      gl.bindBuffer(gl.ARRAY_BUFFER, inst.batchBuf);
      setupBatchAttribs();
    }

    // ── Trail rendering ─────────────────────────────────────────────────────
    if (!is3d && inst.trails.size > 0) {
      drawCalls += renderTrails(inst, projCam);
      usingBatchProg = true;
    }

    // ── Main pass over store.order ───────────────────────────────────────────

    for (const slot of store.order) {
      const b = slot * STRIDE;
      if (!(d[b + F_FLAGS] & FLAG_VISIBLE)) continue;
      const meta_ = store.meta[slot];
      if (meta_?.type === "pivot") continue;

      const ex = d[b + F_X], ey = d[b + F_Y], ew = d[b + F_W], eh = d[b + F_H];
      const isFixed = !!(d[b + F_FLAGS] & FLAG_FIXED);
      let cullX = ex, cullY = ey, cullZ = d[b + F_Z];
      if (meta_?.parent) {
        const wt = store.getWorldTransform(slot);
        cullX = wt[0]; cullY = wt[1]; cullZ = wt[3];
      }

      // Frustum cull
      if (is3d) {
        const w3 = Math.abs(ew);
        const h3 = Math.abs(eh);
        const d3 = Math.max(Math.abs(d[b + F_D]), 0.01);
        // Conservative sphere around entity origin.
        // This avoids false culls for rotated/parented entities where
        // the local [0..1] center offset rotates in world space.
        const cx3 = cullX, cy3 = cullY, cz3 = cullZ;
        const radius = Math.sqrt(w3 * w3 + h3 * h3 + d3 * d3);
        let culled = false;
        for (let pi = 0; pi < 6; pi++) {
          const dist = _frustum[pi * 4] * cx3 + _frustum[pi * 4 + 1] * cy3 + _frustum[pi * 4 + 2] * cz3 + _frustum[pi * 4 + 3];
          if (dist < -radius) { culled = true; break; }
        }
        if (culled) continue;
      } else {
        if (isFixed) {
          if (cullX + ew < fixedL || cullX > fixedR || cullY + eh < fixedT || cullY > fixedB) continue;
        } else {
          if (cullX + ew < cullL || cullX > cullR || cullY + eh < cullT || cullY > cullB) continue;
        }
      }

      const meta = store.meta[slot];
      if (!meta) continue;

      // Light entities are data-only, not rendered as geometry
      if (meta.type === "light") continue;

      // Tick animation inline
      if (meta.anim) {
        const anim = meta.anim;
        if (anim.frames.length > 0) {
          anim.elapsed += delta;
          const frameDur = 1 / anim.fps;
          if (anim.elapsed >= frameDur) {
            anim.elapsed -= frameDur;
            anim.current++;
            if (anim.current >= anim.frames.length) {
              if (anim.loop) anim.current = 0;
              else { anim.current = anim.frames.length - 1; meta.anim = undefined; }
            }
            if (meta.anim) {
              const f = anim.frames[anim.current];
              d[b + F_U] = f[0]; d[b + F_V] = f[1];
              d[b + F_UW] = f[2]; d[b + F_UH] = f[3];
            }
          }
        }
      }

      // Re-render text texture if dirty, then clear all dirty bits
      if (meta.dirty & DIRTY_TEXT) {
        renderTextTexture(inst, meta.id, meta, GlNode.createTexture);
        const texInfo = inst.textures.get(meta.textureName!);
        if (texInfo) {
          d[b + F_W] = texInfo.w;
          d[b + F_H] = texInfo.h;
        }
      }
      meta.dirty = 0;

      // ── 3D path ─────────────────────────────────────────────────────────────
      if (is3d && bd3d) {
        // Defer transparent entities to second pass (depth write off)
        const opacity = d[b + F_OPACITY];
        const ca = d[b + F_CA] * opacity;
        if (ca < 1.0) {
          if (!transparent3d) transparent3d = [];
          transparent3d.push(slot);
          continue;
        }

        const texInfo = meta.textureName ? inst.textures.get(meta.textureName) : null;
        const entityTex = texInfo?.tex ?? null;
        const entityTexName = texInfo ? meta.textureName! : null;
        // Normal map
        const nmInfo = meta.normalMap ? inst.textures.get(meta.normalMap) : null;
        const entityNormalTex = nmInfo?.tex ?? null;
        const entityNormalName = nmInfo ? meta.normalMap! : null;
        const entityNormalScale = meta.normalScale ?? 1.0;
        const cr = d[b + F_CR], cg = d[b + F_CG], cb = d[b + F_CB];
        const u = d[b + F_U], v = d[b + F_V], uW = d[b + F_UW], uH = d[b + F_UH];
        const useTex = texInfo ? 1.0 : 0.0;
        const emissiveF = meta.emissive ? 1.0 : 0.0;
        const ez = d[b + F_Z], ed = d[b + F_D] || 0.01;
        const erx = d[b + F_RX], ery = d[b + F_RY], erz = d[b + F_ANGLE];
        // Apply parent world transform for 3D
        let mx = ex, my = ey, mz = ez, mrx = erx, mry = ery, mrz = erz;
        if (meta.parent) {
          const wt = store.getWorldTransform(slot);
          mx = wt[0]; my = wt[1]; mrz = wt[2]; mz = wt[3];
          mrx = wt[4]; mry = wt[5];
        }
        const model = meta.billboard
          ? mat4Billboard(mx, my, mz, ew, eh, ed, cam.x + cam.shakeX, cam.y + cam.shakeY, cam.z)
          : mat4Model(mx, my, mz, ew, eh, ed, mrx, mry, mrz);

        // Non-batchable 3D entities: lines, line-strips, points, custom vertices, custom shaders
        if (meta.type === "line" || meta.type === "line-strip" || meta.type === "points" || meta.vertices || meta.shader) {
          flush3dBatch();
          const locs3d = inst.prog3dLocs!;
          // Use custom shader if set, otherwise default 3D program
          const shaderInfo = meta.shader ? inst.shaders.get(meta.shader) : null;
          if (shaderInfo) {
            gl.useProgram(shaderInfo.program);
            // Set 3D uniforms on custom shader (if present in the shader)
            if (shaderInfo.uniforms.u_projection) gl.uniformMatrix4fv(shaderInfo.uniforms.u_projection, false, _projM);
            if (shaderInfo.uniforms.u_view) gl.uniformMatrix4fv(shaderInfo.uniforms.u_view, false, _viewM);
            if (shaderInfo.uniforms.u_model) gl.uniformMatrix4fv(shaderInfo.uniforms.u_model, false, model);
            if (shaderInfo.uniforms.u_lightDir) gl.uniform3fv(shaderInfo.uniforms.u_lightDir, inst.lightDir);
            if (shaderInfo.uniforms.u_ambient) gl.uniform1f(shaderInfo.uniforms.u_ambient, inst.ambient);
            if (shaderInfo.uniforms.u_color) { _color4[0] = cr; _color4[1] = cg; _color4[2] = cb; _color4[3] = ca; gl.uniform4fv(shaderInfo.uniforms.u_color, _color4); }
            if (shaderInfo.uniforms.u_time) gl.uniform1f(shaderInfo.uniforms.u_time, inst.lastTime / 1000);
            if (shaderInfo.uniforms.u_resolution) gl.uniform2f(shaderInfo.uniforms.u_resolution, vw, vh);
            if (shaderInfo.uniforms.u_texture) gl.uniform1i(shaderInfo.uniforms.u_texture, 0);
          } else {
            gl.useProgram(inst.prog3d);
            gl.uniformMatrix4fv(locs3d.uModel, false, model);
            gl.uniform1f(locs3d.uEmissive, meta.emissive ? 1.0 : 0.0);
            // Normal map for single-entity draw
            if (entityNormalTex) {
              gl.activeTexture(gl.TEXTURE2);
              gl.bindTexture(gl.TEXTURE_2D, entityNormalTex);
              gl.uniform1f(locs3d.uNormalMapEnabled, 1.0);
              gl.uniform1f(locs3d.uNormalScale, entityNormalScale);
              gl.activeTexture(gl.TEXTURE0);
            } else {
              gl.uniform1f(locs3d.uNormalMapEnabled, 0.0);
            }
          }
          // Upload vertex data: custom vertices or unit geometry
          const verts = meta.vertices
            ? new Float32Array(meta.vertices)
            : meta.type === "circle" ? CIRCLE_VERTS : QUAD_VERTS;
          const vertCount = verts.length / 2;
          // Build per-vertex data with pos3+normal3+color4+uv2+useTex1
          const neededSingle = vertCount * STRIDE_3D;
          if (neededSingle > _singleBuf.length) _singleBuf = new Float32Array(neededSingle * 2);
          const singleBuf = _singleBuf;
          for (let i = 0; i < vertCount; i++) {
            const off = i * STRIDE_3D;
            singleBuf[off] = verts[i * 2];      // x (local)
            singleBuf[off + 1] = verts[i * 2 + 1];  // y (local)
            singleBuf[off + 2] = 0;                  // z (local)
            singleBuf[off + 3] = 0;                  // normal x
            singleBuf[off + 4] = 0;                  // normal y
            singleBuf[off + 5] = 1;                  // normal z
            singleBuf[off + 6] = cr; singleBuf[off + 7] = cg;
            singleBuf[off + 8] = cb; singleBuf[off + 9] = ca;
            singleBuf[off + 10] = u + verts[i * 2] * uW;
            singleBuf[off + 11] = v + verts[i * 2 + 1] * uH;
            singleBuf[off + 12] = useTex;
          }
          gl.bindBuffer(gl.ARRAY_BUFFER, inst.prog3dBuf);
          gl.bufferData(gl.ARRAY_BUFFER, singleBuf.subarray(0, neededSingle), gl.DYNAMIC_DRAW);
          setup3dAttribs();
          if (entityTex) currentTexture = bindTex(gl, entityTex, currentTexture);
          if ((meta.type === "line" || meta.type === "line-strip") && meta.lineWidth) {
            gl.lineWidth(meta.lineWidth);
          }
          const glMode = meta.type === "points" ? gl.POINTS
            : meta.type === "line" ? gl.LINES
              : meta.type === "line-strip" ? gl.LINE_STRIP
                : meta.type === "circle" ? gl.TRIANGLE_FAN
                  : gl.TRIANGLES;
          applyBlendMode(meta.blend);
          gl.drawArrays(glMode, 0, vertCount);
          drawCalls++;
          if (meta.blend) applyBlendMode(undefined);
          // Restore 3D program if we used a custom shader
          if (shaderInfo) {
            gl.useProgram(inst.prog3d);
          }
          continue;
        }

        // Choose geometry source: rounded cube if borderRadius, else 3D/flat shape
        const srcVerts = meta.borderRadius && meta.borderRadius > 0 && d[b + F_D] > 0
          ? getRoundedCubeVerts(meta.borderRadius)
          : d[b + F_D] > 0
            ? (SHAPE_3D[meta.type || "quad"] || CUBE_VERTS)
            : (SHAPE_FLAT[meta.type || "quad"] || FLAT_QUAD_VERTS);

        if (useInstancing) {
          // ── Instanced path: 28 floats per entity ──────────────────────────
          const texChanged = entityTex && entityTexName !== b3dTexName;
          const nmChanged = entityNormalName !== b3dNormalName;
          if (in3dBatch && (texChanged || nmChanged || meta.blend !== b3dBlend || srcVerts !== instGeo)) {
            flushInstanced();
          }
          if (!in3dBatch) {
            in3dBatch = true;
            b3dTex = entityTex;
            b3dTexName = entityTexName;
            b3dBlend = meta.blend;
            b3dNormalTex = entityNormalTex;
            b3dNormalName = entityNormalName;
            b3dNormalScale = entityNormalScale;
            instGeo = srcVerts;
          }
          // Inverse squared scale for normal matrix in shader: 1/w², 1/h², 1/d²
          const invSqW = ew ? 1 / (ew * ew) : 1, invSqH = eh ? 1 / (eh * eh) : 1, invSqD = ed ? 1 / (ed * ed) : 1;
          // model matrix (column-major, 16 floats)
          instData[instOffset++] = model[0]; instData[instOffset++] = model[1];
          instData[instOffset++] = model[2]; instData[instOffset++] = model[3];
          instData[instOffset++] = model[4]; instData[instOffset++] = model[5];
          instData[instOffset++] = model[6]; instData[instOffset++] = model[7];
          instData[instOffset++] = model[8]; instData[instOffset++] = model[9];
          instData[instOffset++] = model[10]; instData[instOffset++] = model[11];
          instData[instOffset++] = model[12]; instData[instOffset++] = model[13];
          instData[instOffset++] = model[14]; instData[instOffset++] = model[15];
          // color (4 floats)
          instData[instOffset++] = cr; instData[instOffset++] = cg;
          instData[instOffset++] = cb; instData[instOffset++] = ca;
          // uvRect (4 floats)
          instData[instOffset++] = u; instData[instOffset++] = v;
          instData[instOffset++] = uW; instData[instOffset++] = uH;
          // extra (4 floats): invScale² for normal matrix + packed(useTex + emissive*2)
          instData[instOffset++] = invSqW; instData[instOffset++] = invSqH;
          instData[instOffset++] = invSqD; instData[instOffset++] = useTex + emissiveF * 2.0;
          instCount++;
        } else {
          // ── Fallback: pre-transform vertices on CPU ───────────────────────
          const texChanged = entityTex && entityTexName !== b3dTexName;
          const nmChanged = entityNormalName !== b3dNormalName;
          if (in3dBatch && (texChanged || nmChanged || meta.blend !== b3dBlend)) {
            flush3dBatch();
          }
          if (!in3dBatch) {
            in3dBatch = true;
            b3dTex = entityTex;
            b3dTexName = entityTexName;
            b3dBlend = meta.blend;
            b3dNormalTex = entityNormalTex;
            b3dNormalName = entityNormalName;
            b3dNormalScale = entityNormalScale;
          }
          b3dOffset = writePreTransformed(srcVerts, model, cr, cg, cb, ca, u, v, uW, uH, useTex, bd3d, b3dOffset);
        }
        continue;
      }

      // ── 2D path (existing) ─────────────────────────────────────────────────

      // Can this entity be batched?
      const isBatchable = !meta.shader && !meta.vertices
        && (meta.type === "quad" || meta.type === "triangle" || meta.type === "circle"
          || meta.type === "sphere" || meta.type === "cylinder" || meta.type === "cone" || meta.type === "ramp" || !meta.type);

      if (!isBatchable) {
        flushBatch();
        drawSingleEntity(slot);
        continue;
      }

      // Determine batch key
      const texInfo = meta.textureName ? inst.textures.get(meta.textureName) : null;
      const entityTex = texInfo?.tex ?? null;
      const entityTexName = texInfo ? meta.textureName! : null;

      // Break batch if key changed
      const texChanged = entityTex && entityTexName !== batchTexName;
      if (inBatch && (isFixed !== batchFixed || texChanged || meta.blend !== batchBlend)) {
        flushBatch();
      }

      if (!inBatch) {
        inBatch = true;
        batchProj = isFixed ? projBase : projCam;
        batchTex = entityTex;
        batchTexName = entityTexName;
        batchFixed = isFixed;
        batchBlend = meta.blend;
        batchStart = batchOffset / BATCH_STRIDE_FLOATS;
      }

      // Pre-transform vertices into batchData
      const baseVerts = meta.type === "circle" ? CIRCLE_TRI_VERTS
        : meta.type === "triangle" ? TRI_VERTS : QUAD_VERTS;
      const vertCount = baseVerts.length / 2;

      // Grow buffer if needed (circles have 120 verts, initial estimate may be too small)
      const vertsNeeded = batchOffset + vertCount * BATCH_STRIDE_FLOATS;
      if (vertsNeeded > bd.length) {
        inst.batchCap = vertsNeeded * 2;
        const newBd = new Float32Array(inst.batchCap);
        newBd.set(bd.subarray(0, batchOffset));
        bd = inst.batchData = newBd;
      }

      const wt = meta.parent ? store.getWorldTransform(slot) : null;
      const x = wt ? wt[0] : d[b + F_X], y = wt ? wt[1] : d[b + F_Y];
      const w = d[b + F_W], h = d[b + F_H];
      const rad = ((wt ? wt[2] : d[b + F_ANGLE]) * Math.PI) / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      const opacity = d[b + F_OPACITY];
      const cr = d[b + F_CR], cg = d[b + F_CG], cb = d[b + F_CB], ca = d[b + F_CA] * opacity;
      const u = d[b + F_U], v = d[b + F_V], uW = d[b + F_UW], uH = d[b + F_UH];
      const useTex = texInfo ? 1.0 : 0.0;

      for (let i = 0; i < vertCount; i++) {
        const bx = baseVerts[i * 2], by = baseVerts[i * 2 + 1];
        bd[batchOffset++] = x + bx * w * cos - by * h * sin;  // world x
        bd[batchOffset++] = y + bx * w * sin + by * h * cos;  // world y
        bd[batchOffset++] = cr;
        bd[batchOffset++] = cg;
        bd[batchOffset++] = cb;
        bd[batchOffset++] = ca;
        bd[batchOffset++] = u + bx * uW;  // uv x
        bd[batchOffset++] = v + by * uH;  // uv y
        bd[batchOffset++] = useTex;
      }
    }

    // Flush remaining batches
    flushBatch();
    flush3dBatch();

    // ── Transparent 3D pass (depth write off, depth test on, back-to-front) ──
    // Always uses pre-transform path (not instanced) to preserve z-order
    if (transparent3d && is3d) {
      gl.depthMask(false);  // don't write to depth buffer

      // Ensure pre-transform buffer is available (may not have been allocated if instancing took over)
      const tNeeded = transparent3d.length * 120 * STRIDE_3D;
      if (tNeeded > inst.batch3dCap) {
        inst.batch3dCap = tNeeded * 2;
        inst.batch3dData = new Float32Array(inst.batch3dCap);
      }
      const tBd3d = inst.batch3dData;

      for (const slot of transparent3d) {
        const b = slot * STRIDE;
        const meta = store.meta[slot]!;
        const ex = d[b + F_X], ey = d[b + F_Y], ew = d[b + F_W], eh = d[b + F_H];
        const texInfo = meta.textureName ? inst.textures.get(meta.textureName) : null;
        const entityTex = texInfo?.tex ?? null;
        const entityTexName = texInfo ? meta.textureName! : null;
        const nmInfo = meta.normalMap ? inst.textures.get(meta.normalMap) : null;
        const entityNormalTex = nmInfo?.tex ?? null;
        const entityNormalName = nmInfo ? meta.normalMap! : null;
        const entityNormalScale = meta.normalScale ?? 1.0;
        const opacity = d[b + F_OPACITY];
        const cr = d[b + F_CR], cg = d[b + F_CG], cb = d[b + F_CB], ca = d[b + F_CA] * opacity;
        const u = d[b + F_U], v = d[b + F_V], uW = d[b + F_UW], uH = d[b + F_UH];
        const useTex = texInfo ? 1.0 : 0.0;
        const ez = d[b + F_Z], ed = d[b + F_D] || 0.01;
        const erx = d[b + F_RX], ery = d[b + F_RY], erz = d[b + F_ANGLE];
        let tmx = ex, tmy = ey, tmz = ez, tmrx = erx, tmry = ery, tmrz = erz;
        if (meta.parent) {
          const wt = store.getWorldTransform(slot);
          tmx = wt[0]; tmy = wt[1]; tmrz = wt[2]; tmz = wt[3];
          tmrx = wt[4]; tmry = wt[5];
        }
        const model = meta.billboard
          ? mat4Billboard(tmx, tmy, tmz, ew, eh, ed, cam.x + cam.shakeX, cam.y + cam.shakeY, cam.z)
          : mat4Model(tmx, tmy, tmz, ew, eh, ed, tmrx, tmry, tmrz);

        const texChanged = entityTex && entityTexName !== b3dTexName;
        const nmChanged = entityNormalName !== b3dNormalName;
        if (in3dBatch && (texChanged || nmChanged || meta.blend !== b3dBlend)) {
          flushPreTransformed(tBd3d);
        }
        if (!in3dBatch) {
          in3dBatch = true;
          b3dTex = entityTex;
          b3dTexName = entityTexName;
          b3dBlend = meta.blend;
          b3dNormalTex = entityNormalTex;
          b3dNormalName = entityNormalName;
          b3dNormalScale = entityNormalScale;
        }

        const srcVerts = meta.borderRadius && meta.borderRadius > 0 && d[b + F_D] > 0
          ? getRoundedCubeVerts(meta.borderRadius)
          : d[b + F_D] > 0
            ? (SHAPE_3D[meta.type || "quad"] || CUBE_VERTS)
            : (SHAPE_FLAT[meta.type || "quad"] || FLAT_QUAD_VERTS);
        b3dOffset = writePreTransformed(srcVerts, model, cr, cg, cb, ca, u, v, uW, uH, useTex, tBd3d, b3dOffset);
      }
      flushPreTransformed(inst.batch3dData);
      gl.depthMask(true);  // restore depth write
    }

    // ── GPU Particles (instanced, stateless) ────────────────────────────────
    if (is3d) {
      drawCalls += renderGpuParticles(inst, gl, cam.x + cam.shakeX, cam.y + cam.shakeY, cam.z, delta);
      if (hasActiveParticles(inst)) {
        inst.dirty = true;
        GlNode.scheduleRender(inst);
      }
    }

    // ── Buffer shrink (reclaim memory after sustained low usage) ───────────
    const SHRINK_THRESHOLD = 120; // ~2 seconds at 60fps
    // 2D batch
    if (batchOffset * 4 < bd.length && bd.length > 1024 * 6 * BATCH_STRIDE_FLOATS) {
      if (++inst.batchShrinkFrames >= SHRINK_THRESHOLD) {
        inst.batchCap = Math.max(1024 * 6, batchOffset * 2);
        bd = inst.batchData = new Float32Array(inst.batchCap * BATCH_STRIDE_FLOATS);
        inst.batchShrinkFrames = 0;
      }
    } else { inst.batchShrinkFrames = 0; }
    // 3D batch
    if (is3d && inst.batch3dCap > 0) {
      if (b3dPeakOffset * 4 < inst.batch3dCap && inst.batch3dCap > STRIDE_3D * 120) {
        if (++inst.batch3dShrinkFrames >= SHRINK_THRESHOLD) {
          inst.batch3dCap = Math.max(STRIDE_3D * 120, b3dPeakOffset * 2);
          inst.batch3dData = new Float32Array(inst.batch3dCap);
          inst.batch3dShrinkFrames = 0;
        }
      } else { inst.batch3dShrinkFrames = 0; }
    }

    // ── Post-processing ─────────────────────────────────────────────────────
    if (needsPost && inst.fboA) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, cw, ch);
      gl.disable(gl.DEPTH_TEST);

      drawCalls += applyPostProcessing(inst, cw, ch);
    }

    inst.metricsDrawCalls = drawCalls;
  }

  private static createProgram(
    gl: WebGLRenderingContext,
    vertSrc: string,
    fragSrc: string,
    webgl2 = false,
  ): WebGLProgram | null {
    const vs = webgl2 && !vertSrc.includes("#version") ? upgradeVert(vertSrc) : vertSrc;
    const fs = webgl2 && !fragSrc.includes("#version") ? upgradeFrag(fragSrc) : fragSrc;
    const vert = GlNode.compileShader(gl, gl.VERTEX_SHADER, vs);
    const frag = GlNode.compileShader(gl, gl.FRAGMENT_SHADER, fs);
    if (!vert || !frag) return null;

    const prog = gl.createProgram()!;
    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);

    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error("[GL] Program link error:", gl.getProgramInfoLog(prog));
      return null;
    }

    gl.deleteShader(vert);
    gl.deleteShader(frag);
    return prog;
  }

  private static compileShader(
    gl: WebGLRenderingContext,
    type: number,
    src: string,
  ): WebGLShader | null {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error("[GL] Shader compile error:", gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

}
