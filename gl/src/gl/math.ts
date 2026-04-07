// ─── Mat4 helpers ───────────────────────────────────────────────────────────

export const _projM = new Float32Array(16);
export function mat4Perspective(fovDeg: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1.0 / Math.tan((fovDeg * Math.PI / 180) / 2);
  const nf = 1 / (near - far);
  const m = _projM;
  m[0] = f / aspect; m[1] = 0; m[2] = 0; m[3] = 0;
  m[4] = 0; m[5] = f; m[6] = 0; m[7] = 0;
  m[8] = 0; m[9] = 0; m[10] = (far + near) * nf; m[11] = -1;
  m[12] = 0; m[13] = 0; m[14] = 2 * far * near * nf; m[15] = 0;
  return m;
}

export function mat4Ortho(left: number, right: number, bottom: number, top: number, near: number, far: number): Float32Array {
  const m = _projM;
  const lr = 1 / (left - right), bt = 1 / (bottom - top), nf = 1 / (near - far);
  m[0] = -2 * lr; m[1] = 0; m[2] = 0; m[3] = 0;
  m[4] = 0; m[5] = -2 * bt; m[6] = 0; m[7] = 0;
  m[8] = 0; m[9] = 0; m[10] = 2 * nf; m[11] = 0;
  m[12] = (left + right) * lr; m[13] = (top + bottom) * bt; m[14] = (far + near) * nf; m[15] = 1;
  return m;
}

export const _viewM = new Float32Array(16);
export function mat4LookAt(eye: number[], target: number[], up: number[]): Float32Array {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  let len = Math.sqrt(zx * zx + zy * zy + zz * zz);
  if (len > 0) { zx /= len; zy /= len; zz /= len; }
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  len = Math.sqrt(xx * xx + xy * xy + xz * xz);
  if (len > 0) { xx /= len; xy /= len; xz /= len; }
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  const m = _viewM;
  m[0] = xx; m[1] = yx; m[2] = zx; m[3] = 0;
  m[4] = xy; m[5] = yy; m[6] = zy; m[7] = 0;
  m[8] = xz; m[9] = yz; m[10] = zz; m[11] = 0;
  m[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  m[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  m[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  m[15] = 1;
  return m;
}

export const MAT4_IDENTITY = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);

// Scratch buffer reused by mat4Model to avoid allocation per entity
export const _m4 = new Float32Array(16);
// Scratch buffer for inverse-transpose of upper-left 3x3 (normal matrix)
export const _n9 = new Float32Array(9);
/** Compute inverse-transpose of upper-left 3x3 of a 4x4 matrix (for correct normals under non-uniform scale). */
export function normalMat3(m: Float32Array): Float32Array {
  const a00 = m[0], a01 = m[1], a02 = m[2];
  const a10 = m[4], a11 = m[5], a12 = m[6];
  const a20 = m[8], a21 = m[9], a22 = m[10];
  const det = a00*(a11*a22 - a12*a21) - a01*(a10*a22 - a12*a20) + a02*(a10*a21 - a11*a20);
  if (Math.abs(det) < 1e-10) { _n9[0]=1;_n9[1]=0;_n9[2]=0;_n9[3]=0;_n9[4]=1;_n9[5]=0;_n9[6]=0;_n9[7]=0;_n9[8]=1; return _n9; }
  const id = 1 / det;
  // Inverse, then transpose: result[col][row] = cofactor[row][col] / det
  // Since we want transpose(inverse(M3)), we store cofactors directly (no transpose step needed
  // because cofactor matrix = det * inverse^T, so cofactor/det = inverse^T)
  _n9[0] = (a11*a22 - a12*a21) * id;  // row0
  _n9[1] = (a02*a21 - a01*a22) * id;
  _n9[2] = (a01*a12 - a02*a11) * id;
  _n9[3] = (a12*a20 - a10*a22) * id;  // row1
  _n9[4] = (a00*a22 - a02*a20) * id;
  _n9[5] = (a02*a10 - a00*a12) * id;
  _n9[6] = (a10*a21 - a11*a20) * id;  // row2
  _n9[7] = (a01*a20 - a00*a21) * id;
  _n9[8] = (a00*a11 - a01*a10) * id;
  return _n9;
}

export function mat4Model(
  x: number, y: number, zPos: number,
  w: number, h: number, d: number,
  rx: number, ry: number, rz: number,
): Float32Array {
  const m = _m4;
  m[3] = 0; m[7] = 0; m[11] = 0; m[15] = 1;
  // translate
  m[12] = x; m[13] = y; m[14] = zPos;
  // rotate Y then X then Z (degrees → rad)
  const cY = Math.cos(ry * Math.PI / 180), sY = Math.sin(ry * Math.PI / 180);
  const cX = Math.cos(rx * Math.PI / 180), sX = Math.sin(rx * Math.PI / 180);
  const cZ = Math.cos(rz * Math.PI / 180), sZ = Math.sin(rz * Math.PI / 180);
  // R = Rz * Rx * Ry  (column-major)
  // scale * rotation
  m[0] = (cZ * cY + sZ * sX * sY) * w; m[1] = sZ * cX * w;  m[2] = (-cZ * sY + sZ * sX * cY) * w;
  m[4] = (-sZ * cY + cZ * sX * sY) * h; m[5] = cZ * cX * h;  m[6] = (sZ * sY + cZ * sX * cY) * h;
  m[8] = cX * sY * d;                    m[9] = -sX * d;       m[10] = cX * cY * d;
  return m;
}

// Billboard: face the camera while preserving position and scale
export const _bbM = new Float32Array(16);
export function mat4Billboard(
  x: number, y: number, z: number,
  w: number, h: number, depth: number,
  camX: number, camY: number, camZ: number,
): Float32Array {
  const m = _bbM;
  // Compute forward vector (entity → camera)
  let fx = camX - x, fy = camY - y, fz = camZ - z;
  const fLen = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
  fx /= fLen; fy /= fLen; fz /= fLen;
  // Right = cross(worldUp, forward)
  // worldUp = (0, 1, 0) for Y-up, but engine uses Y-down, so (0, -1, 0)
  let rx = -fz, ry = 0, rz = fx;
  const rLen = Math.sqrt(rx * rx + rz * rz) || 1;
  rx /= rLen; rz /= rLen;
  // Up = cross(forward, right)
  const ux = fy * rz - fz * ry, uy = fz * rx - fx * rz, uz = fx * ry - fy * rx;
  // Scale columns
  m[0] = rx * w;  m[1] = ry * w;  m[2] = rz * w;  m[3] = 0;
  m[4] = ux * h;  m[5] = uy * h;  m[6] = uz * h;  m[7] = 0;
  m[8] = fx * depth; m[9] = fy * depth; m[10] = fz * depth; m[11] = 0;
  m[12] = x; m[13] = y; m[14] = z; m[15] = 1;
  return m;
}

// ─── Mat4 inversion (for ray unprojection) ──────────────────────────────────

export const _mulM = new Float32Array(16);
export function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = _mulM;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[j * 4 + i] = a[i] * b[j * 4] + a[4 + i] * b[j * 4 + 1] + a[8 + i] * b[j * 4 + 2] + a[12 + i] * b[j * 4 + 3];
    }
  }
  return out;
}

