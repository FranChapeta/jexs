import { Node, Context, NodeValue } from "./Node.js";
import { resolve, resolveAll } from "../Resolver.js";
import { parseInterval } from "./Timer.js";
import type { JexsNodeSchema } from "../schema.js";

export class DateNode extends Node {
  static schema: JexsNodeSchema = {
    dateNow: {
      type: ["string", "boolean"],
      enum: [
        "ms",
        "iso",
        "datetime",
      ],
      markdownDescription: "Returns the current timestamp. Pass a format string (`\"ms\"`, `\"iso\"`, `\"datetime\"`) or `true` (shorthand for `\"ms\"`).",
      outputDescription: "A **number** (Unix milliseconds) for `ms`/`true`; otherwise a **string**: `iso` → ISO-8601, `datetime` → `YYYY-MM-DD HH:MM:SS` in UTC.",
      examples: [
        "{ \"dateNow\": \"iso\" }",
      ],
    },
    dateAdd: {
      tuple: 2,
      prefixItems: [
        { type: "number", description: "The base Unix-ms timestamp." },
        { type: "string", description: "The interval to add, e.g. `\"500ms\"`, `\"30s\"`, `\"5m\"`, `\"1h\"`, `\"7d\"`." },
      ],
      markdownDescription: "Adds a duration to a Unix-ms timestamp. Interval formats: `\"500ms\"`, `\"30s\"`, `\"5m\"`, `\"1h\"`, `\"7d\"`.",
      outputDescription: "The shifted timestamp in the `format` (default `ms`): a **number** for `ms`, else a formatted **string**. `null` if fewer than two args are given.",
      examples: [
        "{ \"dateAdd\": [{ \"dateNow\": \"ms\" }, \"7d\"], \"format\": \"iso\" }",
      ],
      siblings: {
        format: {
          type: "string",
          enum: [
            "ms",
            "iso",
            "datetime",
          ],
          description: "Output format (default `\"ms\"`).",
        },
      },
    },
    dateFormat: {
      markdownDescription: "Formats a Unix-ms timestamp.",
      outputDescription: "The timestamp in the `format` (default `datetime`): a **number** for `ms`, otherwise a formatted **string** (`iso` or `datetime` UTC).",
      examples: [
        "{ \"dateFormat\": { \"var\": \"$createdAt\" }, \"format\": \"iso\" }",
      ],
      siblings: {
        format: {
          type: "string",
          enum: [
            "ms",
            "iso",
            "datetime",
          ],
          description: "Output format (default `\"datetime\"`).",
        },
      },
    },
    dateParse: {
      output: "number",
      markdownDescription: "Parses a date string into a Unix-ms timestamp, the inverse of `dateFormat`. Accepts anything `Date.parse` understands (ISO-8601 recommended). A number passes through unchanged.",
      outputDescription: "A **number** (Unix milliseconds), or `null` if the value cannot be parsed.",
      examples: [
        "{ \"dateParse\": \"2026-07-01T12:00:00Z\" }",
      ],
    },
    dateDiff: {
      tuple: 2,
      prefixItems: [
        { type: "number", description: "The `from` Unix-ms timestamp." },
        { type: "number", description: "The `to` Unix-ms timestamp." },
      ],
      output: "number",
      markdownDescription: "Difference between two Unix-ms timestamps as `[from, to]`, in whole `unit`s (default `ms`). Positive when `to` is later than `from`. Units are fixed-length: `\"ms\"`, `\"second\"`, `\"minute\"`, `\"hour\"`, `\"day\"`, `\"week\"` (calendar months/years are not supported; extract parts with `datePart`).",
      outputDescription: "A **number** of whole units, truncated toward zero and signed. `null` if fewer than two args are given or the unit is unknown.",
      examples: [
        "{ \"dateDiff\": [{ \"var\": \"$start\" }, { \"var\": \"$end\" }], \"unit\": \"day\" }",
      ],
      siblings: {
        unit: {
          type: "string",
          enum: [
            "ms",
            "second",
            "minute",
            "hour",
            "day",
            "week",
          ],
          description: "Unit of the result (default `\"ms\"`).",
        },
      },
    },
    datePart: {
      output: "number",
      markdownDescription: "Extracts a single component from a Unix-ms timestamp, in UTC. Choose the component with the `part` sibling.",
      outputDescription: "A **number**: `month` is 1-12, `day` is 1-31, `weekday` is 0-6 (0 = Sunday). `null` if `part` is missing or unknown.",
      examples: [
        "{ \"datePart\": { \"var\": \"$ts\" }, \"part\": \"weekday\" }",
      ],
      siblings: {
        part: {
          type: "string",
          enum: [
            "year",
            "month",
            "day",
            "hour",
            "minute",
            "second",
            "ms",
            "weekday",
          ],
          description: "Component to extract (required).",
        },
      },
    },
    dateStartOf: {
      markdownDescription: "Snaps a Unix-ms timestamp down to the start of a `unit` (default `\"day\"`), in UTC. Weeks start on Monday (ISO-8601).",
      outputDescription: "The boundary timestamp in the `format` (default `ms`): a **number** for `ms`, else a formatted **string**.",
      examples: [
        "{ \"dateStartOf\": { \"var\": \"$ts\" }, \"unit\": \"month\", \"format\": \"iso\" }",
      ],
      siblings: {
        unit: {
          type: "string",
          enum: [
            "second",
            "minute",
            "hour",
            "day",
            "week",
            "month",
            "year",
          ],
          description: "Boundary unit (default `\"day\"`).",
        },
        format: {
          type: "string",
          enum: [
            "ms",
            "iso",
            "datetime",
          ],
          description: "Output format (default `\"ms\"`).",
        },
      },
    },
    dateEndOf: {
      markdownDescription: "Snaps a Unix-ms timestamp up to the last millisecond of a `unit` (default `\"day\"`), in UTC. Weeks start on Monday (ISO-8601).",
      outputDescription: "The boundary timestamp in the `format` (default `ms`): a **number** for `ms`, else a formatted **string**.",
      examples: [
        "{ \"dateEndOf\": { \"var\": \"$ts\" }, \"unit\": \"day\" }",
      ],
      siblings: {
        unit: {
          type: "string",
          enum: [
            "second",
            "minute",
            "hour",
            "day",
            "week",
            "month",
            "year",
          ],
          description: "Boundary unit (default `\"day\"`).",
        },
        format: {
          type: "string",
          enum: [
            "ms",
            "iso",
            "datetime",
          ],
          description: "Output format (default `\"ms\"`).",
        },
      },
    },
    dateRelative: {
      tuple: [
        1,
        2,
      ],
      prefixItems: [
        { type: "number", description: "The `target` Unix-ms timestamp to phrase." },
        { type: "number", description: "The `base` Unix-ms timestamp to phrase against (defaults to now)." },
      ],
      output: "string",
      markdownDescription: "Formats a Unix-ms timestamp as a locale-aware relative-time string via `Intl.RelativeTimeFormat`. Tuple form `[target, base]`: `target` is phrased relative to `base`, which defaults to now (matching date-fns `intlFormatDistance` and moment `.from()`). Auto-selects the largest fitting unit (second through year) unless `unit` forces one; month and year use approximate 30-day / 365-day lengths, so long spans are rounded.",
      outputDescription: "A **string** like `\"3 hours ago\"` or `\"in 5 minutes\"`. A past `target` reads \"... ago\", a future one \"in ...\".",
      examples: [
        "{ \"dateRelative\": [{ \"var\": \"$createdAt\" }] }",
        "{ \"dateRelative\": [{ \"var\": \"$ts\" }, { \"var\": \"$now\" }], \"style\": \"short\" }",
      ],
      siblings: {
        unit: {
          type: "string",
          enum: [
            "second",
            "minute",
            "hour",
            "day",
            "week",
            "month",
            "year",
          ],
          description: "Force the display unit instead of auto-selecting the largest fitting one.",
        },
        locale: {
          type: "string",
          description: "BCP-47 locale tag (default: the runtime locale).",
        },
        numeric: {
          type: "string",
          enum: [
            "always",
            "auto",
          ],
          description: "`\"always\"` (default, e.g. \"1 day ago\") or `\"auto\"` (uses \"yesterday\"/\"tomorrow\" where available).",
        },
        style: {
          type: "string",
          enum: [
            "long",
            "short",
            "narrow",
          ],
          description: "Length of the phrasing (default `\"long\"`).",
        },
      },
    },
  };

