import { Node, Context } from "./Node.js";
import { resolve, resolveAll } from "../Resolver.js";
import type { JexsNodeSchema } from "../schema.js";

export class StringNode extends Node {
  static schema: JexsNodeSchema = {
    concat: {
      type: "array",
      items: {
        type: "string",
      },
      output: "string",
      markdownDescription: "Joins an array of values into a single string.",
      examples: [
        "{ \"concat\": [\"Hello, \", { \"var\": \"$name\" }, \"!\"] }",
      ],
    },
    upper: {
      output: "string",
      markdownDescription: "Converts a string to uppercase.",
      examples: [
        "{ \"upper\": { \"var\": \"$name\" } }",
      ],
    },
    lower: {
      output: "string",
      markdownDescription: "Converts a string to lowercase.",
      examples: [
        "{ \"lower\": { \"var\": \"$name\" } }",
      ],
    },
    capitalize: {
      output: "string",
      markdownDescription: "Uppercases the first character, lowercases the rest.",
      examples: [
        "{ \"capitalize\": \"hELLO\" }",
      ],
    },
    trim: {
      output: "string",
      markdownDescription: "Removes leading and trailing whitespace.",
      examples: [
        "{ \"trim\": \"  hello  \" }",
      ],
    },
    trimStart: {
      output: "string",
      markdownDescription: "Removes leading whitespace.",
      examples: [
        "{ \"trimStart\": \"  hello\" }",
      ],
    },
    trimEnd: {
      output: "string",
      markdownDescription: "Removes trailing whitespace.",
      examples: [
        "{ \"trimEnd\": \"hello  \" }",
      ],
    },
    length: {
      output: "number",
      markdownDescription: "Returns the character count of a string.",
      examples: [
        "{ \"length\": { \"var\": \"$name\" } }",
      ],
    },
    slug: {
      output: "string",
      markdownDescription: "Converts a string to a URL-safe lowercase slug, stripping accents and special characters.",
      examples: [
        "{ \"slug\": \"Hello World!\" }",
      ],
    },
    parseJSON: {
      markdownDescription: "Parses a JSON string; returns `null` on invalid input.",
      outputDescription: "The parsed value — any JSON type (object, array, number, string, boolean, or `null`). Returns `null` if the input isn't valid JSON, so it's indistinguishable from a literal `null`.",
      examples: [
        "{ \"parseJSON\": { \"var\": \"$raw\" } }",
      ],
    },
    stringify: {
      tuple: [
        1,
        2,
      ],
      output: "string",
      markdownDescription: "Serializes a value to a JSON string. Pass `[value, indent]` to pretty-print.",
      examples: [
        "{ \"stringify\": [{ \"var\": \"$obj\" }, 2] }",
      ],
    },
    substring: {
      tuple: [
        2,
        3,
      ],
      output: "string",
      markdownDescription: "Extracts a substring.",
      examples: [
        "{ \"substring\": [\"hello world\", 6] }",
      ],
    },
    replace: {
      tuple: 3,
      output: "string",
      markdownDescription: "Replaces occurrences in `[input, search, replacement]`. A `search` of the form `/pattern/flags` is treated as a regular expression (so `$1`/`$&` group refs work in the replacement); any other string is matched literally. Replaces all occurrences by default — set `all: false` for only the first (literal), or omit the `g` flag (regex).",
      examples: [
        "{ \"replace\": [\"foo foo\", \"foo\", \"bar\"] }",
        "{ \"replace\": [\"a1 b2\", \"/\\\\d/g\", \"#\"] }",
      ],
      siblings: {
        all: {
          type: "boolean",
          description: "Replace all occurrences (default `true`). For `/regex/` patterns the `g` flag controls this unless `all` is set explicitly.",
        },
      },
    },
    split: {
      tuple: 2,
      output: "array",
      markdownDescription: "Splits a string into an array. A `/pattern/flags` separator splits on a regular expression.",
      examples: [
        "{ \"split\": [\"a,b,c\", \",\"] }",
      ],
    },
    join: {
      tuple: [
        1,
        2,
      ],
      output: "string",
      markdownDescription: "Joins an array into a string with a separator (default `\",\"`).",
      examples: [
        "{ \"join\": [[\"a\", \"b\", \"c\"], \" - \"] }",
      ],
    },
    padStart: {
      tuple: [
        2,
        3,
      ],
      output: "string",
      markdownDescription: "Pads the start of a string to a target length.",
      examples: [
        "{ \"padStart\": [\"5\", 3, \"0\"] }",
      ],
    },
    padEnd: {
      tuple: [
        2,
        3,
      ],
      output: "string",
      markdownDescription: "Pads the end of a string to a target length.",
      examples: [
        "{ \"padEnd\": [\"hi\", 5, \".\"] }",
      ],
    },
    repeat: {
      tuple: 2,
      output: "string",
      markdownDescription: "Repeats a string N times.",
      examples: [
        "{ \"repeat\": [\"ab\", 3] }",
      ],
    },
    startsWith: {
      tuple: 2,
      output: "boolean",
      markdownDescription: "Returns `true` if a string starts with the given prefix.",
      examples: [
        "{ \"startsWith\": [\"hello world\", \"hello\"] }",
      ],
    },
    endsWith: {
      tuple: 2,
      output: "boolean",
      markdownDescription: "Returns `true` if a string ends with the given suffix.",
      examples: [
        "{ \"endsWith\": [\"hello world\", \"world\"] }",
      ],
    },
    contains: {
      tuple: 2,
      output: "boolean",
      markdownDescription: "Returns `true` if a string contains the given substring. A `/pattern/flags` needle tests a regular expression instead.",
      examples: [
        "{ \"contains\": [\"hello world\", \"world\"] }",
      ],
    },
    match: {
      tuple: 2,
      output: "array",
      outputDescription: "Array of matches, or `null` when nothing matches. With the `g` flag every match; otherwise the first match plus capture groups.",
      markdownDescription: "Matches a regular expression against a string. The pattern may be `/pattern/flags` or a bare pattern.",
      examples: [
        "{ \"match\": [\"a1 b2\", \"/\\\\d/g\"] }",
      ],
    },
  };