export const _invM = new Float32Array(16);
export const _frustum = new Float32Array(24); // 6 planes × (a,b,c,d)
// Preallocated point light upload buffers (max 8 lights)
export const _plPos = new Float32Array(24);   // 8 × 3
export const _plCol = new Float32Array(24);   // 8 × 3
export const _plRad = new Float32Array(8);
export const _plCone = new Float32Array(8);
export const _plDir = new Float32Array(24);   // 8 × 3

/** Bind a texture only if it differs from the currently bound one. Returns the new current texture. */
export function bindTex(gl: WebGLRenderingContext, tex: WebGLTexture, current: WebGLTexture | null): WebGLTexture {
  if (tex !== current) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); }
  return tex;
}
export function mat4Invert(m: Float32Array): Float32Array | null {
  const inv = _invM;
  const m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3];
  const m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7];
  const m8 = m[8], m9 = m[9], m10 = m[10], m11 = m[11];
  const m12 = m[12], m13 = m[13], m14 = m[14], m15 = m[15];

  inv[0]  =  m5*m10*m15 - m5*m11*m14 - m9*m6*m15 + m9*m7*m14 + m13*m6*m11 - m13*m7*m10;
  inv[4]  = -m4*m10*m15 + m4*m11*m14 + m8*m6*m15 - m8*m7*m14 - m12*m6*m11 + m12*m7*m10;
  inv[8]  =  m4*m9*m15  - m4*m11*m13 - m8*m5*m15 + m8*m7*m13 + m12*m5*m11 - m12*m7*m9;
  inv[12] = -m4*m9*m14  + m4*m10*m13 + m8*m5*m14 - m8*m6*m13 - m12*m5*m10 + m12*m6*m9;
  inv[1]  = -m1*m10*m15 + m1*m11*m14 + m9*m2*m15 - m9*m3*m14 - m13*m2*m11 + m13*m3*m10;
  inv[5]  =  m0*m10*m15 - m0*m11*m14 - m8*m2*m15 + m8*m3*m14 + m12*m2*m11 - m12*m3*m10;
  inv[9]  = -m0*m9*m15  + m0*m11*m13 + m8*m1*m15 - m8*m3*m13 - m12*m1*m11 + m12*m3*m9;
  inv[13] =  m0*m9*m14  - m0*m10*m13 - m8*m1*m14 + m8*m2*m13 + m12*m1*m10 - m12*m2*m9;
  inv[2]  =  m1*m6*m15  - m1*m7*m14  - m5*m2*m15 + m5*m3*m14 + m13*m2*m7  - m13*m3*m6;
  inv[6]  = -m0*m6*m15  + m0*m7*m14  + m4*m2*m15 - m4*m3*m14 - m12*m2*m7  + m12*m3*m6;
  inv[10] =  m0*m5*m15  - m0*m7*m13  - m4*m1*m15 + m4*m3*m13 + m12*m1*m7  - m12*m3*m5;
  inv[14] = -m0*m5*m14  + m0*m6*m13  + m4*m1*m14 - m4*m2*m13 - m12*m1*m6  + m12*m2*m5;
  inv[3]  = -m1*m6*m11  + m1*m7*m10  + m5*m2*m11 - m5*m3*m10 - m9*m2*m7   + m9*m3*m6;
  inv[7]  =  m0*m6*m11  - m0*m7*m10  - m4*m2*m11 + m4*m3*m10 + m8*m2*m7   - m8*m3*m6;
  inv[11] = -m0*m5*m11  + m0*m7*m9   + m4*m1*m11 - m4*m3*m9  - m8*m1*m7   + m8*m3*m5;
  inv[15] =  m0*m5*m10  - m0*m6*m9   - m4*m1*m10 + m4*m2*m9  + m8*m1*m6   - m8*m2*m5;

  const det = m0*inv[0] + m1*inv[4] + m2*inv[8] + m3*inv[12];
  if (Math.abs(det) < 1e-10) return null;
  const invDet = 1.0 / det;
  for (let i = 0; i < 16; i++) inv[i] *= invDet;
  return inv;
}

