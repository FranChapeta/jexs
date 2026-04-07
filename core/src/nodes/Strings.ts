import { Node, Context } from "./Node.js";
import { resolve } from "../Resolver.js";

/**
 * Handles string operations.
 *
 * Supported operations:
 * - { "concat": ["a", "b", "c"] }       -> "abc"
 * - { "upper": "hello" }                -> "HELLO"
 * - { "lower": "HELLO" }                -> "hello"
 * - { "capitalize": "hello world" }     -> "Hello world"
 * - { "title": "hello world" }          -> "Hello World"
 * - { "trim": "  hello  " }             -> "hello"
 * - { "trimStart": "  hello" }          -> "hello"
 * - { "trimEnd": "hello  " }            -> "hello"
 * - { "substring": ["hello", 0, 3] }    -> "hel"
 * - { "replace": ["hello", "l", "L"] }  -> "heLLo"
 * - { "replaceFirst": ["hello", "l", "L"] } -> "heLlo"
 * - { "split": ["a,b,c", ","] }         -> ["a", "b", "c"]
 * - { "join": [["a", "b"], ", "] }      -> "a, b"
 * - { "padStart": ["5", 3, "0"] }       -> "005"
 * - { "padEnd": ["5", 3, "0"] }         -> "500"
 * - { "repeat": ["ab", 3] }             -> "ababab"
 * - { "length": "hello" }               -> 5
 * - { "startsWith": ["hello", "he"] }   -> true
 * - { "endsWith": ["hello", "lo"] }     -> true
 * - { "contains": ["hello", "ell"] }    -> true
 * - { "stringify": value }               -> JSON string
 * - { "parseJSON": "json" }             -> parsed value
 * - { "slug": "Hello World!" }          -> "hello-world"
 * - { "hash": "password" }              -> "$2b$10$..." (bcrypt hash)
 * - { "verify": ["password", "$2b$..."] } -> true/false (bcrypt compare)
 */
export class StringNode extends Node {
  async concat(def: Record<string, unknown>, context: Context): Promise<string> {
    const parts = this.toArray(def.concat);
    const resolved: unknown[] = [];
    for (const p of parts) {
      resolved.push(await resolve(p, context));
    }
    return resolved.map((r) => this.toString(r)).join("");
  }

  async parseJSON(d: Record<string, unknown>, c: Context) {
    const str = this.toString(await resolve(d.parseJSON, c));
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  }

  async upper(d: Record<string, unknown>, c: Context) {
    return this.toString(await resolve(d.upper, c)).toUpperCase();
  }
  async lower(d: Record<string, unknown>, c: Context) {
    return this.toString(await resolve(d.lower, c)).toLowerCase();
  }

  async capitalize(def: Record<string, unknown>, context: Context): Promise<string> {
    const str = this.toString(await resolve(def.capitalize, context));
    if (str.length === 0) return str;
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
  }

  async title(def: Record<string, unknown>, context: Context): Promise<string> {
    const str = this.toString(await resolve(def.title, context));
    return str.replace(
      /\w\S*/g,
      (txt) => txt.charAt(0).toUpperCase() + txt.slice(1).toLowerCase(),
    );
  }

  async trim(d: Record<string, unknown>, c: Context) {
    return this.toString(await resolve(d.trim, c)).trim();
  }
  async trimStart(d: Record<string, unknown>, c: Context) {
    return this.toString(await resolve(d.trimStart, c)).trimStart();
  }
  async trimEnd(d: Record<string, unknown>, c: Context) {
    return this.toString(await resolve(d.trimEnd, c)).trimEnd();
  }

  async substring(def: Record<string, unknown>, context: Context): Promise<string> {
    const args = this.toArray(def.substring);
    const str = this.toString(await resolve(args[0], context));
    const start = this.toNumber(await resolve(args[1], context));
    const end =
      args.length > 2
        ? this.toNumber(await resolve(args[2], context))
        : undefined;
    return str.substring(start, end);
  }

  async replace(def: Record<string, unknown>, context: Context): Promise<string> {
    return doReplace(def.replace, context, true);
  }
  async replaceFirst(def: Record<string, unknown>, context: Context): Promise<string> {
    return doReplace(def.replaceFirst, context, false);
  }