  concat(def: Record<string, unknown>, c: Context) {
    return resolve(def.concat, c, parts =>
      this.toArray(parts).map(p => this.toString(p)).join("")
    );
  }

  upper(d: Record<string, unknown>, c: Context) {
    return resolve(d.upper, c, v => this.toString(v).toUpperCase());
  }

  lower(d: Record<string, unknown>, c: Context) {
    return resolve(d.lower, c, v => this.toString(v).toLowerCase());
  }

  capitalize(def: Record<string, unknown>, c: Context) {
    return resolve(def.capitalize, c, v => {
      const s = this.toString(v);
      return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
    });
  }

  trim(d: Record<string, unknown>, c: Context) {
    return resolve(d.trim, c, v => this.toString(v).trim());
  }

  trimStart(d: Record<string, unknown>, c: Context) {
    return resolve(d.trimStart, c, v => this.toString(v).trimStart());
  }

  trimEnd(d: Record<string, unknown>, c: Context) {
    return resolve(d.trimEnd, c, v => this.toString(v).trimEnd());
  }

  length(d: Record<string, unknown>, c: Context) {
    return resolve(d.length, c, v => this.toString(v).length);
  }

  slug(def: Record<string, unknown>, c: Context) {
    return resolve(def.slug, c, v =>
      this.toString(v)
        .toLowerCase()
        .normalize("NFD")
        .replace(SLUG_DIACRITICS, "")
        .replace(SLUG_NON_ALNUM, "")
        .replace(SLUG_SPACES, "-")
        .replace(SLUG_DASHES, "-")
        .replace(SLUG_EDGE_DASHES, "")
    );
  }

  parseJSON(d: Record<string, unknown>, c: Context) {
    return resolve(d.parseJSON, c, v => {
      try { return JSON.parse(this.toString(v)); } catch { return null; }
    });
  }

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

  substring(def: Record<string, unknown>, c: Context) {
    return resolve(def.substring, c, args => {
      const a = this.toArray(args);
      const str = this.toString(a[0]);
      const start = this.toNumber(a[1]);
      const end = a.length > 2 ? this.toNumber(a[2]) : undefined;
      return str.substring(start, end);
    });
  }

  replace(def: Record<string, unknown>, c: Context) {
    return resolveAll([def.replace, def.all], c, ([args, all]) =>
      doReplace(args, all as boolean | undefined),
    );
  }

  split(def: Record<string, unknown>, c: Context) {
    return resolve(def.split, c, args => {
      const a = this.toArray(args);
      if (a.length < 2) return this.toString(a[0]).split("");
      // A `/pattern/flags` separator splits on a regular expression.
      const re = toRegex(a[1]);
      return this.toString(a[0]).split(re ?? this.toString(a[1]));
    });
  }

  join(def: Record<string, unknown>, c: Context) {
    return resolve(def.join, c, args => {
      const a = this.toArray(args);
      return this.toArray(a[0]).map(v => this.toString(v)).join(a.length > 1 ? this.toString(a[1]) : ",");
    });
  }

  padStart(def: Record<string, unknown>, c: Context) {
    return resolve(def.padStart, c, args => doPad(args, "start"));
  }

  padEnd(def: Record<string, unknown>, c: Context) {
    return resolve(def.padEnd, c, args => doPad(args, "end"));
  }

  repeat(def: Record<string, unknown>, c: Context) {
    return resolve(def.repeat, c, args => {
      const a = this.toArray(args);
      return this.toString(a[0]).repeat(Math.max(0, this.toNumber(a[1])));
    });
  }

