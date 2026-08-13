/**
 * Reduce a value to something an IPC channel can carry, replacing anything it
 * cannot with `null`.
 *
 * `structuredClone` is the exact oracle: it is the same algorithm the channel
 * applies, so whatever survives it will cross. A handful of DOM ops return live
 * elements — `querySelector`, `querySelectorAll`, `closest` all declare
 * `output: "object"` — and replying with one unsanitized would reject the whole
 * call with an opaque error.
 *
 * Preferred to a deny-list of those keys: a list goes stale as new ops land,
 * while this covers ops nobody has written yet. Recursing one level keeps the
 * serializable members of a mixed array or object instead of discarding the lot,
 * which is what makes `querySelectorAll` degrade to `[null, null]` rather than
 * failing outright.
 */
export function serializable(value: unknown, depth = 1): unknown {
  const type = typeof value;
  if (type === "function" || type === "symbol") return null;
  // Primitives (including bigint) always cross; skip the clone probe for them.
  if (value === null || type !== "object") return value;

  try {
    structuredClone(value);
    return value;
  } catch {
    if (depth <= 0) return null;
    if (Array.isArray(value)) return value.map((item) => serializable(item, depth - 1));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = serializable(item, depth - 1);
    }
    return out;
  }
}
