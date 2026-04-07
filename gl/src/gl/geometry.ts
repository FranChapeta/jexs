// ─── 2D geometry ─────────────────────────────────────────────────────────────

export const PARTICLE_QUAD = [0,0, 1,0, 0,1, 1,0, 1,1, 0,1];
export const QUAD_VERTS = new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]);
export const TRI_VERTS  = new Float32Array([0.5, 0, 1, 1, 0, 1]);

export const CIRCLE_VERTS = (() => {
  const N = 40, pts = [0.5, 0.5];
  for (let i = 0; i <= N; i++) {
    const a = (2 * Math.PI * i) / N;
    pts.push(0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a));
  }
  return new Float32Array(pts);
})();

// Circle as explicit triangles for batching (TRIANGLE_FAN can't mix with TRIANGLES)
export const CIRCLE_TRI_VERTS = (() => {
  const N = 40, pts: number[] = [];
  for (let i = 0; i < N; i++) {
    const a0 = (2 * Math.PI * i) / N;
    const a1 = (2 * Math.PI * (i + 1)) / N;
    pts.push(0.5, 0.5);
    pts.push(0.5 + 0.5 * Math.cos(a0), 0.5 + 0.5 * Math.sin(a0));
    pts.push(0.5 + 0.5 * Math.cos(a1), 0.5 + 0.5 * Math.sin(a1));
  }
  return new Float32Array(pts);
})();

// ─── 3D flat geometry (pos3+normal3 interleaved, matching CUBE_VERTS format) ─
// Flat quad: 6 verts, normal = (0,0,1)
export const FLAT_QUAD_VERTS = new Float32Array([
  0,0,0, 0,0,1,  1,0,0, 0,0,1,  0,1,0, 0,0,1,
  1,0,0, 0,0,1,  1,1,0, 0,0,1,  0,1,0, 0,0,1,
]);
// Flat triangle: 3 verts, normal = (0,0,1)
export const FLAT_TRI_VERTS = new Float32Array([
  0.5,0,0, 0,0,1,  1,1,0, 0,0,1,  0,1,0, 0,0,1,
]);
// Flat circle: triangulated disc, normal = (0,0,1)
export const FLAT_CIRCLE_VERTS = (() => {
  const N = 40, pts: number[] = [];
  for (let i = 0; i < N; i++) {
    const a0 = (2 * Math.PI * i) / N;
    const a1 = (2 * Math.PI * (i + 1)) / N;
    pts.push(0.5, 0.5, 0,  0, 0, 1);
    pts.push(0.5 + 0.5 * Math.cos(a0), 0.5 + 0.5 * Math.sin(a0), 0,  0, 0, 1);
    pts.push(0.5 + 0.5 * Math.cos(a1), 0.5 + 0.5 * Math.sin(a1), 0,  0, 0, 1);
  }
  return new Float32Array(pts);
})();

// ─── 3D Cube geometry (36 vertices, 6 faces with normals) ───────────────────
// Unit cube [0,1]^3, each face has outward normal
export const CUBE_VERTS = (() => {
  // face: 4 corners → 2 triangles (6 verts), each with normal
  const faces: [number[], number[]][] = [
    // front  (z=1)
    [[0,0,1, 1,0,1, 1,1,1, 0,0,1, 1,1,1, 0,1,1], [0,0,1]],
    // back   (z=0)
    [[1,0,0, 0,0,0, 0,1,0, 1,0,0, 0,1,0, 1,1,0], [0,0,-1]],
    // top    (y=1)
    [[0,1,1, 1,1,1, 1,1,0, 0,1,1, 1,1,0, 0,1,0], [0,1,0]],
    // bottom (y=0)
    [[0,0,0, 1,0,0, 1,0,1, 0,0,0, 1,0,1, 0,0,1], [0,-1,0]],
    // right  (x=1)
    [[1,0,1, 1,0,0, 1,1,0, 1,0,1, 1,1,0, 1,1,1], [1,0,0]],
    // left   (x=0)
    [[0,0,0, 0,0,1, 0,1,1, 0,0,0, 0,1,1, 0,1,0], [-1,0,0]],
  ];
  const data: number[] = [];
  for (const [verts, n] of faces) {
    for (let i = 0; i < 18; i += 3) {
      data.push(verts[i], verts[i+1], verts[i+2]); // position
      data.push(n[0], n[1], n[2]);                  // normal
    }
  }
  return new Float32Array(data);
})();

