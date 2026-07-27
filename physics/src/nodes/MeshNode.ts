/**
 * MeshNode — GLB / GLTF import.
 *
 * Handlers:
 * - { "parseGLB": <ArrayBuffer | Uint8Array | Buffer>, "name"?: string }
 *     Parses a binary GLB file. Returns a `Scene` descriptor.
 * - { "parseGLTF": { "json": <object>, "buffers": <array | object> }, "name"?: string }
 *     Parses pre-loaded glTF JSON + sibling buffers. Returns a `Scene` descriptor.
 * - { "register-mesh": <MeshData> }
 *     Inserts a MeshData into the active EntityStore's `meshes` map (env-aware:
 *     GL package patches an upload step in via subclassing/composition; here we
 *     just hold the CPU geometry + bounds).
 *
 * The parser is env-agnostic — it does no I/O. Callers pre-load bytes via
 * FileNode (server) or FetchNode (core).
 */

import { Node, Context, NodeValue, resolveAll, resolveObj } from "@jexs/core";
import { EntityStore } from "../EntityStore.js";
import { computeBounds } from "../Bvh.js";
import type {
  MeshData, MeshEntry, MeshMaterial, NodeData, Scene, Bounds,
} from "../Mesh.js";
import type { JexsNodeSchema } from "@jexs/core";

// ─── glTF accessor constants ─────────────────────────────────────────────────

const COMPONENT_BYTE          = 5120;
const COMPONENT_UNSIGNED_BYTE = 5121;
const COMPONENT_SHORT         = 5122;
const COMPONENT_UNSIGNED_SHORT = 5123;
const COMPONENT_UNSIGNED_INT  = 5125;
const COMPONENT_FLOAT         = 5126;

const TYPE_NUM_COMPONENTS: Record<string, number> = {
  SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16,
};

const COMPONENT_BYTE_SIZE: Record<number, number> = {
  [COMPONENT_BYTE]: 1, [COMPONENT_UNSIGNED_BYTE]: 1,
  [COMPONENT_SHORT]: 2, [COMPONENT_UNSIGNED_SHORT]: 2,
  [COMPONENT_UNSIGNED_INT]: 4, [COMPONENT_FLOAT]: 4,
};

// ─── GLB header constants ────────────────────────────────────────────────────

const GLB_MAGIC      = 0x46546c67; // "glTF" little-endian
const GLB_CHUNK_JSON = 0x4e4f534a; // "JSON"
const GLB_CHUNK_BIN  = 0x004e4942; // "BIN\0"

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toUint8(buffer: unknown): Uint8Array {
  if (buffer instanceof Uint8Array) return buffer;
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  if (ArrayBuffer.isView(buffer)) return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  throw new Error("MeshNode: expected ArrayBuffer / Uint8Array / Buffer");
}

function readGlb(bytes: Uint8Array): { json: Record<string, unknown>; bin: Uint8Array | null } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = dv.getUint32(0, true);
  if (magic !== GLB_MAGIC) throw new Error(`MeshNode: not a GLB file (magic 0x${magic.toString(16)})`);
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new Error(`MeshNode: unsupported GLB version ${version} (expected 2)`);

  let offset = 12;
  let json: Record<string, unknown> | null = null;
  let bin: Uint8Array | null = null;

  while (offset < bytes.byteLength) {
    const chunkLen  = dv.getUint32(offset, true);
    const chunkType = dv.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    if (chunkType === GLB_CHUNK_JSON) {
      const text = new TextDecoder("utf-8").decode(bytes.subarray(chunkStart, chunkStart + chunkLen));
      json = JSON.parse(text);
    } else if (chunkType === GLB_CHUNK_BIN) {
      bin = bytes.subarray(chunkStart, chunkStart + chunkLen);
    }
    offset = chunkStart + chunkLen;
  }

  if (!json) throw new Error("MeshNode: GLB missing JSON chunk");
  return { json, bin };
}

