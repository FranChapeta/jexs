import { createHttpError } from "./errors.js";
import { isObject } from "./helpers.js";

/** Bytes a file's type is read from: enough for every signature below. */
export const SNIFF_BYTES = 16;

/** The bytes from `start` up to `end`, as the Latin-1 text they are. */
function text(b: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...b.subarray(start, end));
}

/** Whether `b` begins with `bytes`. */
function begins(b: Uint8Array, bytes: number[]): boolean {
  return bytes.every((byte, i) => b[i] === byte);
}

/** Formats a file's first bytes show, by media type. */
const SIGNATURES: Array<[type: string, test: (b: Uint8Array) => boolean]> = [
  ["image/png", b => begins(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ["image/jpeg", b => begins(b, [0xff, 0xd8, 0xff])],
  ["image/gif", b => ["GIF87a", "GIF89a"].includes(text(b, 0, 6))],
  ["image/webp", b => text(b, 0, 4) === "RIFF" && text(b, 8, 12) === "WEBP"],
  ["image/avif", b => text(b, 4, 8) === "ftyp" && ["avif", "avis"].includes(text(b, 8, 12))],
  ["image/heic", b => text(b, 4, 8) === "ftyp" && ["heic", "heix"].includes(text(b, 8, 12))],
  ["image/heif", b => text(b, 4, 8) === "ftyp" && ["mif1", "msf1"].includes(text(b, 8, 12))],
  ["image/tiff", b => ["II*\0", "MM\0*"].includes(text(b, 0, 4))],
  // "BM" alone starts plenty of text; a bitmap's reserved bytes 6 to 9 are zero.
  ["image/bmp", b => text(b, 0, 2) === "BM" && b.length >= 10 && begins(b.subarray(6), [0, 0, 0, 0])],
  ["image/x-icon", b => b.length >= 4 && begins(b, [0, 0, 1, 0])],
  ["application/pdf", b => text(b, 0, 5) === "%PDF-"],
  ["application/zip", b => begins(b, [0x50, 0x4b]) && (b[2] === 3 || b[2] === 5) && (b[3] === 4 || b[3] === 6)],
  ["application/gzip", b => begins(b, [0x1f, 0x8b])],
  ["audio/wav", b => text(b, 0, 4) === "RIFF" && text(b, 8, 12) === "WAVE"],
  ["audio/ogg", b => text(b, 0, 4) === "OggS"],
  ["audio/flac", b => text(b, 0, 4) === "fLaC"],
  // A frame of layer II or III: layer I's `FF FE` is also UTF-16's byte order mark.
  ["audio/mpeg", b => text(b, 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && [0x02, 0x04].includes(b[1] & 0x06))],
  ["audio/mp4", b => text(b, 4, 8) === "ftyp" && text(b, 8, 12) === "M4A "],
  ["video/quicktime", b => text(b, 4, 8) === "ftyp" && text(b, 8, 12) === "qt  "],
  ["video/mp4", b => text(b, 4, 8) === "ftyp"],
  ["video/webm", b => begins(b, [0x1a, 0x45, 0xdf, 0xa3])],
  ["font/woff", b => text(b, 0, 4) === "wOFF"],
  ["font/woff2", b => text(b, 0, 4) === "wOF2"],
  // A DOS header holds zero bytes, which text doesn't.
  ["application/x-msdownload", b => text(b, 0, 2) === "MZ" && b.subarray(2).includes(0)],
  ["application/x-executable", b => begins(b, [0x7f, 0x45, 0x4c, 0x46])],
];

/**
 * Formats whose first bytes are a container's, by the type those bytes show: a
 * ZIP holds an office document, a WebM a sound recording as well as a video.
 * The bytes can't tell them apart, so the type a file claimed does.
 */
const SAME_BYTES: Record<string, Set<string>> = {
  "application/zip": new Set([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.presentation",
    "application/epub+zip",
    "application/java-archive",
  ]),
  "video/webm": new Set(["audio/webm", "video/x-matroska", "audio/x-matroska"]),
  "video/mp4": new Set(["audio/mp4", "audio/x-m4a", "video/x-m4v", "video/quicktime", "video/3gpp", "audio/3gpp", "video/3gpp2", "audio/3gpp2"]),
  "image/heif": new Set(["image/heic", "image/avif"]),
  "audio/ogg": new Set(["video/ogg", "application/ogg"]),
};
const SNIFFED = new Set([...SIGNATURES.map(([type]) => type), ...Object.values(SAME_BYTES).flatMap(types => [...types])]);

/** Media types by file extension, for a file whose first bytes show none. */
const EXTENSION_TYPES: Record<string, string> = {
  txt: "text/plain", log: "text/plain", html: "text/html", htm: "text/html", css: "text/css", csv: "text/csv",
  md: "text/markdown", xml: "application/xml", js: "application/javascript", mjs: "application/javascript",
  json: "application/json", map: "application/json", yaml: "application/yaml", yml: "application/yaml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff",
  pdf: "application/pdf", zip: "application/zip", gz: "application/gzip", wasm: "application/wasm",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  glb: "model/gltf-binary", gltf: "model/gltf+json", bin: "application/octet-stream",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  epub: "application/epub+zip",
};

/** The media type a file's name says it is, by its extension (`"report.pdf"`, `".pdf"`); undefined for one not known. */
export function typeOfName(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? undefined : EXTENSION_TYPES[name.slice(dot + 1).toLowerCase()];
}

/** Types that can hold scripts, which a wildcard such as `image/*` doesn't take: only naming them does. */
const SCRIPTABLE = new Set(["image/svg+xml"]);

/**
 * The format a file's first bytes show, or undefined. Where they show a
 * container, the type it `claimed` narrows it to one of the formats that
 * container holds.
 */
export function detectType(bytes: Uint8Array, claimed: string): string | undefined {
  const detected = SIGNATURES.find(([, test]) => test(bytes))?.[0];
  return detected !== undefined && SAME_BYTES[detected]?.has(claimed) ? claimed : detected;
}

/** Whether `type` is one of `types`, where `image/*` takes any image but SVG and `*\/*` anything. */
export function typeMatches(types: string[], type: string): boolean {
  return types.some(t => t === type || t === "*/*" || (t.endsWith("/*") && !SCRIPTABLE.has(type) && type.startsWith(t.slice(0, -1))));
}

/**
 * The type a file is taken as, or a 415 when `types` is given and it isn't
 * one of them. Where its first bytes show a known format, that format is its
 * type, whatever was `claimed`; where they don't, the claim is taken, unless it
 * names a format whose bytes would have shown (a "PNG" that isn't one).
 * `label` names the file in the error.
 */
export function acceptType(head: Uint8Array, claimed: string, types: string[] | undefined, label: string): string {
  const detected = detectType(head, claimed);
  const type = detected ?? (claimed || "application/octet-stream");
  if (types === undefined || (typeMatches(types, type) && (detected !== undefined || !SNIFFED.has(type)))) return type;
  throw createHttpError(415, `${label} takes ${types.join(", ")}, not ${detected ?? `a file that says it is ${type}`}`);
}

/** What a blob or file may be: wherever it comes from, an upload, a download or a disk. */
export interface BlobRule {
  /** Media types it may be (`"image/png"`, `"image/*"`); any when absent. */
  types?: string[];
  /** Its largest size in bytes. */
  maxSize: number;
}

/**
 * A rule as written (`{ types, maxSize }`), checked. `where` names it in an
 * error, and `maxSize` is `fallback` when the rule gives none.
 */
export function blobRule(where: string, written: unknown, fallback = Infinity): BlobRule {
  const rule = written ?? {};
  if (!isObject(rule)) throw new Error(`${where}: its rules must be an object`);
  let types: string[] | undefined;
  if (rule.types !== undefined && rule.types !== null) {
    if (!Array.isArray(rule.types) || !rule.types.every(t => typeof t === "string")) throw new Error(`${where}: types must be a list of media types`);
    types = rule.types;
  }
  return { types, maxSize: positiveInteger(where, "maxSize", rule.maxSize, fallback) };
}

/** A count or size as written, checked: a positive whole number, or `fallback` when none is given. */
export function positiveInteger(where: string, name: string, value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${where}: ${name} ${JSON.stringify(value)} is not a positive whole number`);
  return n;
}
