import { Node, Context } from "./Node.js";
import { resolve, resolveAll } from "../Resolver.js";
import { toBooleanValue, toStringValue } from "../helpers.js";
import type { JexsNodeSchema, JexsPropertySchema } from "../schema.js";

/**
 * Chunk size for feeding `btoa`, because `String.fromCharCode(...bytes)` is a
 * spread and ~100k arguments overflows the stack. Affects speed only, never the
 * output. Retires on Node 25+, whose V8 has `Uint8Array.prototype.toBase64`.
 */
const BASE64_CHUNK = 8192;

const STRING_LIST: JexsPropertySchema = { type: "array", items: { type: "string" } };

const FLAGS: JexsPropertySchema = {
  type: "string",
  pattern: "^(?!.*(.).*\\1)[imsuv]*$",
  markdownDescription: "Regular expression flags, each at most once: `i` (ignore case), `m` (multiline `^`/`$`), `s` (`.` matches newlines), `u` / `v` (Unicode). Whether to match once or everywhere is the `all` sibling, not a `g` flag.",
};

// Selected by value, so `flags` is refused unless `regex` is literally true (or
// an expression that may resolve to it).
const REGEX: JexsPropertySchema = {
  type: "boolean",
  default: false,
  variantBy: "value",
  markdownDescription: "Read the pattern slot as a regular expression source (no surrounding slashes) instead of literal text. Without it the slot is always literal, so text from data never runs as a pattern.",
  variants: { true: { siblings: { flags: FLAGS } } },
};