  dateNow(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.dateNow, context, fmt =>
      formatDate(Date.now(), fmt === true ? "ms" : String(fmt))
    );
  }

  dateAdd(def: Record<string, unknown>, context: Context): NodeValue {
    const args = this.toArray(def.dateAdd);
    if (args.length < 2) return null;
    return resolve(def.dateAdd, context, resolvedArgs => {
      const a = this.toArray(resolvedArgs);
      const base = this.toNumber(a[0]);
      const interval = String(a[1]);
      const result = base + parseInterval(interval);
      return emitDate(result, def, context, "ms");
    });
  }

  dateFormat(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.dateFormat, context, ms =>
      emitDate(this.toNumber(ms), def, context, "datetime")
    );
  }

  dateParse(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.dateParse, context, v => {
      if (typeof v === "number") return v;
      const ms = Date.parse(String(v));
      return Number.isNaN(ms) ? null : ms;
    });
  }

  dateDiff(def: Record<string, unknown>, context: Context): NodeValue {
    const args = this.toArray(def.dateDiff);
    if (args.length < 2) return null;
    return resolve(def.dateDiff, context, resolvedArgs => {
      const a = this.toArray(resolvedArgs);
      const from = this.toNumber(a[0]);
      const to = this.toNumber(a[1]);
      if (!def.unit) return diff(from, to, "ms");
      return resolve(def.unit, context, u => diff(from, to, String(u)));
    });
  }

  datePart(def: Record<string, unknown>, context: Context): NodeValue {
    if (def.part == null) return null;
    return resolve(def.datePart, context, ts =>
      resolve(def.part, context, part => extractPart(this.toNumber(ts), String(part)))
    );
  }

  dateStartOf(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.dateStartOf, context, ts => {
      const base = this.toNumber(ts);
      if (!def.unit) return emitDate(boundary(base, "day", false), def, context, "ms");
      return resolve(def.unit, context, u =>
        emitDate(boundary(base, String(u), false), def, context, "ms")
      );
    });
  }

  dateEndOf(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.dateEndOf, context, ts => {
      const base = this.toNumber(ts);
      if (!def.unit) return emitDate(boundary(base, "day", true), def, context, "ms");
      return resolve(def.unit, context, u =>
        emitDate(boundary(base, String(u), true), def, context, "ms")
      );
    });
  }

  dateRelative(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.dateRelative, def.unit, def.locale, def.numeric, def.style], context,
      ([args, unitRaw, locale, numeric, style]) => {
        const a = this.toArray(args);
        const base = a.length > 1 && a[1] != null ? this.toNumber(a[1]) : Date.now();
        const deltaSec = (this.toNumber(a[0]) - base) / 1000;

        const forced = unitRaw != null ? this.toString(unitRaw) : null;
        let unit: Intl.RelativeTimeFormatUnit;
        let value: number;
        if (forced && forced in REL_UNIT_SEC) {
          unit = forced as Intl.RelativeTimeFormatUnit;
          value = deltaSec / REL_UNIT_SEC[forced];
        } else {
          ({ unit, value } = pickRelUnit(deltaSec));
        }

        const opts: Intl.RelativeTimeFormatOptions = {};
        if (numeric != null) opts.numeric = this.toString(numeric) as Intl.RelativeTimeFormatNumeric;
        if (style != null) opts.style = this.toString(style) as Intl.RelativeTimeFormatStyle;
        const rtf = new Intl.RelativeTimeFormat(locale != null ? this.toString(locale) : undefined, opts);
        return rtf.format(Math.round(value), unit);
      });
  }

  /** Emit a computed timestamp through the `format` sibling (or a default). */
}