/** Resolve gltf.buffers[i] to a Uint8Array, given the user-supplied buffers map. */
function resolveBuffer(
  bufDef: Record<string, unknown>,
  index: number,
  supplied: Record<string, unknown> | unknown[],
  glbBin: Uint8Array | null,
): Uint8Array {
  const uri = bufDef.uri as string | undefined;

  // GLB embedded BIN chunk: glTF spec says the first buffer has no `uri`.
  if (!uri && glbBin && index === 0) return glbBin;

  // data: URI inline
  if (uri && uri.startsWith("data:")) {
    const comma = uri.indexOf(",");
    if (comma < 0) throw new Error("MeshNode: malformed data URI");
    const meta = uri.slice(5, comma);
    const data = uri.slice(comma + 1);
    if (meta.includes(";base64")) {
      // atob is available in browsers and Node 16+; fallback for older Node
      const decode = typeof atob === "function" ? atob : (s: string) => {
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let result = "", i = 0;
        const str = s.replace(/=+$/, "");
        while (i < str.length) {
          const a = chars.indexOf(str[i++]), b = chars.indexOf(str[i++]);
          const c = chars.indexOf(str[i++]), d = chars.indexOf(str[i++]);
          const n = (a << 18) | (b << 12) | (c << 6) | d;
          result += String.fromCharCode((n >> 16) & 0xff);
          if (c !== -1) result += String.fromCharCode((n >> 8) & 0xff);
          if (d !== -1) result += String.fromCharCode(n & 0xff);
        }
        return result;
      };
      const bin = decode(data);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new TextEncoder().encode(decodeURIComponent(data));
  }

  // External buffer — caller supplied
  let candidate: unknown = undefined;
  if (Array.isArray(supplied)) {
    candidate = supplied[index];
  } else if (uri && supplied && typeof supplied === "object") {
    candidate = (supplied as Record<string, unknown>)[uri];
  }
  if (candidate == null) throw new Error(`MeshNode: missing buffer ${uri ?? `[${index}]`} (pass via "buffers")`);
  return toUint8(candidate);
}

/**
 * meshopt decoder (EXT_meshopt_compression), injected by the host so this
 * env-agnostic package never fetches/instantiates WASM itself. The host
 * (browser: client/gl) loads `meshopt_decoder` and calls `setMeshoptDecoder`.
 */
export interface MeshoptDecoder {
  decodeGltfBuffer(
    target: Uint8Array, count: number, size: number,
    source: Uint8Array, mode: string, filter?: string,
  ): void;
}

// The decoder is loaded LAZILY — only when a glTF that actually uses
// EXT_meshopt_compression is parsed. The env (gl) supplies an async loader that
// `import()`s the WASM decoder; physics stays env-agnostic and never fetches it.
let _meshoptDecoder: MeshoptDecoder | null = null;
let _meshoptLoader: (() => Promise<MeshoptDecoder>) | null = null;

/** Env hook: provide an async loader for the meshopt decoder (e.g.
 *  `() => import("meshoptimizer").then(...)`). Called once, on the first
 *  meshopt-compressed mesh. */
export function setMeshoptLoader(loader: (() => Promise<MeshoptDecoder>) | null): void {
  _meshoptLoader = loader;
}

/** True if a glTF document declares any `EXT_meshopt_compression` bufferView. */
function hasMeshoptViews(gltf: Record<string, unknown>): boolean {
  const views = gltf.bufferViews as Array<Record<string, unknown>> | undefined;
  if (!views) return false;
  for (const v of views) {
    if ((v.extensions as Record<string, unknown> | undefined)?.EXT_meshopt_compression) return true;
  }
  return false;
}

/** Ensure the meshopt decoder is loaded (await before the sync parse). No-op
 *  when already loaded; throws if the doc needs it but no loader was supplied. */
async function ensureMeshoptDecoder(gltf: Record<string, unknown>): Promise<void> {
  if (_meshoptDecoder || !hasMeshoptViews(gltf)) return;
  if (!_meshoptLoader) {
    throw new Error("MeshNode: mesh uses EXT_meshopt_compression but no decoder loader is set — call setMeshoptLoader()");
  }
  _meshoptDecoder = await _meshoptLoader();
}

/**
 * Pre-decode every bufferView carrying `EXT_meshopt_compression` into a tight,
 * standalone byte array, keyed by bufferView index. Accessors then read from
 * the decoded bytes instead of the raw buffer.
 */
function decodeMeshoptViews(
  gltf: Record<string, unknown>,
  bufferBytes: Uint8Array[],
): Map<number, Uint8Array> {
  const bufferViews = gltf.bufferViews as Array<Record<string, unknown>> | undefined;
  const decoded = new Map<number, Uint8Array>();
  if (!bufferViews) return decoded;
  for (let i = 0; i < bufferViews.length; i++) {
    const ext = (bufferViews[i].extensions as Record<string, unknown> | undefined)
      ?.EXT_meshopt_compression as Record<string, unknown> | undefined;
    if (!ext) continue;
    if (!_meshoptDecoder) {
      throw new Error("MeshNode: mesh uses EXT_meshopt_compression but no decoder is set — call setMeshoptDecoder()");
    }
    const src        = bufferBytes[ext.buffer as number];
    const byteOffset = (ext.byteOffset as number | undefined) ?? 0;
    const byteLength = ext.byteLength as number;
    const count      = ext.count as number;
    const byteStride = ext.byteStride as number;
    const mode       = ext.mode as string;
    const filter     = (ext.filter as string | undefined) ?? "NONE";
    const source = src.subarray(byteOffset, byteOffset + byteLength);
    const target = new Uint8Array(count * byteStride);
    _meshoptDecoder.decodeGltfBuffer(target, count, byteStride, source, mode, filter);
    decoded.set(i, target);
  }
  return decoded;
}

/** Read a typed array view of a glTF accessor. */
function readAccessor(
  gltf: Record<string, unknown>,
  bufferBytes: Uint8Array[],
  decodedViews: Map<number, Uint8Array>,
  accessorIdx: number,
): { array: Float32Array | Uint16Array | Uint32Array | Uint8Array | Int16Array | Int8Array; count: number; numComponents: number } {
  const accessors   = gltf.accessors as Array<Record<string, unknown>>;
  const bufferViews = gltf.bufferViews as Array<Record<string, unknown>>;
  const acc  = accessors[accessorIdx];
  const viewIdx = acc.bufferView as number;
  const view = bufferViews[viewIdx];
  // A meshopt-compressed view was pre-decoded into its own tight Uint8Array;
  // that buffer IS the view content, so its view-relative offset is 0.
  const decoded = decodedViews.get(viewIdx);
  const buf  = decoded ?? bufferBytes[view.buffer as number];

  const componentType = acc.componentType as number;
  const numComponents = TYPE_NUM_COMPONENTS[acc.type as string];
  const count         = acc.count as number;
  const accByteOffset = (acc.byteOffset as number | undefined) ?? 0;
  const viewByteOffset = decoded ? 0 : ((view.byteOffset as number | undefined) ?? 0);
  const totalOffset   = buf.byteOffset + viewByteOffset + accByteOffset;
  const compSize      = COMPONENT_BYTE_SIZE[componentType];
  const stride        = (view.byteStride as number | undefined) ?? compSize * numComponents;
  const tightStride   = compSize * numComponents;

  // Tight-packed fast path.
  if (stride === tightStride) {
    const elementCount = count * numComponents;
    switch (componentType) {
      case COMPONENT_FLOAT:          return { array: new Float32Array(buf.buffer, totalOffset, elementCount), count, numComponents };
      case COMPONENT_UNSIGNED_INT:   return { array: new Uint32Array (buf.buffer, totalOffset, elementCount), count, numComponents };
      case COMPONENT_UNSIGNED_SHORT: return { array: new Uint16Array (buf.buffer, totalOffset, elementCount), count, numComponents };
      case COMPONENT_UNSIGNED_BYTE:  return { array: new Uint8Array  (buf.buffer, totalOffset, elementCount), count, numComponents };
      case COMPONENT_SHORT:          return { array: new Int16Array  (buf.buffer, totalOffset, elementCount), count, numComponents };
      case COMPONENT_BYTE:           return { array: new Int8Array   (buf.buffer, totalOffset, elementCount), count, numComponents };
    }
  }

  // Strided: copy out into a tight typed array.
  const dv = new DataView(buf.buffer, buf.byteOffset + viewByteOffset, view.byteLength as number);
  const reader = makeComponentReader(componentType);
  const Ctor   = typedArrayCtor(componentType);
  const out    = new Ctor(count * numComponents) as Float32Array | Uint32Array | Uint16Array | Uint8Array | Int16Array | Int8Array;
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < numComponents; c++) {
      out[i * numComponents + c] = reader(dv, accByteOffset + i * stride + c * compSize);
    }
  }
  return { array: out, count, numComponents };
}

