import { Node, Context, NodeValue } from "./Node.js";
import { resolve } from "../Resolver.js";
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
      outputDescription: "A **number** (Unix milliseconds) for `ms`/`true`; otherwise a **string** — `iso` → ISO-8601, `datetime` → `YYYY-MM-DD HH:MM:SS` in UTC.",
      examples: [
        "{ \"dateNow\": \"iso\" }",
      ],
    },
    dateAdd: {
      tuple: 2,
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
      if (!def.format) return formatDate(result, "ms");
      return resolve(def.format, context, fmt => formatDate(result, String(fmt)));
    });
  }

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
