import { Node, Context } from "./Node.js";
import { resolve } from "../Resolver.js";
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
      markdownDescription: "Replaces all occurrences of a substring.",
      examples: [
        "{ \"replace\": [\"foo foo\", \"foo\", \"bar\"] }",
      ],
    },
    replaceFirst: {
      tuple: 3,
      output: "string",
      markdownDescription: "Replaces only the first occurrence of a substring.",
      examples: [
        "{ \"replaceFirst\": [\"foo foo\", \"foo\", \"bar\"] }",
      ],
    },
    split: {
      tuple: 2,
      output: "array",
      markdownDescription: "Splits a string into an array.",
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
      markdownDescription: "Returns `true` if a string contains the given substring.",
      examples: [
        "{ \"contains\": [\"hello world\", \"world\"] }",
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
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
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
    return resolve(def.replace, c, args => doReplace(args, true));
  }

  replaceFirst(def: Record<string, unknown>, c: Context) {
    return resolve(def.replaceFirst, c, args => doReplace(args, false));
  }

  split(def: Record<string, unknown>, c: Context) {
    return resolve(def.split, c, args => {
      const a = this.toArray(args);
      return this.toString(a[0]).split(a.length > 1 ? this.toString(a[1]) : "");
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
