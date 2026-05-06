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
 * FileNode (server) or FetchNode (client).
 */

import { Node, Context, NodeValue, resolve, resolveObj } from "@jexs/core";
import { EntityStore } from "../EntityStore.js";
import { computeBounds } from "../Bvh.js";
import type {
  MeshData, MeshEntry, MeshMaterial, NodeData, Scene, Bounds,
} from "../Mesh.js";

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

/** Read a typed array view of a glTF accessor. */
function readAccessor(
  gltf: Record<string, unknown>,
  bufferBytes: Uint8Array[],
  accessorIdx: number,
): { array: Float32Array | Uint16Array | Uint32Array | Uint8Array | Int16Array | Int8Array; count: number; numComponents: number } {
  const accessors   = gltf.accessors as Array<Record<string, unknown>>;
  const bufferViews = gltf.bufferViews as Array<Record<string, unknown>>;
  const acc  = accessors[accessorIdx];
  const view = bufferViews[acc.bufferView as number];
  const buf  = bufferBytes[view.buffer as number];

  const componentType = acc.componentType as number;
  const numComponents = TYPE_NUM_COMPONENTS[acc.type as string];
  const count         = acc.count as number;
  const accByteOffset = (acc.byteOffset as number | undefined) ?? 0;
  const viewByteOffset = (view.byteOffset as number | undefined) ?? 0;
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

const IDENTITY_MAT4: number[] = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];