function makeComponentReader(componentType: number): (dv: DataView, offset: number) => number {
  switch (componentType) {
    case COMPONENT_FLOAT:          return (dv, o) => dv.getFloat32(o, true);
    case COMPONENT_UNSIGNED_INT:   return (dv, o) => dv.getUint32 (o, true);
    case COMPONENT_UNSIGNED_SHORT: return (dv, o) => dv.getUint16 (o, true);
    case COMPONENT_UNSIGNED_BYTE:  return (dv, o) => dv.getUint8  (o);
    case COMPONENT_SHORT:          return (dv, o) => dv.getInt16  (o, true);
    case COMPONENT_BYTE:           return (dv, o) => dv.getInt8   (o);
  }
  throw new Error(`MeshNode: unsupported componentType ${componentType}`);
}

function typedArrayCtor(componentType: number) {
  switch (componentType) {
    case COMPONENT_FLOAT:          return Float32Array;
    case COMPONENT_UNSIGNED_INT:   return Uint32Array;
    case COMPONENT_UNSIGNED_SHORT: return Uint16Array;
    case COMPONENT_UNSIGNED_BYTE:  return Uint8Array;
    case COMPONENT_SHORT:          return Int16Array;
    case COMPONENT_BYTE:           return Int8Array;
  }
  throw new Error(`MeshNode: unsupported componentType ${componentType}`);
}

