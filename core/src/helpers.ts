/**
 * Check if a value is a plain object (not array, null, etc.)
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Check if an array is associative (object-like with string keys)
 */
export function isAssociativeArray(
  value: unknown,
): value is Record<string, unknown> {
  return isObject(value);
}

/**
 * Split a dot-path into its segments, memoized.
 *
 * `getNestedValue` / `setNestedValue` / `Node.setContextValue` run this on the
 * hottest string in the engine — every `{ "var": ... }` lookup and `$x.y`
 * interpolation. Paths come from static templates so their cardinality is
 * bounded; the cap only guards against dynamically built paths. When full we
 * evict the oldest entry (FIFO, via Map insertion order) so a working set a
 * little over the cap degrades gracefully instead of flushing wholesale. We do
 * NOT reorder on hit, so the lookup stays a single `Map.get`.
 *
 * Callers MUST NOT mutate the returned array — it is shared across calls.
 */
const _pathCache = new Map<string, string[]>();
const PATH_CACHE_MAX = 500;

export function splitPath(path: string): string[] {
  let parts = _pathCache.get(path);
  if (parts) return parts;
  parts = path.split(".");
  // size >= MAX guarantees at least one entry, so the oldest key is non-null.
  if (_pathCache.size >= PATH_CACHE_MAX) _pathCache.delete(_pathCache.keys().next().value!);
  _pathCache.set(path, parts);
  return parts;
}

/**
 * Deep get a value from an object using dot notation
 * e.g., getNestedValue(obj, 'user.profile.name')
 */
export function getNestedValue(obj: unknown, path: string): unknown {
  if (!path) return obj;

  const keys = splitPath(path);
  let current: unknown = obj;

  for (const key of keys) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (isObject(current) || Array.isArray(current)) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }

  return current;
}

/**
 * Deep set a value in an object using dot notation
 */
export function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = splitPath(path);
  let current = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!(key in current) || !isObject(current[key])) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }

  current[keys[keys.length - 1]] = value;
}

/**
 * Deep clone an object
 */
export function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => deepClone(item)) as T;
  }

  const cloned: Record<string, unknown> = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      cloned[key] = deepClone((obj as Record<string, unknown>)[key]);
    }
  }

  return cloned as T;
}

/**
 * Deep merge objects
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  ...sources: Partial<T>[]
): T {
  for (const source of sources) {
    if (!isObject(source)) continue;

    for (const key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        const sourceValue = source[key];
        const targetValue = target[key];

        if (isObject(sourceValue) && isObject(targetValue)) {
          target[key] = deepMerge(
            targetValue as Record<string, unknown>,
            sourceValue as Record<string, unknown>,
          ) as T[Extract<keyof T, string>];
        } else {
          target[key] = sourceValue as T[Extract<keyof T, string>];
        }
      }
    }
  }

  return target;
}

/**
 * Escape HTML entities to prevent XSS
 */
