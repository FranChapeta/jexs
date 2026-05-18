/**
 * Quaternion helpers used by mesh import and collision narrowphase.
 */

/**
 * Rotate vector (x,y,z) by unit quaternion (qx,qy,qz,qw).
 * Returns a fresh [x,y,z] tuple.
 */
export function rotateVecByQuat(
  x: number, y: number, z: number,
  qx: number, qy: number, qz: number, qw: number,
): [number, number, number] {
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}