// ─── 3D Cylinder geometry (unit cylinder [0,1]^2 x [0,1] height along Z) ────
export const CYLINDER_VERTS = (() => {
  const N = 24, data: number[] = [];
  for (let i = 0; i < N; i++) {
    const a0 = (2 * Math.PI * i) / N, a1 = (2 * Math.PI * (i + 1)) / N;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);
    const x0 = 0.5 + 0.5 * c0, y0 = 0.5 + 0.5 * s0;
    const x1 = 0.5 + 0.5 * c1, y1 = 0.5 + 0.5 * s1;
    // Side face (2 triangles)
    data.push(x0,y0,0, c0,s0,0,  x1,y1,0, c1,s1,0,  x0,y0,1, c0,s0,0);
    data.push(x1,y1,0, c1,s1,0,  x1,y1,1, c1,s1,0,  x0,y0,1, c0,s0,0);
    // Top cap
    data.push(0.5,0.5,1, 0,0,1,  x0,y0,1, 0,0,1,  x1,y1,1, 0,0,1);
    // Bottom cap
    data.push(0.5,0.5,0, 0,0,-1,  x1,y1,0, 0,0,-1,  x0,y0,0, 0,0,-1);
  }
  return new Float32Array(data);
})();

// Flat circle is reused for flat cylinder (d=0)

// ─── 3D Sphere geometry (unit sphere mapped to [0,1]^3) ─────────────────────
export const SPHERE_VERTS = (() => {
  const latN = 12, lonN = 18, data: number[] = [];
  for (let lat = 0; lat < latN; lat++) {
    const t0 = Math.PI * lat / latN, t1 = Math.PI * (lat + 1) / latN;
    const st0 = Math.sin(t0), ct0 = Math.cos(t0);
    const st1 = Math.sin(t1), ct1 = Math.cos(t1);
    for (let lon = 0; lon < lonN; lon++) {
      const p0 = 2 * Math.PI * lon / lonN, p1 = 2 * Math.PI * (lon + 1) / lonN;
      const sp0 = Math.sin(p0), cp0 = Math.cos(p0);
      const sp1 = Math.sin(p1), cp1 = Math.cos(p1);
      // 4 corners on the unit sphere (normals = positions on unit sphere)
      const nx00 = st0*cp0, ny00 = st0*sp0, nz00 = ct0;
      const nx10 = st1*cp0, ny10 = st1*sp0, nz10 = ct1;
      const nx01 = st0*cp1, ny01 = st0*sp1, nz01 = ct0;
      const nx11 = st1*cp1, ny11 = st1*sp1, nz11 = ct1;
      // Map to [0,1]^3
      const x00 = nx00*0.5+0.5, y00 = ny00*0.5+0.5, z00 = nz00*0.5+0.5;
      const x10 = nx10*0.5+0.5, y10 = ny10*0.5+0.5, z10 = nz10*0.5+0.5;
      const x01 = nx01*0.5+0.5, y01 = ny01*0.5+0.5, z01 = nz01*0.5+0.5;
      const x11 = nx11*0.5+0.5, y11 = ny11*0.5+0.5, z11 = nz11*0.5+0.5;
      // Triangle 1
      data.push(x00,y00,z00, nx00,ny00,nz00);
      data.push(x10,y10,z10, nx10,ny10,nz10);
      data.push(x01,y01,z01, nx01,ny01,nz01);
      // Triangle 2
      data.push(x01,y01,z01, nx01,ny01,nz01);
      data.push(x10,y10,z10, nx10,ny10,nz10);
      data.push(x11,y11,z11, nx11,ny11,nz11);
    }
  }
  return new Float32Array(data);
})();

// ─── 3D Cone geometry (unit cone, base at z=0, apex at z=1) ─────────────────
export const CONE_VERTS = (() => {
  const N = 24, data: number[] = [];
  const slope = 1 / Math.sqrt(2); // normal Z component for 45° cone
  for (let i = 0; i < N; i++) {
    const a0 = (2 * Math.PI * i) / N, a1 = (2 * Math.PI * (i + 1)) / N;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);
    const x0 = 0.5 + 0.5 * c0, y0 = 0.5 + 0.5 * s0;
    const x1 = 0.5 + 0.5 * c1, y1 = 0.5 + 0.5 * s1;
    // Side normal: average of the two edge normals
    const mx = (c0+c1)*0.5, my = (s0+s1)*0.5;
    const ml = Math.sqrt(mx*mx + my*my) || 1;
    const snx0 = c0*slope, sny0 = s0*slope;
    const snx1 = c1*slope, sny1 = s1*slope;
    // Side triangle (base edge to apex)
    data.push(x0,y0,0, snx0,sny0,slope,  x1,y1,0, snx1,sny1,slope,  0.5,0.5,1, mx/ml*slope,my/ml*slope,slope);
    // Bottom cap
    data.push(0.5,0.5,0, 0,0,-1,  x1,y1,0, 0,0,-1,  x0,y0,0, 0,0,-1);
  }
  return new Float32Array(data);
})();