const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
// `/g` const: only ever used with String.replace (which resets lastIndex).
// Do not call .test()/.exec() on it — those would advance lastIndex.
const HTML_ESCAPE_RE = /[&<>"']/g;

export function escapeHtml(str: string): string {
  return str.replace(HTML_ESCAPE_RE, (char) => HTML_ENTITIES[char] || char);
}

// Escape a JSON string for safe embedding inside a <script> element. The HTML
// tokenizer ends a <script> at a literal "</script>" regardless of the script's
// `type`, so any "<" in a serialized value could break out (or inject markup).
// These characters never appear in JSON structure — only inside string values —
// so replacing them with their \uXXXX JSON escapes is lossless: a JSON parser
// decodes them back to the originals. U+2028/U+2029 are valid in JSON but are
// line terminators that break inline scripts, so they are escaped too. This is
// the same set used by battle-tested serializers (e.g. Next.js, serialize-js).
// Built via RegExp/charCode so the invisible U+2028/U+2029 chars never appear
// literally in this source. `/g` is only used with String.replace (resets lastIndex).
const SCRIPT_JSON_RE = new RegExp("[<>&\\u2028\\u2029]", "g");

export function escapeScriptJson(json: string): string {
  return json.replace(SCRIPT_JSON_RE, (char) => {
    switch (char.charCodeAt(0)) {
      case 0x3c:
        return "\\u003c";
      case 0x3e:
        return "\\u003e";
      case 0x26:
        return "\\u0026";
      case 0x2028:
        return "\\u2028";
      default:
        return "\\u2029";
    }
  });
}

/**
 * Generate a random string
 */
export function randomString(length: number = 32): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Sleep for a specified number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Walk a value collecting the transferable objects inside it (ArrayBuffer and
 * ImageBitmap — the practically-only transferable types) for a `postMessage`
 * transfer list, so heavy buffers move zero-copy instead of being cloned. The
 * source buffers DETACH on send (the sender can no longer read them) — a
 * hand-off, which is what asset decode wants. A typed array contributes its
 * `.buffer`. Cycles are guarded with a seen-set. Used symmetrically: the worker
 * node scans the outgoing `params`, the worker entry scans the returned result.
 */
export function collectTransferables(value: unknown): Transferable[] {
  const out: Transferable[] = [];
  const seen = new Set<unknown>();
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);
    if (v instanceof ArrayBuffer) { out.push(v); return; }
    if (typeof ImageBitmap !== "undefined" && v instanceof ImageBitmap) { out.push(v); return; }
    if (ArrayBuffer.isView(v)) { out.push((v as ArrayBufferView).buffer as ArrayBuffer); return; }
    if (Array.isArray(v)) { for (const item of v) walk(item); return; }
    for (const key in v) {
      if (Object.prototype.hasOwnProperty.call(v, key)) walk((v as Record<string, unknown>)[key]);
    }
  };
  walk(value);
  return out;
}

/**
 * True if the object has at least one own enumerable key — an allocation-free
 * `Object.keys(obj).length > 0`. The hasOwnProperty guard keeps the same
 * semantics as `Object.keys` (inherited enumerable props don't count), and the
 * loop early-exits on the first own key.
 */
export function hasAnyKey(obj: object): boolean {
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) return true;
  }
  return false;
}

// ── Value coercion ───────────────────────────────────────────────────────────
//
// The rules every node input is read through. Free functions rather than methods
// on Node because none of them touch a node: they are pure, and a node's
// module-scope helpers need them just as much as its handlers do. `Node` exposes
// the same four as protected instance sugar (`this.toNumber(v)`), which is what
// handler bodies use.

/** Coerce to string. Objects and arrays serialize as JSON; null/undefined are "". */
export function toStringValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** Coerce to number. Unparseable input is 0 rather than NaN, so arithmetic on a
 *  missing variable yields a number instead of poisoning the whole expression. */
export function toNumberValue(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const num = parseFloat(value);
    return isNaN(num) ? 0 : num;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  return 0;
}

/**
 * Coerce to boolean. Differs from JS truthiness where a template author would
 * expect it to: `"0"` and `"false"` are falsy (they arrive from query strings and
 * attributes), an empty array or object is falsy, and a DOM node is truthy.
 */
export function toBooleanValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    return value !== "" && value !== "0" && value.toLowerCase() !== "false";
  }
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) {
    if ("nodeType" in value) return true; // DOM nodes are truthy
    return hasAnyKey(value);
  }
  return value !== null && value !== undefined;
}

/** Coerce to array. Wraps a lone value; null/undefined become empty. */
export function toArrayValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

/**
 * Check if a value is empty (null, undefined, empty string, empty array, empty object)
 */
export function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (isObject(value) && !hasAnyKey(value)) return true;
  return false;
}

/**
 * Convert a string to slug format
 */
export function slugify(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Truncate a string to a maximum length
 */
export function truncate(
  str: string,
  maxLength: number,
  suffix: string = "...",
): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - suffix.length) + suffix;
}
