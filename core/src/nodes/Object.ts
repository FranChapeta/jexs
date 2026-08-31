import { Node, Context, childContext } from "./Node.js";
import { resolve } from "../Resolver.js";
import type { JexsNodeSchema } from "../schema.js";

export class ObjectNode extends Node {
  static schema: JexsNodeSchema = {
    keys: {
      output: "array",
      markdownDescription: "Returns the keys of an object, or string indices of an array.",
      examples: [
        "{ \"keys\": { \"var\": \"$obj\" } }",
      ],
    },
    values: {
      output: "array",
      markdownDescription: "Returns the values of an object as an array.",
      examples: [
        "{ \"values\": { \"var\": \"$obj\" } }",
      ],
    },
    entries: {
      output: "array",
      markdownDescription: "Returns `[{ key, value }]` pairs from an object or array. Inverse of `fromEntries` (in the array node).",
      examples: [
        "{ \"entries\": { \"var\": \"$obj\" } }",
      ],
    },
    pick: {
      tuple: 2,
      output: "object",
      markdownDescription: "Returns a new object containing only the listed top-level keys. Keys absent from the source are skipped.",
      examples: [
        "{ \"pick\": [{ \"var\": \"$user\" }, [\"id\", \"name\"]] }",
      ],
    },
    omit: {
      tuple: 2,
      output: "object",
      markdownDescription: "Returns a new object with the listed top-level keys removed.",
      examples: [
        "{ \"omit\": [{ \"var\": \"$user\" }, [\"password\"]] }",
      ],
    },
    mapValues: {
      output: "object",
      markdownDescription: "Transforms each value of an object, keeping its keys. Each iteration exposes the value as `item` (rename via the `item` sibling), the current `key`, and `loop`.\nWhen `do` is an array it is resolved as a literal (all elements), not as sequential steps.",
      examples: [
        "{ \"mapValues\": { \"var\": \"$scores\" }, \"do\": { \"multiply\": [{ \"var\": \"item\" }, 2] } }",
      ],
      siblings: {
        item: {
          type: "string",
          description: "Variable name for the current value (default `\"item\"`).",
        },
        do: {
          required: true,
          description: "Template to resolve for each value.",
        },
      },
    },
    deepMerge: {
      type: "array",
      output: "object",
      markdownDescription: "Recursively merges multiple objects (later keys win). Nested plain objects merge; arrays and primitive values are replaced. For a shallow merge, or to concatenate arrays, use `merge`.",
      examples: [
        "{ \"deepMerge\": [{ \"var\": \"$defaults\" }, { \"var\": \"$overrides\" }] }",
      ],
    },
  };

  keys(def: Record<string, unknown>, c: Context) {
    return resolve(def.keys, c, value => {
      if (this.isObject(value)) return Object.keys(value);
      if (Array.isArray(value)) return value.map((_, i) => String(i));
      return [];
    });
  }

  values(def: Record<string, unknown>, c: Context) {
    return resolve(def.values, c, value => {
      if (this.isObject(value)) return Object.values(value);
      if (Array.isArray(value)) return value;
      return [];
    });
  }

  entries(def: Record<string, unknown>, c: Context) {
    return resolve(def.entries, c, value => {
      if (this.isObject(value)) return Object.entries(value).map(([key, val]) => ({ key, value: val }));
      if (Array.isArray(value)) return value.map((val, i) => ({ key: String(i), value: val }));
      return [];
    });
  }

  pick(def: Record<string, unknown>, c: Context) {
    return resolve(def.pick, c, args => {
      const a = this.toArray(args);
      const obj = this.isObject(a[0]) ? a[0] : {};
      const result: Record<string, unknown> = {};
      for (const k of this.toArray(a[1])) {
        const key = this.toString(k);
        if (key in obj) result[key] = obj[key];
      }
      return result;
    });
  }

  omit(def: Record<string, unknown>, c: Context) {
    return resolve(def.omit, c, args => {
      const a = this.toArray(args);
      const obj = this.isObject(a[0]) ? a[0] : {};
      const drop = new Set(this.toArray(a[1]).map(k => this.toString(k)));
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(obj)) if (!drop.has(key)) result[key] = obj[key];
      return result;
    });
  }

  mapValues(def: Record<string, unknown>, context: Context) {
    const itemName = typeof def.item === "string" ? def.item : "item";
    const template = def.do;
    if (template === undefined) throw new Error("mapValues needs a `do` template");
    return resolve(def.mapValues, context, obj => {
      if (!this.isObject(obj)) return {};
      const record = obj; // const preserves the narrowed type into the closure below
      const keys = Object.keys(record);
      const result: Record<string, unknown> = {};
      let i = 0;
      function next(): unknown {
        if (i >= keys.length) return result;
        const idx = i++;
        const key = keys[idx];
        const item = record[key];
        const itemCtx: Context = childContext(context, {
          [itemName]: item,
          key,
          loop: { item, index: idx, key, first: idx === 0, last: idx === keys.length - 1, length: keys.length },
        });
        return resolve(template, itemCtx, v => { result[key] = v; return next(); });
      }
      return next();
    });
  }

  deepMerge(def: Record<string, unknown>, c: Context) {
    return resolve(def.deepMerge, c, args => {
      const result: Record<string, unknown> = {};
      for (const obj of this.toArray(args)) {
        if (isPlainObject(obj)) mergeInto(result, obj);
      }
      return result;
    });
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Recursively merge `source` into `target`, cloning before recursing so the
 *  input objects are never mutated. Arrays and primitives replace (later wins). */
function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (isPlainObject(tv) && isPlainObject(sv)) {
      const merged = { ...tv };
      mergeInto(merged, sv);
      target[key] = merged;
    } else {
      target[key] = sv;
    }
  }
}
