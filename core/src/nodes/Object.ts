import { Node, Context, childContext } from "./Node.js";
import { andThen, resolve, resolveAll, runSteps } from "../Resolver.js";
import { getNestedValue, isObject } from "../helpers.js";
import type { JexsNodeSchema } from "../schema.js";

export class ObjectNode extends Node {
  static schema: JexsNodeSchema = {
    keys: {
      output: { type: "array", items: { type: "string" } },
      markdownDescription: "Returns the keys of an object, or string indices of an array.",
      examples: [
        "{ \"$keys\": { \"$var\": \"obj\" } }",
      ],
    },
    values: {
      output: "array",
      markdownDescription: "Returns the values of an object as an array.",
      examples: [
        "{ \"$values\": { \"$var\": \"obj\" } }",
      ],
    },
    entries: {
      output: {
        type: "array",
        items: { type: "object", properties: { key: { type: "string" }, value: { description: "The value under `key`." } } },
      },
      markdownDescription: "Returns `[{ key, value }]` pairs from an object or array. Inverse of `fromEntries` (in the array node).",
      examples: [
        "{ \"$entries\": { \"$var\": \"obj\" } }",
      ],
    },
    pick: {
      tuple: 2,
      prefixItems: [
        { type: "object", description: "The object to pick from." },
        { type: "array", items: { type: "string" }, description: "The keys to keep." },
      ],
      output: "object",
      markdownDescription: "Returns a new object containing only the listed top-level keys. Keys absent from the source are skipped.",
      examples: [
        "{ \"$pick\": [{ \"$var\": \"user\" }, [\"id\", \"name\"]] }",
      ],
    },
    omit: {
      tuple: 2,
      prefixItems: [
        { type: "object", description: "The object to omit from." },
        { type: "array", items: { type: "string" }, description: "The keys to drop." },
      ],
      output: "object",
      markdownDescription: "Returns a new object with the listed top-level keys removed.",
      examples: [
        "{ \"$omit\": [{ \"$var\": \"user\" }, [\"password\"]] }",
      ],
    },
    mapValues: {
      output: "object",
      markdownDescription: "Transforms each value of an object, keeping its keys. Each iteration exposes the value as `item` and its key as `key` (rename via the `item`/`key` siblings).\n`do` runs as steps: an array is a step sequence whose last value (or a `$return`'s) is the value's result.",
      examples: [
        "{ \"$mapValues\": { \"$var\": \"scores\" }, \"do\": { \"$multiply\": [{ \"$var\": \"item\" }, 2] } }",
      ],
      siblings: {
        item: {
          type: "string",
          description: "Variable name for the current value (default `\"item\"`).",
        },
        key: {
          type: "string",
          description: "Variable name for the current key (default `\"key\"`).",
        },
        do: {
          required: true,
          description: "Steps or expression run for each value; its result is the value under the same key.",
        },
      },
    },
    fromEntries: {
      output: "object",
      markdownDescription: "Builds an object from `[{ key, value }]` pairs (the inverse of `entries`). Also accepts `[key, value]` tuple arrays.",
      examples: [
        "{ \"$fromEntries\": { \"$var\": \"pairs\" } }",
      ],
    },
    groupBy: {
      tuple: 2,
      prefixItems: [
        { type: "array", description: "The array of objects to group." },
        { type: "string", description: "The key (dot-path) to group by." },
      ],
      output: "object",
      markdownDescription: "Groups an array of objects by a key. Returns an object keyed by group values.",
      outputDescription: "An object mapping each distinct group-key (stringified) to the **array** of items in that group.",
      examples: [
        "{ \"$groupBy\": [{ \"$var\": \"users\" }, \"role\"] }",
      ],
    },
    merge: {
      type: "array",
      output: "object",
      markdownDescription: "Shallow-merges objects into one (later keys win). For nested objects use `deepMerge`; to concatenate arrays, `flatten` them with `depth: 1`.",
      examples: [
        "{ \"$merge\": [{ \"$var\": \"defaults\" }, { \"theme\": \"dark\" }] }",
      ],
    },
    deepMerge: {
      type: "array",
      output: "object",
      markdownDescription: "Recursively merges multiple objects (later keys win). Nested plain objects merge; arrays and primitive values are replaced. For a shallow merge use `merge`.",
      examples: [
        "{ \"$deepMerge\": [{ \"$var\": \"defaults\" }, { \"$var\": \"overrides\" }] }",
      ],
    },
  };