export class StringNode extends Node {
  static schema: JexsNodeSchema = {
    concat: {
      type: "array",
      items: {},
      output: "string",
      markdownDescription: "Joins an array of values into a single string.",
      examples: [
        "{ \"$concat\": [\"Hello, \", { \"$var\": \"name\" }, \"!\"] }",
      ],
    },
    upper: {
      output: "string",
      markdownDescription: "Converts a string to uppercase.",
      examples: [
        "{ \"$upper\": { \"$var\": \"name\" } }",
      ],
    },
    lower: {
      output: "string",
      markdownDescription: "Converts a string to lowercase.",
      examples: [
        "{ \"$lower\": { \"$var\": \"name\" } }",
      ],
    },
    capitalize: {
      output: "string",
      markdownDescription: "Uppercases the first character, lowercases the rest.",
      examples: [
        "{ \"$capitalize\": \"hELLO\" }",
      ],
    },
    trim: {
      output: "string",
      markdownDescription: "Removes leading and trailing whitespace.",
      examples: [
        "{ \"$trim\": \"  hello  \" }",
      ],
    },
    trimStart: {
      output: "string",
      markdownDescription: "Removes leading whitespace.",
      examples: [
        "{ \"$trimStart\": \"  hello\" }",
      ],
    },
    trimEnd: {
      output: "string",
      markdownDescription: "Removes trailing whitespace.",
      examples: [
        "{ \"$trimEnd\": \"hello  \" }",
      ],
    },
    length: {
      output: "number",
      markdownDescription: "Returns the character count of a string.",
      examples: [
        "{ \"$length\": { \"$var\": \"name\" } }",
      ],
    },
    slug: {
      output: "string",
      markdownDescription: "Converts a string to a URL-safe lowercase slug, stripping accents and special characters.",
      examples: [
        "{ \"$slug\": \"Hello World!\" }",
      ],
    },
    toBase64: {
      output: "string",
      markdownDescription: "Encodes a string as base64. The text is read as UTF-8, so any character encodes, not just the Latin-1 range the platform's own `btoa` is limited to.\n\nPass `urlSafe: true` for the alphabet URLs and JWTs use (`-` and `_` in place of `+` and `/`, padding dropped).",
      examples: [
        "{ \"$toBase64\": { \"$concat\": [{ \"$var\": \"user\" }, \":\", { \"$var\": \"key\" }] } }",
      ],
      siblings: {
        urlSafe: {
          type: "boolean",
          description: "Use the URL-safe alphabet and drop the `=` padding.",
        },
      },
    },
    fromBase64: {
      // Typed, unlike the ops around it: those coerce whatever they are given,
      // while this one needs text that already IS base64, so a number-output
      // expression here is a mistake worth catching in the editor.
      type: "string",
      output: "string",
      markdownDescription: "Decodes base64 back to a string, reading the bytes as UTF-8. Accepts either alphabet and tolerates missing padding, so a value that arrived URL-safe needs no flag.",
      outputDescription: "The decoded text. Throws if the input is not valid base64.",
      examples: [
        "{ \"$fromBase64\": { \"$var\": \"token\" } }",
      ],
    },
    parseJSON: {
      // Typed for the same reason as `fromBase64`: this reads text that already
      // IS JSON rather than stringifying whatever arrives.
      type: "string",
      markdownDescription: "Parses a JSON string; returns `null` on invalid input.",
      outputDescription: "The parsed value, which can be any JSON type (object, array, number, string, boolean, or `null`). Returns `null` if the input isn't valid JSON, so it's indistinguishable from a literal `null`.",
      examples: [
        "{ \"$parseJSON\": { \"$var\": \"raw\" } }",
      ],
    },
    stringify: {
      output: "string",
      markdownDescription: "Serializes a value to a JSON string, whatever its type: an array is serialized as the array.",
      examples: [
        "{ \"$stringify\": { \"$var\": \"obj\" }, \"indent\": 2 }",
      ],
      siblings: {
        indent: {
          type: "number",
          description: "Spaces to indent each level by, to pretty-print. Omitted or 0, the output is on one line.",
        },
      },
    },
    substring: {
      tuple: [
        2,
        3,
      ],
      prefixItems: [
        { type: "string", description: "The source string." },
        { type: "number", description: "Start index (inclusive)." },
        { type: "number", description: "End index (exclusive). Defaults to the end of the string." },
      ],
      output: "string",
      markdownDescription: "Extracts a substring.",
      examples: [
        "{ \"$substring\": [\"hello world\", 6] }",
      ],
    },
    replace: {
      tuple: 3,
      prefixItems: [
        { type: "string", description: "The input string." },
        { type: "string", description: "The text to find, matched literally unless `regex: true`." },
        { type: "string", description: "The replacement. Inserted as-is, except under `regex: true`, where `$1`, `$<name>` and `$&` insert captures." },
      ],
      output: "string",
      markdownDescription: "Replaces occurrences in `[input, find, replacement]`. The search is literal and replaces every occurrence; set `all: false` for only the first, and `regex: true` to search with a regular expression.",
      examples: [
        "{ \"$replace\": [\"foo foo\", \"foo\", \"bar\"] }",
        "{ \"$replace\": [\"a1 b22\", \"\\\\d+\", \"#\"], \"regex\": true }",
      ],
      siblings: {
        all: {
          type: "boolean",
          description: "Replace every occurrence (default `true`); `false` replaces only the first.",
        },
        regex: REGEX,
      },
    },
    split: {
      tuple: 2,
      prefixItems: [
        { type: "string", description: "The string to split." },
        { type: "string", description: "The separator, matched literally unless `regex: true`." },
      ],
      output: STRING_LIST,
      markdownDescription: "Splits a string into an array. Pass `regex: true` to split on a regular expression.",
      examples: [
        "{ \"$split\": [\"a,b,c\", \",\"] }",
        "{ \"$split\": [\"a , b,c\", \"\\\\s*,\\\\s*\"], \"regex\": true }",
      ],
      siblings: { regex: REGEX },
    },
    join: {
      type: "array",
      output: "string",
      markdownDescription: "Joins an array into a string with a separator (default `\",\"`).",
      examples: [
        "{ \"$join\": [\"a\", \"b\", \"c\"], \"separator\": \" - \" }",
      ],
      siblings: {
        separator: {
          type: "string",
          default: ",",
          description: "Put between items. Omitted, `\",\"`.",
        },
      },
    },
    padStart: {
      tuple: [
        2,
        3,
      ],
      prefixItems: [
        { type: "string", description: "The string to pad." },
        { type: "number", description: "Target total length." },
        { type: "string", description: "Pad string (default `\" \"`)." },
      ],
      output: "string",
      markdownDescription: "Pads the start of a string to a target length.",
      examples: [
        "{ \"$padStart\": [\"5\", 3, \"0\"] }",
      ],
    },
    padEnd: {
      tuple: [
        2,
        3,
      ],
      prefixItems: [
        { type: "string", description: "The string to pad." },
        { type: "number", description: "Target total length." },
        { type: "string", description: "Pad string (default `\" \"`)." },
      ],
      output: "string",
      markdownDescription: "Pads the end of a string to a target length.",
      examples: [
        "{ \"$padEnd\": [\"hi\", 5, \".\"] }",
      ],
    },
    repeat: {
      tuple: 2,
      prefixItems: [
        { type: "string", description: "The string to repeat." },
        { type: "number", description: "Number of repetitions." },
      ],
      output: "string",
      markdownDescription: "Repeats a string N times.",
      examples: [
        "{ \"$repeat\": [\"ab\", 3] }",
      ],
    },
    startsWith: {
      tuple: 2,
      prefixItems: [
        { type: "string", description: "The string to test." },
        { type: "string", description: "The prefix to look for." },
      ],
      output: "boolean",
      markdownDescription: "Returns `true` if a string starts with the given prefix.",
      examples: [
        "{ \"$startsWith\": [\"hello world\", \"hello\"] }",
      ],
    },
    endsWith: {
      tuple: 2,
      prefixItems: [
        { type: "string", description: "The string to test." },
        { type: "string", description: "The suffix to look for." },
      ],
      output: "boolean",
      markdownDescription: "Returns `true` if a string ends with the given suffix.",
      examples: [
        "{ \"$endsWith\": [\"hello world\", \"world\"] }",
      ],
    },
    contains: {
      tuple: 2,
      prefixItems: [
        { type: "string", description: "The string to test." },
        { type: "string", description: "The substring to look for, matched literally unless `regex: true`." },
      ],
      output: "boolean",
      markdownDescription: "Returns `true` if a string contains the given substring. Pass `regex: true` to test a regular expression instead.",
      examples: [
        "{ \"$contains\": [\"hello world\", \"world\"] }",
        "{ \"$contains\": [{ \"$var\": \"name\" }, \"^admin\"], \"regex\": true, \"flags\": \"i\" }",
      ],
      siblings: { regex: REGEX },
    },
    match: {
      tuple: 2,
      prefixItems: [
        { type: "string", description: "The string to search." },
        { type: "string", description: "The regular expression source, without surrounding slashes." },
      ],
      output: { $ref: "#/$defs/_regexMatch" },
      outputDescription: "The first match, or `null` when nothing matches.",
      markdownDescription: "Matches a regular expression against a string and returns the first match. Pass `all: true` for every match, and `capture` for one group's text instead of the whole match object.",
      examples: [
        "{ \"$match\": [\"2026-09-28\", \"(?<year>\\\\d{4})-(\\\\d{2})\"] }",
        "{ \"$match\": [{ \"$var\": \"path\" }, \"^/users/(\\\\d+)\"], \"capture\": 1 }",
        "{ \"$match\": [\"a1 b22\", \"\\\\d+\"], \"all\": true, \"capture\": 0 }",
      ],
      siblings: { flags: FLAGS },
      variants: {
        all: {
          type: "boolean",
          output: { type: "array", items: { $ref: "#/$defs/_regexMatch" } },
          markdownDescription: "Return every match, as an array of match objects (`[]` when there are none).",
          variants: {
            capture: {
              type: ["number", "string"],
              output: { type: "array", items: { type: ["string", "null"] } },
              outputDescription: "The chosen group's text from every match, `null` where a match left it unset.",
            },
          },
        },
        capture: {
          type: ["number", "string"],
          output: "string",
          markdownDescription: "Return one group's text instead of the match object: a number picks a numbered group (`0` is the whole match), a string a named group. `null` when nothing matches or the group took no part.",
        },
      },
    },
    escapeRegex: {
      output: "string",
      markdownDescription: "Escapes every regular-expression metacharacter, so the text matches itself when spliced into a pattern for `regex: true` or `$match`.",
      examples: [
        "{ \"$match\": [{ \"$var\": \"line\" }, { \"$concat\": [\"^\", { \"$escapeRegex\": { \"$var\": \"key\" } }, \"=(.*)\"] }], \"capture\": 1 }",
      ],
    },
    normalize: {
      output: "string",
      markdownDescription: "Unicode-normalizes a string (default `\"NFC\"`). Apply before comparing, sorting, or hashing text that may carry combining marks or compatibility forms so equivalent strings share one representation.",
      examples: [
        "{ \"$normalize\": { \"$var\": \"name\" } }",
      ],
      siblings: {
        form: {
          type: "string",
          enum: [
            "NFC",
            "NFD",
            "NFKC",
            "NFKD",
          ],
          default: "NFC",
          description: "Normalization form (default `\"NFC\"`).",
        },
      },
    },
    segment: {
      output: STRING_LIST,
      markdownDescription: "Splits a string into Unicode-correct segments via `Intl.Segmenter`, unlike the code-unit `split`. `\"grapheme\"` (default) yields user-perceived characters, so emoji and combining marks stay whole, where `length` and index-based ops treat them as several UTF-16 units. `\"word\"` yields locale-aware word boundaries (works for scripts without spaces, e.g. Chinese/Japanese/Thai). `\"sentence\"` yields sentences.",
      outputDescription: "An array of segment strings. `\"word\"`/`\"sentence\"` granularity includes the whitespace and punctuation segments between words.",
      examples: [
        "{ \"$segment\": \"a\\ud83d\\udc4db\" }",
        "{ \"$segment\": { \"$var\": \"text\" }, \"granularity\": \"word\" }",
      ],
      siblings: {
        granularity: {
          type: "string",
          enum: [
            "grapheme",
            "word",
            "sentence",
          ],
          default: "grapheme",
          description: "Segment boundary type (default `\"grapheme\"`).",
        },
        locale: {
          type: "string",
          description: "BCP-47 locale tag for word/sentence boundaries (default: the runtime locale).",
        },
      },
    },
  };