// ─── Flat variants for 2D rendering of new shapes ───────────────────────────
// Flat cone: same as flat triangle (already exists)
// Flat cylinder: same as flat circle (already exists)
// Flat sphere: same as flat circle (already exists)

// ─── 3D Ramp geometry (wedge/triangular prism, slope along Y) ───────────────
// Full height at y=0, zero height at y=1. 5 faces: bottom, back, left, right, slope.
export const RAMP_VERTS = (() => {
  const S = 1 / Math.SQRT2; // slope normal components (0, 1/√2, 1/√2)
  const data: number[] = [];
  // Bottom face (z=0), normal (0,0,-1)
  data.push(0,0,0, 0,0,-1,  1,0,0, 0,0,-1,  1,1,0, 0,0,-1);
  data.push(0,0,0, 0,0,-1,  1,1,0, 0,0,-1,  0,1,0, 0,0,-1);
  // Back face (y=0), normal (0,-1,0)
  data.push(0,0,0, 0,-1,0,  0,0,1, 0,-1,0,  1,0,1, 0,-1,0);
  data.push(0,0,0, 0,-1,0,  1,0,1, 0,-1,0,  1,0,0, 0,-1,0);
  // Left face (x=0), normal (-1,0,0), triangle
  data.push(0,0,0, -1,0,0,  0,1,0, -1,0,0,  0,0,1, -1,0,0);
  // Right face (x=1), normal (1,0,0), triangle
  data.push(1,0,0, 1,0,0,  1,0,1, 1,0,0,  1,1,0, 1,0,0);
  // Slope face, normal (0, S, S)
  data.push(0,0,1, 0,S,S,  1,0,1, 0,S,S,  1,1,0, 0,S,S);
  data.push(0,0,1, 0,S,S,  1,1,0, 0,S,S,  0,1,0, 0,S,S);
  return new Float32Array(data);
})();

// ─── Rounded cube generator ─────────────────────────────────────────────────