  keys(def: Record<string, unknown>, c: Context) {
    return resolve(def.$keys, c, value => {
      if (this.isObject(value)) return Object.keys(value);
      if (Array.isArray(value)) return value.map((_, i) => String(i));
      return [];
    });
  }

  values(def: Record<string, unknown>, c: Context) {
    return resolve(def.$values, c, value => {
      if (this.isObject(value)) return Object.values(value);
      if (Array.isArray(value)) return value;
      return [];
    });
  }

  entries(def: Record<string, unknown>, c: Context) {
    return resolve(def.$entries, c, value => {
      if (this.isObject(value)) return Object.entries(value).map(([key, val]) => ({ key, value: val }));
      if (Array.isArray(value)) return value.map((val, i) => ({ key: String(i), value: val }));
      return [];
    });
  }

  pick(def: Record<string, unknown>, c: Context) {
    return resolve(def.$pick, c, args => {
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
    return resolve(def.$omit, c, args => {
      const a = this.toArray(args);
      const obj = this.isObject(a[0]) ? a[0] : {};
      const drop = new Set(this.toArray(a[1]).map(k => this.toString(k)));
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(obj)) if (!drop.has(key)) result[key] = obj[key];
      return result;
    });
  }

  mapValues(def: Record<string, unknown>, context: Context) {
    const template = def.do;
    if (template === undefined) throw new Error("mapValues needs a `do` template");
    // As on the array iterators, the variable names are resolved first, so
    // either may be handed in as an expression.
    return resolveAll([def.item, def.key], context, ([itemRaw, keyRaw]) => {
      const itemName = typeof itemRaw === "string" ? itemRaw : "item";
      const keyName = typeof keyRaw === "string" ? keyRaw : "key";
      return resolve(def.$mapValues, context, obj => {
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
          const itemCtx = childContext(context, { [itemName]: item, [keyName]: key });
          return andThen(runSteps(template, itemCtx), v => { result[key] = v; return next(); });
        }
        return next();
      });
    });
  }

  fromEntries(def: Record<string, unknown>, c: Context) {
    return resolve(def.$fromEntries, c, value => {
      const result: Record<string, unknown> = {};
      for (const e of this.toArray(value)) {
        if (this.isObject(e) && "key" in e) result[this.toString(e.key)] = e.value;
        else if (Array.isArray(e) && e.length === 2) result[this.toString(e[0])] = e[1];
        else throw new Error(`$fromEntries takes { key, value } or [key, value] entries, got ${JSON.stringify(e)}`);
      }
      return result;
    });
  }

  groupBy(def: Record<string, unknown>, c: Context) {
    return resolve(def.$groupBy, c, args => {
      const a = this.toArray(args);
      const arr = this.toArray(a[0]);
      const key = this.toString(a[1]);
      const result: Record<string, unknown[]> = {};
      for (const item of arr) {
        const groupKey = this.isObject(item) ? this.toString(getNestedValue(item, key)) : "";
        if (!result[groupKey]) result[groupKey] = [];
        result[groupKey].push(item);
      }
      return result;
    });
  }

  merge(def: Record<string, unknown>, c: Context) {
    return resolve(def.$merge, c, args => {
      const result: Record<string, unknown> = {};
      for (const obj of this.toArray(args)) {
        if (!this.isObject(obj)) throw new Error("merge takes objects: to concatenate arrays, use `flatten` with `depth: 1`");
        Object.assign(result, obj);
      }
      return result;
    });
  }

  deepMerge(def: Record<string, unknown>, c: Context) {
    return resolve(def.$deepMerge, c, args => {
      const result: Record<string, unknown> = {};
      for (const obj of this.toArray(args)) {
        if (isObject(obj)) mergeInto(result, obj);
      }
      return result;
    });
  }
}

/** Recursively merge `source` into `target`, cloning before recursing so the
 *  input objects are never mutated. Arrays and primitives replace (later wins). */
function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (isObject(tv) && isObject(sv)) {
      const merged = { ...tv };
      mergeInto(merged, sv);
      target[key] = merged;
    } else {
      target[key] = sv;
    }
  }
}