  static schemaDefs = {
    _regexMatch: {
      type: "object",
      description: "One regular-expression match, as `$match` returns it.",
      properties: {
        match: { type: "string", description: "The whole matched text." },
        index: { type: "number", description: "Where the match starts in the string." },
        captures: { type: "array", items: { type: ["string", "null"] }, description: "The numbered groups' text, `null` for a group that took no part." },
        groups: { type: "object", additionalProperties: { type: ["string", "null"] }, description: "The named groups' text, by name; empty when the pattern names none." },
      },
    },
  };

  concat(def: Record<string, unknown>, c: Context) {
    return resolve(def.$concat, c, parts =>
      this.toArray(parts).map(p => this.toString(p)).join("")
    );
  }

  upper(d: Record<string, unknown>, c: Context) {
    return resolve(d.$upper, c, v => this.toString(v).toUpperCase());
  }

  lower(d: Record<string, unknown>, c: Context) {
    return resolve(d.$lower, c, v => this.toString(v).toLowerCase());
  }

  capitalize(def: Record<string, unknown>, c: Context) {
    return resolve(def.$capitalize, c, v => {
      const s = this.toString(v);
      return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
    });
  }

  trim(d: Record<string, unknown>, c: Context) {
    return resolve(d.$trim, c, v => this.toString(v).trim());
  }

