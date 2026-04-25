import { Node, Context, NodeValue } from "./Node.js";
import { resolve } from "../Resolver.js";
import { parseInterval } from "./Timer.js";

export class DateNode extends Node {
  /**
   * Returns the current timestamp.
   *
   * @param {"ms"|"iso"|"datetime"} dateNow Output format: `"ms"` for Unix milliseconds, `"iso"` for ISO 8601, `"datetime"` for UTC `YYYY-MM-DD HH:MM:SS` (default).
   * @example
   * { "dateNow": "iso" }
   */
  dateNow(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.dateNow, context, fmt =>
      formatDate(Date.now(), fmt === true ? "ms" : String(fmt))
    );
  }

  /**
   * Adds a duration to a Unix-ms timestamp. Interval formats: `"500ms"`, `"30s"`, `"5m"`, `"1h"`, `"7d"`.
   *
   * @param {[2]} dateAdd `[timestamp, interval]`.
   * @param {"ms"|"iso"|"datetime"} format Output format (default `"ms"`).
   * @example
   * { "dateAdd": [{ "dateNow": "ms" }, "7d"], "format": "iso" }
   */
  dateAdd(def: Record<string, unknown>, context: Context): NodeValue {
    const args = this.toArray(def.dateAdd);
    if (args.length < 2) return null;
    return resolve(def.dateAdd, context, resolvedArgs => {
      const a = this.toArray(resolvedArgs);
      const base = this.toNumber(a[0]);
      const interval = String(a[1]);
      const result = base + parseInterval(interval);
      if (!def.format) return formatDate(result, "ms");
      return resolve(def.format, context, fmt => formatDate(result, String(fmt)));
    });
  }

  /**
   * Formats a Unix-ms timestamp.
   *
   * @param {expr} dateFormat The Unix-ms timestamp to format.
   * @param {"ms"|"iso"|"datetime"} format Output format (default `"datetime"`).
   * @example
   * { "dateFormat": { "var": "$createdAt" }, "format": "iso" }
   */
  dateFormat(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.dateFormat, context, ms => {
      if (!def.format) return formatDate(this.toNumber(ms), "datetime");
      return resolve(def.format, context, fmt => formatDate(this.toNumber(ms), String(fmt)));
    });
  }
}

function formatDate(ms: number, format: string): string | number {
  if (format === "ms") return ms;
  const d = new Date(ms);
  if (format === "iso") return d.toISOString();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