/** Multiply two column-major 4x4 matrices: out = a * b. */
function multiplyMat4(a: number[], b: number[]): number[] {
  const out: number[] = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

/** Compose a column-major 4x4 matrix from translation, quaternion, scale (glTF order: T * R * S). */
function composeMatrixTRS(t: number[], q: number[], s: number[]): number[] {
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  const sx = s[0], sy = s[1], sz = s[2];
  const m: number[] = new Array(16);
  m[0]  = (1 - (yy + zz)) * sx;
  m[1]  = (xy + wz) * sx;
  m[2]  = (xz - wy) * sx;
  m[3]  = 0;
  m[4]  = (xy - wz) * sy;
  m[5]  = (1 - (xx + zz)) * sy;
  m[6]  = (yz + wx) * sy;
  m[7]  = 0;
  m[8]  = (xz + wy) * sz;
  m[9]  = (yz - wx) * sz;
  m[10] = (1 - (xx + yy)) * sz;
  m[11] = 0;
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1;
  return m;
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

  // Build MeshData per (mesh, primitive).
  const meshDefs = (json.meshes as Array<Record<string, unknown>> | undefined) ?? [];
  const meshes: Record<string, MeshData> = {};
  // meshIdToFirstPrimId[meshIdx] = id for that mesh's primitive 0 (used by node placement);
  // a node referencing a mesh with multiple primitives uses primitive 0 as the canonical id
  // in NodeData.meshId; the other primitives are still in `Scene.meshes` for the user to
  // spawn separately if desired.
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

      const posAcc    = readAccessor(json, bufferBytes, attribs.POSITION);
      const positions = posAcc.array instanceof Float32Array ? posAcc.array : Float32Array.from(posAcc.array);

      let indices: Uint16Array | Uint32Array | undefined;
      if (prim.indices != null) {
        const idxAcc = readAccessor(json, bufferBytes, prim.indices as number);
        if (idxAcc.array instanceof Uint32Array) indices = idxAcc.array;
        else if (idxAcc.array instanceof Uint16Array) indices = idxAcc.array;
        else if (idxAcc.array instanceof Uint8Array) indices = Uint16Array.from(idxAcc.array);
        else throw new Error(`MeshNode: unsupported index componentType for primitive ${mi}/${pi}`);
      }

      let normals: Float32Array | undefined;
      if (attribs.NORMAL != null) {
        const a = readAccessor(json, bufferBytes, attribs.NORMAL);
        normals = a.array instanceof Float32Array ? a.array : Float32Array.from(a.array);
      } else {
        normals = computeFlatNormals(positions, indices);
      }

      let uvs: Float32Array | undefined;
      if (attribs.TEXCOORD_0 != null) {
        const a = readAccessor(json, bufferBytes, attribs.TEXCOORD_0);
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

  // Build NodeData tree from the default scene (or scene 0).
  const nodeDefs = (json.nodes as Array<Record<string, unknown>> | undefined) ?? [];
  const sceneDefs = (json.scenes as Array<Record<string, unknown>> | undefined) ?? [];
  const sceneIdx = (json.scene as number | undefined) ?? 0;
  const rootIndices: number[] = sceneDefs[sceneIdx]
    ? (sceneDefs[sceneIdx].nodes as number[] | undefined) ?? []
    : nodeDefs.map((_, i) => i);

  const nodes: NodeData[] = [];

  function visit(nodeIdx: number, parentId: string | null, parentWorld: number[]): void {
    const def  = nodeDefs[nodeIdx];
    const baseName = (def.name as string | undefined) ?? `node_${nodeIdx}`;
    const id   = `${name}/${baseName}`;

    // Build the node's local matrix (either provided directly, or composed from TRS).
    let localMatrix: number[];
    if (Array.isArray(def.matrix) && def.matrix.length === 16) {
      localMatrix = def.matrix as number[];
    } else {
      const t = (Array.isArray(def.translation) && def.translation.length === 3
        ? def.translation : [0, 0, 0]) as number[];
      const q = (Array.isArray(def.rotation) && def.rotation.length === 4
        ? def.rotation : [0, 0, 0, 1]) as number[];
      const s = (Array.isArray(def.scale) && def.scale.length === 3
        ? def.scale : [1, 1, 1]) as number[];
      localMatrix = composeMatrixTRS(t, q, s);
    }

    const local = decomposeMatrix(localMatrix);
    const worldMatrix = multiplyMat4(parentWorld, localMatrix);
    const world = decomposeMatrix(worldMatrix);

    // A node may reference a mesh; if that mesh has multiple primitives, the node
    // gets the first primitive's id and the rest are available in Scene.meshes for
    // the user to attach to extra entities if desired.
    let meshId: string | null = null;
    if (def.mesh != null) {
      const primIds = meshIdToPrimIds[def.mesh as number] ?? [];
      meshId = primIds[0] ?? null;
    }

    nodes.push({
      id, parentId,
      translation: local.translation, quaternion: local.quaternion, scale: local.scale,
      worldTranslation: world.translation, worldQuaternion: world.quaternion, worldScale: world.scale,
      meshId,
    });

    const children = def.children as number[] | undefined;
    if (children) for (const c of children) visit(c, id, worldMatrix);
  }

  for (const r of rootIndices) visit(r, null, IDENTITY_MAT4);

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
  /**
   * Parses a binary GLB buffer. Returns a `Scene` descriptor with deduped meshes
   * and a flat node list. Pass `name` for stable, human-readable mesh ids.
   *
   * @param {expr} parseGLB ArrayBuffer / Uint8Array / Buffer holding the GLB bytes.
   * @param {string} name Optional id prefix (default random).
   * @example
   * { "parseGLB": { "var": "buf" }, "name": "duck", "as": "scene" }
   */
  parseGLB(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll2(def.parseGLB, def.name, context, (bufRaw, nameRaw) => {
      const bytes = toUint8(bufRaw);
      const { json, bin } = readGlb(bytes);
      const name = (nameRaw as string | undefined) ?? randomName();
      return parseGltfJson(json, [], bin, name);
    });
  }

  /**
   * Parses pre-loaded glTF JSON + sibling buffers. Pass `buffers` as an array
   * (matching `gltf.buffers[i]` order) or an object keyed by URI.
   *
   * @param {object} parseGLTF { json, buffers }
   * @param {string} name Optional id prefix (default random).
   * @example
   * { "parseGLTF": { "json": { "var": "json" }, "buffers": [{ "var": "bin" }] }, "name": "duck", "as": "scene" }
   */
  parseGLTF(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveObj(def, context, r => {
      const arg = r["parseGLTF"] as Record<string, unknown> | undefined;
      if (!arg) return null;
      const json = arg.json as Record<string, unknown>;
      if (!json) throw new Error("MeshNode parseGLTF: missing `json`");
      const buffers = (arg.buffers ?? []) as unknown[] | Record<string, unknown>;
      const name = (r["name"] as string | undefined) ?? randomName();
      const basePath = (r["basePath"] as string | undefined);
      return parseGltfJson(json, buffers, null, name, basePath);
    });
  }

  /**
   * Registers a parsed mesh in the active EntityStore's `meshes` map. Idempotent —
   * re-registering the same id is a no-op. GL extends this via `gl-register-mesh`,
   * which additionally uploads the geometry to the GPU.
   *
   * @param {string} register-mesh Mesh id.
   * @param {expr} bounds AABB bounds object { min, max }.
   * @param {expr} positions Float32Array of XYZ vertex positions.
   * @param {expr} normals Float32Array of per-vertex normals (optional).
   * @param {expr} uvs Float32Array of per-vertex UVs (optional).
   * @param {expr} indices Uint16Array / Uint32Array of triangle indices (optional).
   * @param {expr} material Material URI map (optional).
   * @example
   * { "foreach": { "var": "scene.meshes" }, "item": "m", "do": {
   *     "register-mesh": { "var": "m.id" },
   *     "bounds":    { "var": "m.bounds" },
   *     "positions": { "var": "m.positions" },
   *     "normals":   { "var": "m.normals" },
   *     "uvs":       { "var": "m.uvs" },
   *     "indices":   { "var": "m.indices" },
   *     "material":  { "var": "m.material" }
   * } }
   */
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

/** Two-argument resolveAll wrapper that doesn't care about array packing semantics. */
function resolveAll2(
  a: unknown, b: unknown, context: Context,
  cb: (a: unknown, b: unknown) => unknown,
): unknown {
  return resolve(a, context, ra =>
    resolve(b, context, rb => cb(ra, rb)),
  );
}