/** Decompose a glTF column-major 4x4 matrix into translation, quaternion, scale. */
function decomposeMatrix(m: number[]): {
  translation: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
} {
  const tx = m[12], ty = m[13], tz = m[14];
  const sx = Math.hypot(m[0], m[1], m[2]);
  const sy = Math.hypot(m[4], m[5], m[6]);
  const sz = Math.hypot(m[8], m[9], m[10]);
  const det = m[0] * (m[5] * m[10] - m[6] * m[9])
            - m[1] * (m[4] * m[10] - m[6] * m[8])
            + m[2] * (m[4] * m[9]  - m[5] * m[8]);
  const sxSigned = det < 0 ? -sx : sx;

  const r00 = m[0] / sxSigned, r01 = m[4] / sy, r02 = m[8]  / sz;
  const r10 = m[1] / sxSigned, r11 = m[5] / sy, r12 = m[9]  / sz;
  const r20 = m[2] / sxSigned, r21 = m[6] / sy, r22 = m[10] / sz;

  // Rotation matrix → quaternion
  const trace = r00 + r11 + r22;
  let qx = 0, qy = 0, qz = 0, qw = 1;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    qw = 0.25 / s;
    qx = (r21 - r12) * s;
    qy = (r02 - r20) * s;
    qz = (r10 - r01) * s;
  } else if (r00 > r11 && r00 > r22) {
    const s = 2 * Math.sqrt(1 + r00 - r11 - r22);
    qw = (r21 - r12) / s;
    qx = 0.25 * s;
    qy = (r01 + r10) / s;
    qz = (r02 + r20) / s;
  } else if (r11 > r22) {
    const s = 2 * Math.sqrt(1 + r11 - r00 - r22);
    qw = (r02 - r20) / s;
    qx = (r01 + r10) / s;
    qy = 0.25 * s;
    qz = (r12 + r21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + r22 - r00 - r11);
    qw = (r10 - r01) / s;
    qx = (r02 + r20) / s;
    qy = (r12 + r21) / s;
    qz = 0.25 * s;
  }

  return {
    translation: [tx, ty, tz],
    quaternion: [qx, qy, qz, qw],
    scale: [sxSigned, sy, sz],
  };
}

