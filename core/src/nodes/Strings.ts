import { Node, Context } from "./Node.js";
import { resolve } from "../Resolver.js";

export class StringNode extends Node {
  /**
   * Joins an array of values into a single string.
   *
   * @param {(string|expr)[]} concat Values to concatenate.
   * @example
   * { "concat": ["Hello, ", { "var": "$name" }, "!"] }
   */
  concat(def: Record<string, unknown>, c: Context) {
    return resolve(def.concat, c, parts =>
      this.toArray(parts).map(p => this.toString(p)).join("")
    );
  }

  /** Converts a string to uppercase. @example { "upper": { "var": "$name" } } */
  upper(d: Record<string, unknown>, c: Context) {
    return resolve(d.upper, c, v => this.toString(v).toUpperCase());
  }

  /** Converts a string to lowercase. @example { "lower": { "var": "$name" } } */
  lower(d: Record<string, unknown>, c: Context) {
    return resolve(d.lower, c, v => this.toString(v).toLowerCase());
  }

  /** Uppercases the first character, lowercases the rest. @example { "capitalize": "hELLO" } */
  capitalize(def: Record<string, unknown>, c: Context) {
    return resolve(def.capitalize, c, v => {
      const s = this.toString(v);
      return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
    });
  }

  /** Capitalizes the first letter of each word. @example { "title": "hello world" } */
  title(def: Record<string, unknown>, c: Context) {
    return resolve(def.title, c, v =>
      this.toString(v).replace(/\w\S*/g, txt => txt.charAt(0).toUpperCase() + txt.slice(1).toLowerCase())
    );
  }

  /** Removes leading and trailing whitespace. @example { "trim": "  hello  " } */
  trim(d: Record<string, unknown>, c: Context) {
    return resolve(d.trim, c, v => this.toString(v).trim());
  }

  /** Removes leading whitespace. @example { "trimStart": "  hello" } */
  trimStart(d: Record<string, unknown>, c: Context) {
    return resolve(d.trimStart, c, v => this.toString(v).trimStart());
  }

  /** Removes trailing whitespace. @example { "trimEnd": "hello  " } */
  trimEnd(d: Record<string, unknown>, c: Context) {
    return resolve(d.trimEnd, c, v => this.toString(v).trimEnd());
  }

  /** Returns the character count of a string. @example { "length": { "var": "$name" } } */
  length(d: Record<string, unknown>, c: Context) {
    return resolve(d.length, c, v => this.toString(v).length);
  }

  /**
   * Converts a string to a URL-safe lowercase slug, stripping accents and special characters.
   *
   * @example
   * { "slug": "Hello World!" }
   */
  slug(def: Record<string, unknown>, c: Context) {
    return resolve(def.slug, c, v =>
      this.toString(v)
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
    );
  }

  /** Parses a JSON string; returns `null` on invalid input. @example { "parseJSON": { "var": "$raw" } } */
  parseJSON(d: Record<string, unknown>, c: Context) {
    return resolve(d.parseJSON, c, v => {
      try { return JSON.parse(this.toString(v)); } catch { return null; }
    });
  }

  /**
   * Serializes a value to a JSON string. Pass `[value, indent]` to pretty-print.
   *
   * @param {[1,2]} stringify `[value, indent?]` — value to serialize and optional indent spaces.
   * @example
   * { "stringify": [{ "var": "$obj" }, 2] }
   */
  stringify(def: Record<string, unknown>, c: Context) {
    return resolve(def.stringify, c, args => {
      if (Array.isArray(args)) {
        const a = args as unknown[];
        const indent = a.length > 1 ? Number(a[1]) || 0 : 0;
        return JSON.stringify(a[0], null, indent || undefined);
      }
      return JSON.stringify(args);
    });
  }

  /**
   * Extracts a substring.
   *
   * @param {[2,3]} substring `[string, start, end?]`.
   * @example
   * { "substring": ["hello world", 6] }
   */
  substring(def: Record<string, unknown>, c: Context) {
    return resolve(def.substring, c, args => {
      const a = this.toArray(args);
      const str = this.toString(a[0]);
      const start = this.toNumber(a[1]);
      const end = a.length > 2 ? this.toNumber(a[2]) : undefined;
      return str.substring(start, end);
    });
  }

  /**
   * Replaces all occurrences of a substring.
   *
   * @param {[3]} replace `[string, search, replacement]`.
   * @example
   * { "replace": ["foo foo", "foo", "bar"] }
   */
  replace(def: Record<string, unknown>, c: Context) {
    return resolve(def.replace, c, args => doReplace(args, true));
  }

