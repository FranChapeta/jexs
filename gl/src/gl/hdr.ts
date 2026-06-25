/**
 * Radiance .hdr (RGBE) decoder — pure JS, no dependency. Produces float RGB pixel
 * data for an HDR environment map (equirectangular), usable as a `gl.FLOAT`
 * texture for a skybox / IBL source.
 *
 * RGBE packs an HDR pixel as 4 bytes (r,g,b,e): the shared exponent `e` scales
 * the mantissas, so values can far exceed 1.0 (real light intensities). We expand
 * to 3 floats per pixel. Supports the run-length-encoded ("new RLE") scanline
 * format that almost all .hdr files use, plus the flat fallback.
 *
 * EXR is a heavier format (compressed half-float) — it is provided separately via
 * a lazily-loaded decoder (`setExrLoader`), keeping this dependency-free.
 */

export interface HdrImage {
  width: number;
  height: number;
  /** RGB float pixels, row-major top-to-bottom, 3 per pixel. */
  data: Float32Array;
}

/** Decode a Radiance .hdr (RGBE) file from its bytes. Throws on malformed input. */
export function decodeHdr(bytes: Uint8Array): HdrImage {
  let pos = 0;

  // ── Header: ASCII lines until a blank line, then the resolution line. ──
  const readLine = (): string => {
    let s = "";
    while (pos < bytes.length) {
      const c = bytes[pos++];
      if (c === 0x0a) break; // \n
      s += String.fromCharCode(c);
    }
    return s;
  };

  const magic = readLine();
  if (!magic.startsWith("#?")) throw new Error("decodeHdr: not a Radiance .hdr file");
  // Skip header lines (FORMAT=..., EXPOSURE=..., comments) until the blank line.
  for (;;) {
    const line = readLine();
    if (line === "") break;
    if (pos >= bytes.length) throw new Error("decodeHdr: unexpected EOF in header");
  }

  // Resolution line, e.g. "-Y 512 +X 1024". We support the common "-Y h +X w".
  const res = readLine().trim().split(/\s+/);
  if (res.length !== 4) throw new Error(`decodeHdr: bad resolution line "${res.join(" ")}"`);
  const height = Number(res[1]);
  const width = Number(res[3]);
  if (!(width > 0 && height > 0)) throw new Error("decodeHdr: invalid dimensions");

  const data = new Float32Array(width * height * 3);
  const scanline = new Uint8Array(width * 4);

  for (let y = 0; y < height; y++) {
    readScanline(bytes, pos, width, scanline);
    pos = _scanlineEnd;
    for (let x = 0; x < width; x++) {
      const i = x * 4;
      const e = scanline[i + 3];
      const o = (y * width + x) * 3;
      if (e === 0) { data[o] = data[o + 1] = data[o + 2] = 0; continue; }
      // RGBE -> float: mantissa * 2^(e-128-8)
      const f = Math.pow(2, e - 136); // -128 - 8
      data[o]     = scanline[i]     * f;
      data[o + 1] = scanline[i + 1] * f;
      data[o + 2] = scanline[i + 2] * f;
    }
  }

  return { width, height, data };
}

// Tracks where the last scanline read ended (avoids returning a tuple per call).
let _scanlineEnd = 0;

/** Read one scanline (width*4 RGBE bytes) into `out`, handling new-RLE + flat. */
function readScanline(bytes: Uint8Array, start: number, width: number, out: Uint8Array): void {
  let p = start;
  // New-RLE header: 0x02 0x02, then width as big-endian 16-bit.
  if (width >= 8 && width < 0x8000 && bytes[p] === 2 && bytes[p + 1] === 2 &&
      ((bytes[p + 2] << 8) | bytes[p + 3]) === width) {
    p += 4;
    // Four channels (R,G,B,E), each RLE-encoded across the whole scanline.
    for (let ch = 0; ch < 4; ch++) {
      let x = 0;
      while (x < width) {
        let count = bytes[p++];
        if (count > 128) {
          // Run: (count-128) copies of the next byte.
          const val = bytes[p++];
          count -= 128;
          while (count-- > 0) out[(x++) * 4 + ch] = val;
        } else {
          // Literal: `count` raw bytes.
          while (count-- > 0) out[(x++) * 4 + ch] = bytes[p++];
        }
      }
    }
    _scanlineEnd = p;
    return;
  }
  // Flat (old/uncompressed): width RGBE quads back to back.
  for (let x = 0; x < width; x++) {
    out[x * 4]     = bytes[p++];
    out[x * 4 + 1] = bytes[p++];
    out[x * 4 + 2] = bytes[p++];
    out[x * 4 + 3] = bytes[p++];
  }
  _scanlineEnd = p;
}