/** Compute flat per-vertex normals when the mesh doesn't supply any. */
function computeFlatNormals(
  positions: Float32Array,
  indices: Uint16Array | Uint32Array | undefined,
): Float32Array {
  const normals = new Float32Array(positions.length);
  const triCount = indices ? indices.length / 3 : positions.length / 9;
  for (let t = 0; t < triCount; t++) {
    const i0 = indices ? indices[t * 3]     : t * 3;
    const i1 = indices ? indices[t * 3 + 1] : t * 3 + 1;
    const i2 = indices ? indices[t * 3 + 2] : t * 3 + 2;
    const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
    const bx = positions[i1 * 3], by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2];
    const cx = positions[i2 * 3], cy = positions[i2 * 3 + 1], cz = positions[i2 * 3 + 2];
    const ex = bx - ax, ey = by - ay, ez = bz - az;
    const fx = cx - ax, fy = cy - ay, fz = cz - az;
    let nx = ey * fz - ez * fy;
    let ny = ez * fx - ex * fz;
    let nz = ex * fy - ey * fx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const i of [i0, i1, i2]) {
      normals[i * 3]     += nx;
      normals[i * 3 + 1] += ny;
      normals[i * 3 + 2] += nz;
    }
  }
  // Normalize accumulated.
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i]     /= len;
    normals[i + 1] /= len;
    normals[i + 2] /= len;
  }
  return normals;
}

function boundsFromAccessor(acc: Record<string, unknown> | undefined, positions: Float32Array): Bounds {
  if (acc && Array.isArray(acc.min) && Array.isArray(acc.max) && acc.min.length === 3) {
    const mn = acc.min as number[]; const mx = acc.max as number[];
    return { min: [mn[0], mn[1], mn[2]], max: [mx[0], mx[1], mx[2]] };
  }
  return computeBounds(positions);
}

function uint8ToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "", i = 0;
  while (i < bytes.length) {
    const a = bytes[i++], b = bytes[i++] ?? 0, c = bytes[i++] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63]
        + (i - 1 < bytes.length + 1 ? chars[(n >> 6) & 63] : "=")
        + (i     < bytes.length + 1 ? chars[n & 63]        : "=");
  }
  return out;
}

function extractMaterialUris(gltf: Record<string, unknown>, materialIdx: number | undefined, bufferBytes: Uint8Array[], basePath?: string): MeshMaterial | undefined {
  if (materialIdx == null) return undefined;
  const materials = gltf.materials as Array<Record<string, unknown>> | undefined;
  if (!materials || !materials[materialIdx]) return undefined;
  const m = materials[materialIdx];
  const out: MeshMaterial = {};

  const textures = (gltf.textures as Array<Record<string, unknown>> | undefined) ?? [];
  const images   = (gltf.images   as Array<Record<string, unknown>> | undefined) ?? [];
  const uriOf = (textureIdx: number | undefined): string | undefined => {
    if (textureIdx == null) return undefined;
    const tex = textures[textureIdx];
    if (!tex) return undefined;
    const sourceIdx = tex.source as number | undefined;
    if (sourceIdx == null) return undefined;
    const img = images[sourceIdx];
    if (img?.uri) {
      const uri = img.uri as string;
      if (basePath && !uri.startsWith("data:") && !uri.startsWith("http") && !uri.startsWith("/")) {
        return basePath + uri;
      }
      return uri;
    }
    if (img?.bufferView != null) {
      const bv = (gltf.bufferViews as Array<Record<string, unknown>>)[img.bufferView as number];
      const buf = bufferBytes[bv.buffer as number];
      const off = (bv.byteOffset as number | undefined) ?? 0;
      const len = bv.byteLength as number;
      const mime = (img.mimeType as string | undefined) ?? "image/png";
      return `data:${mime};base64,${uint8ToBase64(buf.subarray(off, off + len))}`;
    }
    return undefined;
  };

  const pbr = m.pbrMetallicRoughness as Record<string, unknown> | undefined;
  if (pbr) {
    const baseColorTex = pbr.baseColorTexture as Record<string, unknown> | undefined;
    const mrTex        = pbr.metallicRoughnessTexture as Record<string, unknown> | undefined;
    out.baseColorUri          = uriOf(baseColorTex?.index as number | undefined);
    out.metallicRoughnessUri  = uriOf(mrTex?.index as number | undefined);
    if (Array.isArray(pbr.baseColorFactor) && pbr.baseColorFactor.length === 4) {
      out.baseColorFactor = pbr.baseColorFactor as [number, number, number, number];
    }
  }
  const normalTex    = m.normalTexture    as Record<string, unknown> | undefined;
  const occTex       = m.occlusionTexture as Record<string, unknown> | undefined;
  const emissiveTex  = m.emissiveTexture  as Record<string, unknown> | undefined;
  out.normalUri    = uriOf(normalTex?.index    as number | undefined);
  out.occlusionUri = uriOf(occTex?.index       as number | undefined);
  out.emissiveUri  = uriOf(emissiveTex?.index  as number | undefined);

  return out;
}