/** Unproject screen coords (px, py) to a ray in world space. Returns [origin, direction]. */
export function unprojectRay(
  px: number, py: number,
  canvasW: number, canvasH: number,
  proj: Float32Array, view: Float32Array,
): { origin: number[]; dir: number[] } | null {
  const invVP = mat4Invert(mat4Multiply(proj, view));
  if (!invVP) return null;
  // NDC: x=[-1,1], y=[-1,1] (flip y for WebGL)
  const ndcX = (px / canvasW) * 2 - 1;
  const ndcY = 1 - (py / canvasH) * 2;
  // Near plane point (z=-1 in NDC)
  const nearW = invVP[3]*ndcX + invVP[7]*ndcY + invVP[11]*(-1) + invVP[15];
  const nearX = (invVP[0]*ndcX + invVP[4]*ndcY + invVP[8]*(-1) + invVP[12]) / nearW;
  const nearY = (invVP[1]*ndcX + invVP[5]*ndcY + invVP[9]*(-1) + invVP[13]) / nearW;
  const nearZ = (invVP[2]*ndcX + invVP[6]*ndcY + invVP[10]*(-1) + invVP[14]) / nearW;
  // Far plane point (z=1 in NDC)
  const farW = invVP[3]*ndcX + invVP[7]*ndcY + invVP[11]*1 + invVP[15];
  const farX = (invVP[0]*ndcX + invVP[4]*ndcY + invVP[8]*1 + invVP[12]) / farW;
  const farY = (invVP[1]*ndcX + invVP[5]*ndcY + invVP[9]*1 + invVP[13]) / farW;
  const farZ = (invVP[2]*ndcX + invVP[6]*ndcY + invVP[10]*1 + invVP[14]) / farW;
  // Direction
  let dx = farX - nearX, dy = farY - nearY, dz = farZ - nearZ;
  const len = Math.sqrt(dx*dx + dy*dy + dz*dz);
  if (len > 0) { dx /= len; dy /= len; dz /= len; }
  return { origin: [nearX, nearY, nearZ], dir: [dx, dy, dz] };
}

// Ray-AABB intersection lives in core/ for server+client use
export { rayAABB } from "@jexs/physics";