  /**
   * Replaces only the first occurrence of a substring.
   *
   * @param {[3]} replaceFirst `[string, search, replacement]`.
   * @example
   * { "replaceFirst": ["foo foo", "foo", "bar"] }
   */
  replaceFirst(def: Record<string, unknown>, c: Context) {
    return resolve(def.replaceFirst, c, args => doReplace(args, false));
  }

  /**
   * Splits a string into an array.
   *
   * @param {[2]} split `[string, separator]`.
   * @example
   * { "split": ["a,b,c", ","] }
   */
  split(def: Record<string, unknown>, c: Context) {
    return resolve(def.split, c, args => {
      const a = this.toArray(args);
      return this.toString(a[0]).split(a.length > 1 ? this.toString(a[1]) : "");
    });
  }

  /**
   * Joins an array into a string with a separator (default `","`).
   *
   * @param {[1,2]} join `[array, separator?]`.
   * @example
   * { "join": [["a", "b", "c"], " - "] }
   */
  join(def: Record<string, unknown>, c: Context) {
    return resolve(def.join, c, args => {
      const a = this.toArray(args);
      return this.toArray(a[0]).map(v => this.toString(v)).join(a.length > 1 ? this.toString(a[1]) : ",");
    });
  }

  /**
   * Pads the start of a string to a target length.
   *
   * @param {[2,3]} padStart `[string, length, padChar?]`.
   * @example
   * { "padStart": ["5", 3, "0"] }
   */
  padStart(def: Record<string, unknown>, c: Context) {
    return resolve(def.padStart, c, args => doPad(args, "start"));
  }

  /**
   * Pads the end of a string to a target length.
   *
   * @param {[2,3]} padEnd `[string, length, padChar?]`.
   * @example
   * { "padEnd": ["hi", 5, "."] }
   */
  padEnd(def: Record<string, unknown>, c: Context) {
    return resolve(def.padEnd, c, args => doPad(args, "end"));
  }

  /**
   * Repeats a string N times.
   *
   * @param {[2]} repeat `[string, count]`.
   * @example
   * { "repeat": ["ab", 3] }
   */
  repeat(def: Record<string, unknown>, c: Context) {
    return resolve(def.repeat, c, args => {
      const a = this.toArray(args);
      return this.toString(a[0]).repeat(Math.max(0, this.toNumber(a[1])));
    });
  }

  /**
   * Returns `true` if a string starts with the given prefix.
   *
   * @param {[2]} startsWith `[string, prefix]`.
   * @example
   * { "startsWith": ["hello world", "hello"] }
   */
  startsWith(def: Record<string, unknown>, c: Context) {
    return resolve(def.startsWith, c, args => {
      const a = this.toArray(args);
      return this.toString(a[0]).startsWith(this.toString(a[1]));
    });
  }

  /**
   * Returns `true` if a string ends with the given suffix.
   *
   * @param {[2]} endsWith `[string, suffix]`.
   * @example
   * { "endsWith": ["hello world", "world"] }
   */
  endsWith(def: Record<string, unknown>, c: Context) {
    return resolve(def.endsWith, c, args => {
      const a = this.toArray(args);
      return this.toString(a[0]).endsWith(this.toString(a[1]));
    });
  }

  /**
   * Returns `true` if a string contains the given substring.
   *
   * @param {[2]} contains `[string, substring]`.
   * @example
   * { "contains": ["hello world", "world"] }
   */
  contains(def: Record<string, unknown>, c: Context) {
    return resolve(def.contains, c, args => {
      const a = this.toArray(args);
      return this.toString(a[0]).includes(this.toString(a[1]));
    });
  }
}

function doReplace(args: unknown, all: boolean): string {
  const a = Array.isArray(args) ? (args as unknown[]) : args != null ? [args] : [];
  if (a.length < 3) return "";
  const str = String(a[0] ?? "");
  const search = String(a[1] ?? "");
  const replacement = String(a[2] ?? "");
  return all ? str.split(search).join(replacement) : str.replace(search, replacement);
}

function doPad(args: unknown, side: "start" | "end"): string {
  const a = Array.isArray(args) ? (args as unknown[]) : args != null ? [args] : [];
  const str = String(a[0] ?? "");
  const length = Number(a[1]) || 0;
  const padChar = a.length > 2 ? String(a[2] ?? "") : " ";
  return side === "start" ? str.padStart(length, padChar) : str.padEnd(length, padChar);
}