// ─── Core parse ──────────────────────────────────────────────────────────────

function parseGltfJson(
  json: Record<string, unknown>,
  buffers: unknown[] | Record<string, unknown>,
  glbBin: Uint8Array | null,
  name: string,
  basePath?: string,
): Scene {
  // Resolve all buffers.
  const bufferDefs = (json.buffers as Array<Record<string, unknown>> | undefined) ?? [];
  const bufferBytes: Uint8Array[] = bufferDefs.map((b, i) => resolveBuffer(b, i, buffers, glbBin));
  // Pre-decode any meshopt-compressed bufferViews once for this document.
  const decodedViews = decodeMeshoptViews(json, bufferBytes);

  // Build MeshData per (mesh, primitive). A glTF "mesh" is a container of 1..N primitives,
  // and each primitive is one draw call (own material). We emit one MeshData per primitive
  // and remember which primitive ids came from which mesh container for the node traversal below.
  const meshDefs = (json.meshes as Array<Record<string, unknown>> | undefined) ?? [];
  const meshes: Record<string, MeshData> = {};
  const meshIdToPrimIds: string[][] = [];

  for (let mi = 0; mi < meshDefs.length; mi++) {
    const meshDef = meshDefs[mi];
    const defName = (meshDef.name as string | undefined) ?? `mesh_${mi}`;
    const primitives = (meshDef.primitives as Array<Record<string, unknown>>) ?? [];
    const primIds: string[] = [];

    for (let pi = 0; pi < primitives.length; pi++) {
      const prim = primitives[pi];
      const attribs = (prim.attributes as Record<string, number>) ?? {};
      if (attribs.POSITION == null) continue;

      const posAcc = readAccessor(json, bufferBytes, decodedViews, attribs.POSITION);
      const positions = posAcc.array instanceof Float32Array ? posAcc.array : Float32Array.from(posAcc.array);

      let indices: Uint16Array | Uint32Array | undefined;
      if (prim.indices != null) {
        const idxAcc = readAccessor(json, bufferBytes, decodedViews, prim.indices as number);
        if (idxAcc.array instanceof Uint32Array) indices = idxAcc.array;
        else if (idxAcc.array instanceof Uint16Array) indices = idxAcc.array;
        else if (idxAcc.array instanceof Uint8Array) indices = Uint16Array.from(idxAcc.array);
        else throw new Error(`MeshNode: unsupported index componentType for primitive ${mi}/${pi}`);
      }

      let normals: Float32Array | undefined;
      if (attribs.NORMAL != null) {
        const a = readAccessor(json, bufferBytes, decodedViews, attribs.NORMAL);
        normals = a.array instanceof Float32Array ? a.array : Float32Array.from(a.array);
      } else {
        normals = computeFlatNormals(positions, indices);
      }

      let uvs: Float32Array | undefined;
      if (attribs.TEXCOORD_0 != null) {
        const a = readAccessor(json, bufferBytes, decodedViews, attribs.TEXCOORD_0);
        uvs = a.array instanceof Float32Array ? a.array : Float32Array.from(a.array);
      }

      const accessors = json.accessors as Array<Record<string, unknown>>;
      const bounds = boundsFromAccessor(accessors[attribs.POSITION], positions);
      const material = extractMaterialUris(json, prim.material as number | undefined, bufferBytes, basePath);

      const id = `${name}/${defName}/${pi}`;
      const data: MeshData = { id, positions, normals, uvs, indices, bounds, material };
      meshes[id] = data;
      primIds.push(id);
    }

    meshIdToPrimIds.push(primIds);
  }

  // Build entity-shaped node list from the default scene (or scene 0).
  // Emission order is DFS pre-order so parents are always written before children.
  // For nodes with >1 primitive, we emit a pivot row carrying the node transform plus
  // one mesh-row child per primitive (identity local) — engine renders one draw call
  // per entity, so multi-material objects need one entity per primitive sharing a parent.
  const nodeDefs = (json.nodes as Array<Record<string, unknown>> | undefined) ?? [];
  const sceneDefs = (json.scenes as Array<Record<string, unknown>> | undefined) ?? [];
  const sceneIdx = (json.scene as number | undefined) ?? 0;
  const rootIndices: number[] = sceneDefs[sceneIdx]
    ? (sceneDefs[sceneIdx].nodes as number[] | undefined) ?? []
    : nodeDefs.map((_, i) => i);

  const nodes: NodeData[] = [];

  function visit(nodeIdx: number, parent: string | null): void {
    const def = nodeDefs[nodeIdx];
    const baseName = (def.name as string | undefined) ?? `node_${nodeIdx}`;
    const id = `${name}/${baseName}`;

    let translation: [number, number, number];
    let rotation: [number, number, number, number];
    let scale: [number, number, number];
    if (Array.isArray(def.matrix) && def.matrix.length === 16) {
      const d = decomposeMatrix(def.matrix as number[]);
      translation = d.translation;
      rotation = d.quaternion;
      scale = d.scale;
    } else {
      translation = (Array.isArray(def.translation) && def.translation.length === 3
        ? [(def.translation as number[])[0], (def.translation as number[])[1], (def.translation as number[])[2]]
        : [0, 0, 0]);
      rotation = (Array.isArray(def.rotation) && def.rotation.length === 4
        ? [(def.rotation as number[])[0], (def.rotation as number[])[1], (def.rotation as number[])[2], (def.rotation as number[])[3]]
        : [0, 0, 0, 1]);
      scale = (Array.isArray(def.scale) && def.scale.length === 3
        ? [(def.scale as number[])[0], (def.scale as number[])[1], (def.scale as number[])[2]]
        : [1, 1, 1]);
    }

    const primIds = def.mesh != null ? (meshIdToPrimIds[def.mesh as number] ?? []) : [];

    if (primIds.length <= 1) {
      // 0 prims → pivot, 1 prim → mesh row. Single row carries the node transform.
      nodes.push({
        id,
        parent,
        type: primIds.length === 1 ? "mesh" : "pivot",
        translation, rotation, scale,
        mesh: primIds[0] ?? null,
      });
    } else {
      // Multi-primitive: emit a pivot row holding the transform, then N child rows
      // with identity locals so they ride on the pivot's world transform.
      nodes.push({
        id,
        parent,
        type: "pivot",
        translation, rotation, scale,
        mesh: null,
      });
      for (let pi = 0; pi < primIds.length; pi++) {
        nodes.push({
          id: `${id}#prim${pi}`,
          parent: id,
          type: "mesh",
          translation: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
          mesh: primIds[pi],
        });
      }
    }

    const children = def.children as number[] | undefined;
    if (children) for (const c of children) visit(c, id);
  }

  for (const r of rootIndices) visit(r, null);

  return { meshes, nodes };
}