function emitDate(ms: number | null, def: Record<string, unknown>, context: Context, fallback: string): NodeValue {
  if (ms === null) return null;
  if (!def.format) return formatDate(ms, fallback);
  return resolve(def.format, context, fmt => formatDate(ms, String(fmt)));
}

function formatDate(ms: number, format: string): string | number {
  if (format === "ms") return ms;
  const d = new Date(ms);
  if (format === "iso") return d.toISOString();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// Fixed-length units in milliseconds (matches the `unit` enum). Calendar
// months/years are intentionally excluded — their length varies, so `dateDiff`
// stays a pure division.
const UNIT_MS: Record<string, number> = {
  ms: 1, second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000,
};

const DAY_MS = 86_400_000;

// Seconds per unit for relative-time formatting. Month/year are approximate
// (30-day / 365-day) — documented on `dateRelative`. Ordered largest-first so
// pickRelUnit selects the biggest unit the delta clears.
const REL_UNIT_SEC: Record<string, number> = {
  year: 31_536_000, month: 2_592_000, week: 604_800,
  day: 86_400, hour: 3_600, minute: 60, second: 1,
};

/** Choose the largest relative-time unit whose length the delta reaches, and
 *  express the (signed) delta in that unit. Sub-second deltas fall back to seconds. */
function pickRelUnit(deltaSec: number): { unit: Intl.RelativeTimeFormatUnit; value: number } {
  const abs = Math.abs(deltaSec);
  for (const unit of Object.keys(REL_UNIT_SEC) as Intl.RelativeTimeFormatUnit[]) {
    const sec = REL_UNIT_SEC[unit];
    if (abs >= sec) return { unit, value: deltaSec / sec };
  }
  return { unit: "second", value: deltaSec };
}

function diff(from: number, to: number, unit: string): number | null {
  const ms = UNIT_MS[unit];
  if (!ms) return null;
  return Math.trunc((to - from) / ms);
}

function extractPart(ms: number, part: string): number | null {
  const d = new Date(ms);
  switch (part) {
    case "year": return d.getUTCFullYear();
    case "month": return d.getUTCMonth() + 1;
    case "day": return d.getUTCDate();
    case "hour": return d.getUTCHours();
    case "minute": return d.getUTCMinutes();
    case "second": return d.getUTCSeconds();
    case "ms": return d.getUTCMilliseconds();
    case "weekday": return d.getUTCDay();
    default: return null;
  }
}

/** Start (or end) boundary of the UTC calendar unit containing `ms`. */
function boundary(ms: number, unit: string, end: boolean): number | null {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth();
  const da = d.getUTCDate();
  const h = d.getUTCHours();
  const mi = d.getUTCMinutes();
  const s = d.getUTCSeconds();

  switch (unit) {
    case "year":
      return end ? Date.UTC(y + 1, 0, 1) - 1 : Date.UTC(y, 0, 1);
    case "month":
      return end ? Date.UTC(y, mo + 1, 1) - 1 : Date.UTC(y, mo, 1);
    case "week": {
      // Monday-start (ISO): getUTCDay is 0=Sun..6=Sat.
      const start = Date.UTC(y, mo, da) - ((d.getUTCDay() + 6) % 7) * DAY_MS;
      return end ? start + 7 * DAY_MS - 1 : start;
    }
    case "day": {
      const start = Date.UTC(y, mo, da);
      return end ? start + DAY_MS - 1 : start;
    }
    case "hour": {
      const start = Date.UTC(y, mo, da, h);
      return end ? start + 3_600_000 - 1 : start;
    }
    case "minute": {
      const start = Date.UTC(y, mo, da, h, mi);
      return end ? start + 60_000 - 1 : start;
    }
    case "second": {
      const start = Date.UTC(y, mo, da, h, mi, s);
      return end ? start + 1000 - 1 : start;
    }
    default: return null;
  }
}
