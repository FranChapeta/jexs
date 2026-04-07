import { Node, Context, NodeValue } from "./Node.js";
import { resolve } from "../Resolver.js";
import { parseInterval } from "./Timer.js";

/**
 * DateNode — date/time utilities for JSON templates.
 *
 * Operations:
 * - { "dateNow": true }                          -> epoch ms (Date.now())
 * - { "dateNow": "iso" }                         -> ISO 8601 string
 * - { "dateNow": "datetime" }                    -> "YYYY-MM-DD HH:MM:SS" (UTC)
 * - { "dateAdd": [base, "1h"] }                  -> base + interval (epoch ms)
 * - { "dateAdd": [base, "1h"], "format": "datetime" } -> formatted
 * - { "dateFormat": epochMs }                    -> "YYYY-MM-DD HH:MM:SS" (UTC)
 * - { "dateFormat": epochMs, "format": "iso" }   -> ISO 8601
 */
export class DateNode extends Node {
  async dateNow(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const fmt = await resolve(def.dateNow, context);
    return formatDate(Date.now(), fmt === true ? "ms" : String(fmt));
  }

  async dateAdd(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const args = this.toArray(def.dateAdd);
    if (args.length < 2) return null;
    const base = this.toNumber(await resolve(args[0], context));
    const interval = String(await resolve(args[1], context));
    const result = base + parseInterval(interval);
    const fmt = def.format ? String(await resolve(def.format, context)) : "ms";
    return formatDate(result, fmt);
  }

  async dateFormat(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const ms = this.toNumber(await resolve(def.dateFormat, context));
    const fmt = def.format ? String(await resolve(def.format, context)) : "datetime";
    return formatDate(ms, fmt);
  }
}

function formatDate(ms: number, format: string): string | number {
  if (format === "ms") return ms;
  const d = new Date(ms);
  if (format === "iso") return d.toISOString();
  // "datetime" — SQL-friendly UTC format
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