// ─── Node ────────────────────────────────────────────────────────────────────

function getStore(context: Context): EntityStore | null {
  const selector = context._glSelector as string | undefined;
  if (!selector) return null;
  const stores = context._entityStores as Record<string, EntityStore> | undefined;
  return stores?.[selector] ?? null;
}

function randomName(): string {
  return `mesh_${Math.random().toString(36).slice(2, 8)}`;
}

export class MeshNode extends Node {
  static schema: JexsNodeSchema = {
    parseGLB: {
      output: "object",
      markdownDescription: "Parses a binary GLB buffer. Returns a `Scene` descriptor with deduped meshes\r\nand a flat node list. Pass `name` for stable, human-readable mesh ids.",
      examples: [
        "{ \"parseGLB\": { \"var\": \"buf\" }, \"name\": \"duck\", \"as\": \"scene\" }",
      ],
      siblings: {
        name: {
          type: "string",
          description: "Optional id prefix (default random).",
        },
      },
    },
    parseGLTF: {
      type: "object",
      output: "object",
      markdownDescription: "Parses pre-loaded glTF JSON + sibling buffers. Pass `buffers` as an array\r\n(matching `gltf.buffers[i]` order) or an object keyed by URI.",
      examples: [
        "{ \"parseGLTF\": { \"json\": { \"var\": \"json\" }, \"buffers\": [{ \"var\": \"bin\" }] }, \"name\": \"duck\", \"as\": \"scene\" }",
      ],
      siblings: {
        name: {
          type: "string",
          description: "Optional id prefix (default random).",
        },
      },
    },
      "register-mesh": {
      type: "string",
      output: "null",
      markdownDescription: "Registers a parsed mesh in the active EntityStore's `meshes` map. Idempotent —\nre-registering the same id is a no-op. GL extends this via `gl-register-mesh`,\nwhich additionally uploads the geometry to the GPU.",
      examples: [
        "{ \"foreach\": { \"var\": \"scene.meshes\" }, \"item\": \"m\", \"do\": {\n    \"register-mesh\": { \"var\": \"m.id\" },\n    \"bounds\":    { \"var\": \"m.bounds\" },\n    \"positions\": { \"var\": \"m.positions\" },\n    \"normals\":   { \"var\": \"m.normals\" },\n    \"uvs\":       { \"var\": \"m.uvs\" },\n    \"indices\":   { \"var\": \"m.indices\" },\n    \"material\":  { \"var\": \"m.material\" }\n} }",
      ],
      siblings: {
        bounds: {
          description: "AABB bounds object { min, max }.",
        },
        positions: {
          description: "Float32Array of XYZ vertex positions.",
        },
        normals: {
          description: "Float32Array of per-vertex normals (optional).",
        },
        uvs: {
          description: "Float32Array of per-vertex UVs (optional).",
        },
        indices: {
          description: "Uint16Array / Uint32Array of triangle indices (optional).",
        },
        material: {
          description: "Material URI map (optional).",
        },
      },
    },
  };