  trimStart(d: Record<string, unknown>, c: Context) {
    return resolve(d.$trimStart, c, v => this.toString(v).trimStart());
  }

  trimEnd(d: Record<string, unknown>, c: Context) {
    return resolve(d.$trimEnd, c, v => this.toString(v).trimEnd());
  }

  length(d: Record<string, unknown>, c: Context) {
    return resolve(d.$length, c, v => this.toString(v).length);
  }

  toBase64(def: Record<string, unknown>, c: Context) {
    return resolveAll([def.$toBase64, def.urlSafe], c, ([value, urlSafe]) => {
      // Through TextEncoder, not straight into `btoa`, which is Latin-1 only:
      // `btoa("héllo")` throws on its own.
      const bytes = new TextEncoder().encode(this.toString(value));
      let binary = "";
      for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
      }
      const encoded = btoa(binary);
      return this.toBoolean(urlSafe)
        ? encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
        : encoded;
    });
  }

  fromBase64(def: Record<string, unknown>, c: Context) {
    return resolve(def.$fromBase64, c, v => {
      // Either alphabet, padded or not: a URL-safe value usually arrives stripped,
      // and `atob` wants the standard characters and a length that is a multiple of 4.
      const standard = this.toString(v).trim().replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    });
  }

  slug(def: Record<string, unknown>, c: Context) {
    return resolve(def.$slug, c, v =>
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
    return resolve(d.$parseJSON, c, v => {
      try { return JSON.parse(this.toString(v)); } catch { return null; }
    });
  }

  stringify(def: Record<string, unknown>, c: Context) {
    return resolveAll([def.$stringify, def.indent ?? 0], c, ([value, indent]) =>
      JSON.stringify(value, null, Number(indent) || undefined),
    );
  }

  substring(def: Record<string, unknown>, c: Context) {
    return resolve(def.$substring, c, args => {
      const a = this.toArray(args);
      const str = this.toString(a[0]);
      const start = this.toNumber(a[1]);
      const end = a.length > 2 ? this.toNumber(a[2]) : undefined;
      return str.substring(start, end);
    });
  }

  replace(def: Record<string, unknown>, c: Context) {
    return resolveAll([def.$replace, def.all, def.regex, def.flags], c, ([args, all, regex, flags]) => {
      const a = this.toArray(args);
      if (a.length < 3) return "";
      const str = this.toString(a[0]);
      const replacement = this.toString(a[2]);
      if (regexMode("replace", regex, flags)) {
        return str.replace(compileRegex(this.regexCache, "replace", a[1], flags, all !== false), replacement);
      }
      const find = this.toString(a[1]);
      // A function replacer, so `$&` and `$1` in literal text are inserted as written.
      return all === false ? str.replace(find, () => replacement) : str.split(find).join(replacement);
    });
  }

  split(def: Record<string, unknown>, c: Context) {
    return resolveAll([def.$split, def.regex, def.flags], c, ([args, regex, flags]) => {
      const a = this.toArray(args);
      const str = this.toString(a[0]);
      if (regexMode("split", regex, flags)) return str.split(compileRegex(this.regexCache, "split", a[1], flags, false));
      if (a.length < 2) return str.split("");
      return str.split(this.toString(a[1]));
    });
  }

  join(def: Record<string, unknown>, c: Context) {
    return resolveAll([def.$join, def.separator], c, ([items, separator]) =>
      this.toArray(items).map(v => this.toString(v)).join(this.toString(separator ?? ",")),
    );
  }

  padStart(def: Record<string, unknown>, c: Context) {
    return resolve(def.$padStart, c, args => doPad(args, "start"));
  }

  padEnd(def: Record<string, unknown>, c: Context) {
    return resolve(def.$padEnd, c, args => doPad(args, "end"));
  }

  repeat(def: Record<string, unknown>, c: Context) {
    return resolve(def.$repeat, c, args => {
      const a = this.toArray(args);
      return this.toString(a[0]).repeat(Math.max(0, this.toNumber(a[1])));
    });
  }

  startsWith(def: Record<string, unknown>, c: Context) {
    return resolve(def.$startsWith, c, args => {
      const a = this.toArray(args);
      return this.toString(a[0]).startsWith(this.toString(a[1]));
    });
  }

  endsWith(def: Record<string, unknown>, c: Context) {
    return resolve(def.$endsWith, c, args => {
      const a = this.toArray(args);
      return this.toString(a[0]).endsWith(this.toString(a[1]));
    });
  }

  contains(def: Record<string, unknown>, c: Context) {
    return resolveAll([def.$contains, def.regex, def.flags], c, ([args, regex, flags]) => {
      const a = this.toArray(args);
      const str = this.toString(a[0]);
      if (regexMode("contains", regex, flags)) return compileRegex(this.regexCache, "contains", a[1], flags, false).test(str);
      return str.includes(this.toString(a[1]));
    });
  }

  match(def: Record<string, unknown>, c: Context) {
    return resolveAll([def.$match, def.all, def.capture, def.flags], c, ([args, all, capture, flags]) => {
      const a = this.toArray(args);
      const str = this.toString(a[0]);
      const pick = capture == null ? toMatchObject : (m: RegExpMatchArray) => captureOf(m, capture);
      if (this.toBoolean(all)) {
        return [...str.matchAll(compileRegex(this.regexCache, "match", a[1], flags, true))].map(m => pick(m));
      }
      const m = compileRegex(this.regexCache, "match", a[1], flags, false).exec(str);
      return m ? pick(m) : null;
    });
  }

  escapeRegex(def: Record<string, unknown>, c: Context) {
    return resolve(def.$escapeRegex, c, v => this.toString(v).replace(REGEX_SPECIALS, "\\$&"));
  }

  normalize(def: Record<string, unknown>, c: Context) {
    return resolveAll([def.$normalize, def.form], c, ([v, form]) => {
      const f = NORMALIZE_FORMS.has(String(form)) ? String(form) as NormalizationForm : "NFC";
      return this.toString(v).normalize(f);
    });
  }

  segment(def: Record<string, unknown>, c: Context) {
    return resolveAll([def.$segment, def.granularity, def.locale], c, ([v, gran, locale]) => {
      const granularity = gran === "word" || gran === "sentence" ? gran : "grapheme";
      const seg = new Intl.Segmenter(locale != null ? this.toString(locale) : undefined, { granularity });
      const out: string[] = [];
      for (const s of seg.segment(this.toString(v))) out.push(s.segment);
      return out;
    });
  }

  /**
   * Compiled patterns, per instance so one resolver's templates never evict
   * another's. FIFO-bounded; a hit is a single `Map.get`.
   */
  private readonly regexCache = new Map<string, RegExp>();
}