  startsWith(def: Record<string, unknown>, c: Context) {
    return resolve(def.startsWith, c, args => {
      const a = this.toArray(args);
      return this.toString(a[0]).startsWith(this.toString(a[1]));
    });
  }

  endsWith(def: Record<string, unknown>, c: Context) {
    return resolve(def.endsWith, c, args => {
      const a = this.toArray(args);
      return this.toString(a[0]).endsWith(this.toString(a[1]));
    });
  }

  contains(def: Record<string, unknown>, c: Context) {
    return resolve(def.contains, c, args => {
      const a = this.toArray(args);
      // A `/pattern/flags` needle tests a regular expression; else substring.
      // `search` saves/restores lastIndex, so a cached g/y regex stays safe.
      const re = toRegex(a[1]);
      return re ? this.toString(a[0]).search(re) !== -1 : this.toString(a[0]).includes(this.toString(a[1]));
    });
  }

  match(def: Record<string, unknown>, c: Context) {
    return resolve(def.match, c, args => {
      const a = this.toArray(args);
      // `match` is always regex: a `/re/flags` literal carries flags; a bare
      // string is coerced to a RegExp by String.prototype.match.
      const re = toRegex(a[1]);
      return this.toString(a[0]).match(re ?? this.toString(a[1]));
    });
  }
}

function doReplace(args: unknown, all: boolean | undefined): string {
  const a = Array.isArray(args) ? (args as unknown[]) : args != null ? [args] : [];
  if (a.length < 3) return "";
  const str = String(a[0] ?? "");
  const replacement = String(a[2] ?? "");

  // A `/pattern/flags` search is a regular expression; anything else is literal.
  const re = toRegex(a[1]);
  if (re) return str.replace(withGlobal(re, all), replacement);

  const search = String(a[1] ?? "");
  // Literal: replace all by default; `all: false` replaces only the first.
  return all === false ? str.replace(search, replacement) : str.split(search).join(replacement);
}

// Slug normalization regexes, hoisted out of the per-call chain. All are used
// only with String.replace (which resets lastIndex), so the shared `/g` consts
// are safe — do not call .test()/.exec() on them.
const SLUG_DIACRITICS = /[̀-ͯ]/g;
const SLUG_NON_ALNUM = /[^a-z0-9\s-]/g;
const SLUG_SPACES = /\s+/g;
const SLUG_DASHES = /-+/g;
const SLUG_EDGE_DASHES = /^-|-$/g;

const REGEX_LITERAL = /^\/(.+)\/([a-z]*)$/;

// Cache parsed `/pattern/flags` literals (including the `null` non-match result).
// Only strings starting with `/` (charCode 47) are cached — a `/...` literal is
// the only form REGEX_LITERAL can match — so dynamic literal needles passed to
// contains/split don't pollute the cache. When full we evict the oldest entry
// (FIFO, via Map insertion order); the hit path stays a single Map.get with no
// reorder. Literal cardinality is bounded by the templates in play.
const _regexCache = new Map<string, RegExp | null>();
const REGEX_CACHE_MAX = 200;

/** Parse a `/pattern/flags` string into a RegExp, or null if not that form. */
function toRegex(search: unknown): RegExp | null {
  if (typeof search !== "string") return null;
  const cacheable = search.charCodeAt(0) === 47;
  if (cacheable) {
    const hit = _regexCache.get(search);
    if (hit !== undefined) {
      // A shared regex with the g/y flag carries lastIndex between calls; reset
      // it so repeated test/exec/match always start from the beginning.
      if (hit) hit.lastIndex = 0;
      return hit;
    }
  }
  const m = REGEX_LITERAL.exec(search);
  let re: RegExp | null = null;
  if (m) {
    try {
      re = new RegExp(m[1], m[2]);
    } catch {
      re = null;
    }
  }
  if (cacheable) {
    // size >= MAX guarantees at least one entry, so the oldest key is non-null.
    if (_regexCache.size >= REGEX_CACHE_MAX) _regexCache.delete(_regexCache.keys().next().value!);
    _regexCache.set(search, re);
  }
  return re;
}

/** Align a RegExp's `g` flag with an explicit `all`; leave it untouched if `all`
 *  is omitted (the pattern's own flags decide). */
function withGlobal(re: RegExp, all: boolean | undefined): RegExp {
  if (all === undefined) return re;
  const hasG = re.flags.includes("g");
  if (all && !hasG) return new RegExp(re.source, re.flags + "g");
  if (!all && hasG) return new RegExp(re.source, re.flags.replace("g", ""));
  return re;
}

function doPad(args: unknown, side: "start" | "end"): string {
  const a = Array.isArray(args) ? (args as unknown[]) : args != null ? [args] : [];
  const str = String(a[0] ?? "");
  const length = Number(a[1]) || 0;
  const padChar = a.length > 2 ? String(a[2] ?? "") : " ";
  return side === "start" ? str.padStart(length, padChar) : str.padEnd(length, padChar);
}