  parseGLB(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.parseGLB, def.name], context, async ([bufRaw, nameRaw]) => {
      const bytes = toUint8(bufRaw);
      const { json, bin } = readGlb(bytes);
      const name = (nameRaw as string | undefined) ?? randomName();
      await ensureMeshoptDecoder(json); // lazy-load the WASM decoder iff needed
      return parseGltfJson(json, [], bin, name);
    });
  }

  parseGLTF(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveObj(def, context, async r => {
      const arg = r["parseGLTF"] as Record<string, unknown> | undefined;
      if (!arg) return null;
      const json = arg.json as Record<string, unknown>;
      if (!json) throw new Error("MeshNode parseGLTF: missing `json`");
      const buffers = (arg.buffers ?? []) as unknown[] | Record<string, unknown>;
      const name = (r["name"] as string | undefined) ?? randomName();
      const basePath = (r["basePath"] as string | undefined);
      await ensureMeshoptDecoder(json); // lazy-load the WASM decoder iff needed
      return parseGltfJson(json, buffers, null, name, basePath);
    });
  }

  ["register-mesh"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveObj(def, context, r => {
      const store = getStore(context);
      if (!store) return null;
      const idRaw = r["register-mesh"];
      if (idRaw == null) return null;
      const id = String(idRaw);
      if (store.meshes.has(id)) return id;
      const positions = r["positions"] as Float32Array | undefined;
      const bounds = r["bounds"] as Bounds | undefined;
      if (!positions || !bounds) return null;
      const entry: MeshEntry = {
        bounds,
        positions,
        normals: r["normals"] as Float32Array | undefined,
        uvs: r["uvs"] as Float32Array | undefined,
        indices: r["indices"] as Uint16Array | Uint32Array | undefined,
        material: r["material"] as MeshMaterial | undefined,
      };
      store.meshes.set(id, entry);
      return id;
    });
  }
}