export function generateRoundedCube(r: number, segs: number): Float32Array {
  const verts: number[] = [];
  const R = Math.max(0.001, Math.min(r, 0.499));
  const PI2 = Math.PI / 2;

  const push = (px: number, py: number, pz: number, nx: number, ny: number, nz: number) => {
    verts.push(px, py, pz, nx, ny, nz);
  };

  // Emit triangle with auto-corrected winding (CCW facing outward)
  const tri = (
    p0: number[], p1: number[], p2: number[],
    n0: number[], n1: number[], n2: number[],
  ) => {
    const e1x = p1[0]-p0[0], e1y = p1[1]-p0[1], e1z = p1[2]-p0[2];
    const e2x = p2[0]-p0[0], e2y = p2[1]-p0[1], e2z = p2[2]-p0[2];
    const cx = e1y*e2z - e1z*e2y, cy = e1z*e2x - e1x*e2z, cz = e1x*e2y - e1y*e2x;
    if (cx*n0[0] + cy*n0[1] + cz*n0[2] >= 0) {
      push(p0[0],p0[1],p0[2], n0[0],n0[1],n0[2]);
      push(p1[0],p1[1],p1[2], n1[0],n1[1],n1[2]);
      push(p2[0],p2[1],p2[2], n2[0],n2[1],n2[2]);
    } else {
      push(p0[0],p0[1],p0[2], n0[0],n0[1],n0[2]);
      push(p2[0],p2[1],p2[2], n2[0],n2[1],n2[2]);
      push(p1[0],p1[1],p1[2], n1[0],n1[1],n1[2]);
    }
  };

  const quad = (
    p0: number[], p1: number[], p2: number[], p3: number[],
    n0: number[], n1: number[], n2: number[], n3: number[],
  ) => {
    tri(p0, p1, p2, n0, n1, n2);
    tri(p0, p2, p3, n0, n2, n3);
  };

  const face = (a: number[], b: number[], c: number[], d: number[], n: number[]) => {
    quad(a, b, c, d, n, n, n, n);
  };

  // ── 6 Flat faces (inset by R) ──
  face([R,R,1],[1-R,R,1],[1-R,1-R,1],[R,1-R,1], [0,0,1]);
  face([1-R,R,0],[R,R,0],[R,1-R,0],[1-R,1-R,0], [0,0,-1]);
  face([1,R,1-R],[1,R,R],[1,1-R,R],[1,1-R,1-R], [1,0,0]);
  face([0,R,R],[0,R,1-R],[0,1-R,1-R],[0,1-R,R], [-1,0,0]);
  face([R,1,1-R],[R,1,R],[1-R,1,R],[1-R,1,1-R], [0,1,0]);
  face([R,0,R],[R,0,1-R],[1-R,0,1-R],[1-R,0,R], [0,-1,0]);

  // ── 12 Edges (quarter-cylinder strips) ──
  // axis: 0=X, 1=Y, 2=Z — the direction the edge runs along
  // sa, sb: signs (0 or 1) for the two perpendicular axes
  for (let axis = 0; axis < 3; axis++) {
    const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3; // perpendicular axes
    for (const [sa, sb] of [[0,0],[0,1],[1,0],[1,1]]) {
      const ca = sa ? 1-R : R, cb = sb ? 1-R : R;
      const da = sa ? 1 : -1, db = sb ? 1 : -1;
      for (let i = 0; i < segs; i++) {
        const t0 = (i/segs)*PI2, t1 = ((i+1)/segs)*PI2;
        const c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
        // Build position/normal with the arc on the two perpendicular axes
        const mkPt = (c: number, s: number, along: number): number[] => {
          const p = [0,0,0]; p[axis] = along; p[a1] = ca+R*da*c; p[a2] = cb+R*db*s;
          return p;
        };
        const mkN = (c: number, s: number): number[] => {
          const n = [0,0,0]; n[a1] = da*c; n[a2] = db*s;
          return n;
        };
        quad(
          mkPt(c0,s0,R), mkPt(c0,s0,1-R), mkPt(c1,s1,1-R), mkPt(c1,s1,R),
          mkN(c0,s0), mkN(c0,s0), mkN(c1,s1), mkN(c1,s1),
        );
      }
    }
  }

  // ── 8 Corners (1/8 sphere patches) ──
  for (const sx of [0, 1]) for (const sy of [0, 1]) for (const sz of [0, 1]) {
    const cx = sx ? 1-R : R, cy = sy ? 1-R : R, cz = sz ? 1-R : R;
    const dx = sx ? 1 : -1, dy = sy ? 1 : -1, dz = sz ? 1 : -1;
    for (let i = 0; i < segs; i++) {
      const phi0 = (i/segs)*PI2, phi1 = ((i+1)/segs)*PI2;
      const sp0 = Math.sin(phi0), cp0 = Math.cos(phi0);
      const sp1 = Math.sin(phi1), cp1 = Math.cos(phi1);
      for (let j = 0; j < segs; j++) {
        const th0 = (j/segs)*PI2, th1 = ((j+1)/segs)*PI2;
        const st0 = Math.sin(th0), ct0 = Math.cos(th0);
        const st1 = Math.sin(th1), ct1 = Math.cos(th1);
        const pt = (sp: number, cp: number, st: number, ct: number): [number[], number[]] => {
          const nx = dx*ct*sp, ny = dy*st*sp, nz = dz*cp;
          return [[cx+R*nx, cy+R*ny, cz+R*nz], [nx, ny, nz]];
        };
        const [p00,n00] = pt(sp0,cp0,st0,ct0);
        const [p10,n10] = pt(sp1,cp1,st0,ct0);
        const [p11,n11] = pt(sp1,cp1,st1,ct1);
        const [p01,n01] = pt(sp0,cp0,st1,ct1);
        tri(p00, p10, p11, n00, n10, n11);
        tri(p00, p11, p01, n00, n11, n01);
      }
    }
  }

  return new Float32Array(verts);
}

// Cache rounded cube geometry by quantized radius (0.01 precision)
export const roundedCubeCache = new Map<number, Float32Array>();
export function getRoundedCubeVerts(borderRadius: number): Float32Array {
  const key = Math.round(Math.max(0.01, Math.min(borderRadius, 0.499)) * 100);
  let geo = roundedCubeCache.get(key);
  if (!geo) {
    geo = generateRoundedCube(key / 100, 4);
    roundedCubeCache.set(key, geo);
  }
  return geo;
}

// ─── Shape lookup table ─────────────────────────────────────────────────────
// Maps meta.type to [3D geometry, flat geometry]
export const SHAPE_3D: Record<string, Float32Array> = {
  quad: CUBE_VERTS,
  circle: CYLINDER_VERTS,
  triangle: CONE_VERTS,
  sphere: SPHERE_VERTS,
  cylinder: CYLINDER_VERTS,
  cone: CONE_VERTS,
  ramp: RAMP_VERTS,
};
export const SHAPE_FLAT: Record<string, Float32Array> = {
  quad: FLAT_QUAD_VERTS,
  circle: FLAT_CIRCLE_VERTS,
  triangle: FLAT_TRI_VERTS,
  sphere: FLAT_CIRCLE_VERTS,
  cylinder: FLAT_CIRCLE_VERTS,
  cone: FLAT_TRI_VERTS,
  ramp: FLAT_TRI_VERTS,
};