  async split(def: Record<string, unknown>, context: Context): Promise<string[]> {
    const args = this.toArray(def.split);
    const str = this.toString(await resolve(args[0], context));
    const delimiter =
      args.length > 1 ? this.toString(await resolve(args[1], context)) : "";
    return str.split(delimiter);
  }

  async join(def: Record<string, unknown>, context: Context): Promise<string> {
    const args = this.toArray(def.join);
    const arr = this.toArray(await resolve(args[0], context));
    const delimiter =
      args.length > 1 ? this.toString(await resolve(args[1], context)) : ",";
    return arr.map((v) => this.toString(v)).join(delimiter);
  }

  async padStart(def: Record<string, unknown>, context: Context): Promise<string> {
    return doPad(def.padStart, context, "start");
  }
  async padEnd(def: Record<string, unknown>, context: Context): Promise<string> {
    return doPad(def.padEnd, context, "end");
  }

  async repeat(def: Record<string, unknown>, context: Context): Promise<string> {
    const args = this.toArray(def.repeat);
    const str = this.toString(await resolve(args[0], context));
    const count = Math.max(0, this.toNumber(await resolve(args[1], context)));
    return str.repeat(count);
  }

  async length(d: Record<string, unknown>, c: Context) {
    return this.toString(await resolve(d.length, c)).length;
  }

  async startsWith(def: Record<string, unknown>, context: Context): Promise<boolean> {
    const args = this.toArray(def.startsWith);
    const str = this.toString(await resolve(args[0], context));
    const search = this.toString(await resolve(args[1], context));
    return str.startsWith(search);
  }

  async endsWith(def: Record<string, unknown>, context: Context): Promise<boolean> {
    const args = this.toArray(def.endsWith);
    const str = this.toString(await resolve(args[0], context));
    const search = this.toString(await resolve(args[1], context));
    return str.endsWith(search);
  }

  async contains(def: Record<string, unknown>, context: Context): Promise<boolean> {
    const args = this.toArray(def.contains);
    const str = this.toString(await resolve(args[0], context));
    const search = this.toString(await resolve(args[1], context));
    return str.includes(search);
  }

  async slug(def: Record<string, unknown>, context: Context): Promise<string> {
    const str = this.toString(await resolve(def.slug, context));
    return str
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // Remove diacritics
      .replace(/[^a-z0-9\s-]/g, "") // Remove special chars
      .replace(/\s+/g, "-") // Replace spaces with -
      .replace(/-+/g, "-") // Replace multiple - with single -
      .replace(/^-|-$/g, ""); // Trim - from ends
  }

  async stringify(def: Record<string, unknown>, context: Context): Promise<string> {
    const arg = def.stringify;
    if (Array.isArray(arg)) {
      const resolved: unknown[] = [];
      for (const a of arg) {
        resolved.push(await resolve(a, context));
      }
      const indent = resolved.length > 1 ? Number(resolved[1]) || 0 : 0;
      return JSON.stringify(resolved[0], null, indent || undefined);
    }
    const val = await resolve(arg, context);
    return JSON.stringify(val);
  }
}

async function doReplace(operand: unknown, context: Context, all: boolean): Promise<string> {
  const args = Array.isArray(operand) ? operand : operand != null ? [operand] : [];
  if (args.length < 3) return "";
  const str = String(await resolve(args[0], context) ?? "");
  const search = String(await resolve(args[1], context) ?? "");
  const replacement = String(await resolve(args[2], context) ?? "");
  return all ? str.split(search).join(replacement) : str.replace(search, replacement);
}

async function doPad(operand: unknown, context: Context, side: "start" | "end"): Promise<string> {
  const args = Array.isArray(operand) ? operand : operand != null ? [operand] : [];
  const str = String(await resolve(args[0], context) ?? "");
  const length = Number(await resolve(args[1], context)) || 0;
  const padChar = args.length > 2 ? String(await resolve(args[2], context) ?? "") : " ";
  return side === "start" ? str.padStart(length, padChar) : str.padEnd(length, padChar);
}