type NormalizationForm = "NFC" | "NFD" | "NFKC" | "NFKD";
const NORMALIZE_FORMS = new Set<string>(["NFC", "NFD", "NFKC", "NFKD"]);

const REGEX_CACHE_MAX = 200;
const REGEX_CACHE_MAX_SOURCE = 1024;
const REGEX_FLAGS = /^(?!.*(.).*\1)[imsuv]*$/;

/** Whether an op runs in regex mode. `flags` on a literal search is refused
 *  rather than ignored, since the step would not do what it says. */
function regexMode(op: string, regex: unknown, flags: unknown): boolean {
  if (toBooleanValue(regex)) return true;
  if (flags != null) throw new Error(`$${op}: "flags" applies only with "regex": true`);
  return false;
}

/** Compile `pattern` with `flags` (plus `g` when `global`) through `cache`. */
function compileRegex(
  cache: Map<string, RegExp>,
  op: string,
  pattern: unknown,
  flags: unknown,
  global: boolean,
): RegExp {
  const source = toStringValue(pattern);
  const own = flags == null ? "" : toStringValue(flags);
  if (!REGEX_FLAGS.test(own)) {
    throw new Error(`Invalid regex flags "${own}" in $${op}: use i, m, s, u or v, each once; match once or everywhere with "all"`);
  }
  const key = own + (global ? "g" : "") + "\0" + source;
  const hit = cache.get(key);
  if (hit) {
    hit.lastIndex = 0;
    return hit;
  }
  let re: RegExp;
  try {
    re = new RegExp(source, global ? own + "g" : own);
  } catch (e) {
    throw new Error(`Invalid regex "${source}" in $${op}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (source.length <= REGEX_CACHE_MAX_SOURCE) {
    // size >= MAX guarantees at least one entry, so the oldest key is non-null.
    if (cache.size >= REGEX_CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(key, re);
  }
  return re;
}

/** A match as plain JSON: groups that took no part come back `null`, not `undefined`. */
function toMatchObject(m: RegExpMatchArray): Record<string, unknown> {
  const groups: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(m.groups ?? {})) groups[name] = value ?? null;
  return { match: m[0], index: m.index ?? 0, captures: m.slice(1).map(v => v ?? null), groups };
}

/** One group's text: a number picks a numbered group (0 the whole match), a
 *  string a named one. A name the pattern does not define is a template bug. */
function captureOf(m: RegExpMatchArray, capture: unknown): string | null {
  if (typeof capture === "number") return m[capture] ?? null;
  const name = String(capture);
  if (!m.groups || !(name in m.groups)) throw new Error(`$match: the pattern has no group named "${name}"`);
  return m.groups[name] ?? null;
}

// Slug normalization regexes and the escapeRegex set, hoisted out of the per-call
// chain. All are used only with String.replace (which resets lastIndex), so the
// shared `/g` consts are safe — do not call .test()/.exec() on them.
const SLUG_DIACRITICS = /[̀-ͯ]/g;
const SLUG_NON_ALNUM = /[^a-z0-9\s-]/g;
const SLUG_SPACES = /\s+/g;
const SLUG_DASHES = /-+/g;
const SLUG_EDGE_DASHES = /^-|-$/g;
// The syntax characters plus `/`: every escape here is valid under the `u` and
// `v` flags too. `-` is left alone, since `\-` is a syntax error under both and
// `-` is only special inside a character class.
const REGEX_SPECIALS = /[\\^$.*+?()[\]{}|/]/g;

function doPad(args: unknown, side: "start" | "end"): string {
  const a = Array.isArray(args) ? (args as unknown[]) : args != null ? [args] : [];
  const str = String(a[0] ?? "");
  const length = Number(a[1]) || 0;
  const padChar = a.length > 2 ? String(a[2] ?? "") : " ";
  return side === "start" ? str.padStart(length, padChar) : str.padEnd(length, padChar);
}
