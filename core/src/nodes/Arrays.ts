import { Node, Context } from "./Node.js";
import { resolve, resolveAll } from "../Resolver.js";
import { getNestedValue } from "../helpers.js";
import type { JexsNodeSchema } from "../schema.js";

export class ArrayNode extends Node {
  static schema: JexsNodeSchema = {
    first: {
      markdownDescription: "Returns the first element of an array.",
      outputDescription: "The first element (any type), or `undefined` if the array is empty.",
      examples: [
        "{ \"first\": { \"var\": \"$items\" } }",
      ],
    },
    last: {
      markdownDescription: "Returns the last element of an array.",
      outputDescription: "The last element (any type), or `undefined` if the array is empty.",
      examples: [
        "{ \"last\": { \"var\": \"$items\" } }",
      ],
    },
    count: {
      output: "number",
      markdownDescription: "Returns the length of an array, object (key count), or string.",
      examples: [
        "{ \"count\": { \"var\": \"$items\" } }",
      ],
    },
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
    reverse: {
      output: "array",
      markdownDescription: "Returns a new array with elements in reverse order.",
      examples: [
        "{ \"reverse\": { \"var\": \"$items\" } }",
      ],
    },
    unique: {
      output: "array",
      markdownDescription: "Removes duplicate values using strict equality.",
      examples: [
        "{ \"unique\": [1, 2, 2, 3] }",
      ],
    },
    flatten: {
      output: "array",
      markdownDescription: "Recursively flattens a nested array.",
      examples: [
        "{ \"flatten\": [[1, [2, [3]]]] }",
      ],
    },
    sort: {
      output: "array",
      markdownDescription: "Sorts an array ascending (numbers numerically, strings lexicographically).",
      examples: [
        "{ \"sort\": [3, 1, 2] }",
      ],
    },
    sortDesc: {
      output: "array",
      markdownDescription: "Sorts an array descending.",
      examples: [
        "{ \"sortDesc\": [3, 1, 2] }",
      ],
    },
    sortBy: {
      type: "array",
      output: "array",
      markdownDescription: "Sorts an array of objects by a key. Direction is `\"asc\"` (default) or `\"desc\"`.",
      examples: [
        "{ \"sortBy\": [{ \"var\": \"$users\" }, \"name\", \"desc\"] }",
      ],
    },
    pluck: {
      tuple: 2,
      output: "array",
      markdownDescription: "Extracts the value of a key (dot-path) from each object in an array.",
      outputDescription: "An array of each object's value at the key — `undefined` in slots where the object lacks it.",
      examples: [
        "{ \"pluck\": [{ \"var\": \"$users\" }, \"name\"] }",
      ],
    },
    slice: {
      tuple: [
        2,
        3,
      ],
      output: "array",
      markdownDescription: "Returns a portion of an array.",
      examples: [
        "{ \"slice\": [{ \"var\": \"$items\" }, 0, 5] }",
      ],
    },
    push: {
      tuple: 2,
      output: "array",
      markdownDescription: "Returns a new array with an item appended.",
      examples: [
        "{ \"push\": [{ \"var\": \"$items\" }, \"new\"] }",
      ],
    },
    unshift: {
      tuple: 2,
      output: "array",
      markdownDescription: "Returns a new array with an item prepended.",
      examples: [
        "{ \"unshift\": [{ \"var\": \"$items\" }, \"first\"] }",
      ],
    },
    merge: {
      type: "array",
      markdownDescription: "Merges multiple arrays (concatenation) or multiple objects (shallow merge).",
      outputDescription: "A single shallow-merged **object** when every input is a plain object (later keys win); otherwise all inputs concatenated into one **array**.",
      examples: [
        "{ \"merge\": [{ \"a\": 1 }, { \"b\": 2 }] }",
      ],
    },
    filter: {
      tuple: 2,
      output: "array",
      markdownDescription: "Returns the items of an array for which a condition is truthy. Tuple form: `[<array>, <condition>]`.\nEach iteration exposes the current element as `item` (rename via the `item`/`index` siblings), plus `index` and `loop`. Read the element with `{ \"var\": \"item\" }` — a leading `$` is optional.",
      examples: [
        "{ \"filter\": [{ \"var\": \"$nums\" }, { \"gt\": [{ \"var\": \"item\" }, 2] }] }",
        "{ \"filter\": [{ \"var\": \"$users\" }, { \"eq\": [{ \"var\": \"u.role\" }, \"admin\"] }], \"item\": \"u\" }",
      ],
      siblings: {
        item: {
          type: "string",
          description: "Variable name for the current item (default `\"item\"`).",
        },
        index: {
          type: "string",
          description: "Variable name for the current index (default `\"index\"`).",
        },
      },
    },
    find: {
      tuple: 2,
      markdownDescription: "Returns the first item of an array for which a condition is truthy. Tuple form: `[<array>, <condition>]`.\nEach iteration exposes the current element as `item` (rename via the `item`/`index` siblings), plus `index` and `loop`. Read the element with `{ \"var\": \"item\" }` — a leading `$` is optional.",
      outputDescription: "The first matching item (any type), or `undefined` if none match.",
      examples: [
        "{ \"find\": [{ \"var\": \"$users\" }, { \"eq\": [{ \"var\": \"item.role\" }, \"admin\"] }] }",
        "{ \"find\": [{ \"var\": \"$users\" }, { \"eq\": [{ \"var\": \"u.role\" }, \"admin\"] }], \"item\": \"u\" }",
      ],
      siblings: {
        item: {
          type: "string",
          description: "Variable name for the current item (default `\"item\"`).",
        },
        index: {
          type: "string",
          description: "Variable name for the current index (default `\"index\"`).",
        },
      },
    },
    map: {
      output: "array",
      markdownDescription: "Transforms each item by resolving a template.\nEach iteration exposes the named variable (default `item`), `index`, and `loop` in context.\nWhen `do` is an array it is resolved as a literal (all elements), not as sequential steps.",
      examples: [
        "{ \"map\": { \"var\": \"$nums\" }, \"as\": \"num\", \"do\": { \"multiply\": [{ \"var\": \"$num\" }, 2] } }",
      ],
      siblings: {
        item: {
          type: "string",
          description: "Variable name for the current item (default `\"item\"`).",
        },
        do: {
          description: "Template to resolve for each item.",
        },
      },
    },
    reduce: {
      tuple: 3,
      markdownDescription: "Reduces an array to a single value. Tuple form: `[<array>, <reducer>, <initial>]`.\nEach iteration exposes the current element as `item` (rename via the `item`/`index` siblings), plus `index`, `accumulator`, and `loop`. Read them with `{ \"var\": \"item\" }` / `{ \"var\": \"accumulator\" }` — a leading `$` is optional.",
      outputDescription: "The final accumulator value — its type follows the reducer/initial value (the initial value is returned as-is for an empty array).",
      examples: [
        "{ \"reduce\": [{ \"var\": \"$nums\" }, { \"add\": [{ \"var\": \"accumulator\" }, { \"var\": \"item\" }] }, 0] }",
        "{ \"reduce\": [{ \"var\": \"$nums\" }, { \"add\": [{ \"var\": \"accumulator\" }, { \"var\": \"n\" }] }, 0], \"item\": \"n\" }",
      ],
      siblings: {
        item: {
          type: "string",
          description: "Variable name for the current item (default `\"item\"`).",
        },
        index: {
          type: "string",
          description: "Variable name for the current index (default `\"index\"`).",
        },
      },
    },
    groupBy: {
      tuple: 2,
      output: "object",
      markdownDescription: "Groups an array of objects by a key. Returns an object keyed by group values.",
      outputDescription: "An object mapping each distinct group-key (stringified) to the **array** of items in that group.",
      examples: [
        "{ \"groupBy\": [{ \"var\": \"$users\" }, \"role\"] }",
      ],
    },
    includes: {
      tuple: [
        2,
        3,
      ],
      output: "boolean",
      markdownDescription: "Checks if an array contains a value: `[arr, value]`.\nWith three arguments `[arr, key, value]`, checks if any object has that key-value pair.",
      examples: [
        "{ \"includes\": [{ \"var\": \"$roles\" }, \"admin\"] }",
      ],
    },
    index: {
      tuple: 2,
      markdownDescription: "Returns the element at a given index.",
      outputDescription: "The element at the index (any type), or `undefined` if out of range.",
      examples: [
        "{ \"index\": [{ \"var\": \"$items\" }, 2] }",
      ],
    },
    range: {
      tuple: [
        2,
        3,
      ],
      output: "array",
      markdownDescription: "Generates a numeric sequence. Inclusive on both ends.",
      examples: [
        "{ \"range\": [1, 5] }",
      ],
    },
    entries: {
      output: "array",
      markdownDescription: "Returns `[{ key, value }]` pairs from an object or array.",
      examples: [
        "{ \"entries\": { \"var\": \"$obj\" } }",
      ],
    },
  };

  first(def: Record<string, unknown>, c: Context) {
    return resolve(def.first, c, v => this.toArray(v)[0]);
  }

  last(def: Record<string, unknown>, c: Context) {
    return resolve(def.last, c, v => { const a = this.toArray(v); return a[a.length - 1]; });
  }

  count(def: Record<string, unknown>, c: Context) {
    return resolve(def.count, c, value => {
      if (Array.isArray(value)) return value.length;
      if (this.isObject(value)) return Object.keys(value).length;
      if (typeof value === "string") return value.length;
      return 0;
    });
  }

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

  reverse(def: Record<string, unknown>, c: Context) {
    return resolve(def.reverse, c, v => [...this.toArray(v)].reverse());
  }

  unique(def: Record<string, unknown>, c: Context) {
    return resolve(def.unique, c, v => [...new Set(this.toArray(v))]);
  }

  flatten(def: Record<string, unknown>, c: Context) {
    return resolve(def.flatten, c, v => this.toArray(v).flat(Infinity));
  }

  sort(def: Record<string, unknown>, c: Context) {
    return resolve(def.sort, c, v => doSort(v, false));
  }

  sortDesc(def: Record<string, unknown>, c: Context) {
    return resolve(def.sortDesc, c, v => doSort(v, true));
  }

  sortBy(def: Record<string, unknown>, c: Context) {
    return resolve(def.sortBy, c, args => {
      const a = this.toArray(args);
      const arr = this.toArray(a[0]);
      const key = this.toString(a[1]);
      const direction = a.length > 2 && a[2] === "desc" ? -1 : 1;
      return [...arr].sort((x, y) => {
        const xVal = this.isObject(x) ? (x as Record<string, unknown>)[key] : undefined;
        const yVal = this.isObject(y) ? (y as Record<string, unknown>)[key] : undefined;
        if (typeof xVal === "number" && typeof yVal === "number") return (xVal - yVal) * direction;
        return this.toString(xVal).localeCompare(this.toString(yVal)) * direction;
      });
    });
  }

  pluck(def: Record<string, unknown>, c: Context) {
    return resolve(def.pluck, c, args => {
      const a = this.toArray(args);
      const arr = this.toArray(a[0]);
      const key = this.toString(a[1]);
      return arr.map(item => this.isObject(item) ? getNestedValue(item, key) : undefined);
    });
  }

  slice(def: Record<string, unknown>, c: Context) {
    return resolve(def.slice, c, args => {
      const a = this.toArray(args);
      const arr = this.toArray(a[0]);
      const start = this.toNumber(a[1]);
      const end = a.length > 2 ? this.toNumber(a[2]) : undefined;
      return arr.slice(start, end);
    });
  }

  push(def: Record<string, unknown>, c: Context) {
    return resolve(def.push, c, args => {
      const a = this.toArray(args);
      return [...this.toArray(a[0]), a.length > 1 ? a[1] : undefined];
    });
  }

  unshift(def: Record<string, unknown>, c: Context) {
    return resolve(def.unshift, c, args => {
      const a = this.toArray(args);
      return [a.length > 1 ? a[1] : undefined, ...this.toArray(a[0])];
    });
  }

  merge(def: Record<string, unknown>, c: Context) {
    return resolve(def.merge, c, args => {
      const resolved = this.toArray(args);
      if (resolved.length > 0 && resolved.every(r => this.isObject(r) && !Array.isArray(r))) {
        const result: Record<string, unknown> = {};
        for (const obj of resolved) Object.assign(result, obj as Record<string, unknown>);
        return result;
      }
      return resolved.reduce((acc: unknown[], r) => [...acc, ...this.toArray(r)], []);
    });
  }

  filter(def: Record<string, unknown>, context: Context) {
    const args = this.toArray(def.filter);
    return resolveAll([def.item, def.index], context, ([itemRaw, indexRaw]) => {
      const itemName = typeof itemRaw === "string" ? itemRaw : "item";
      const indexName = typeof indexRaw === "string" ? indexRaw : "index";
      return resolve(args[0], context, arr => {
        const items = this.toArray(arr);
        const condition = args[1];
        const results: unknown[] = [];
        let i = 0;
        const self = this;
        function next(): unknown {
          if (i >= items.length) return results;
          const idx = i++;
          const item = items[idx];
          const itemCtx: Context = {
            ...context, [itemName]: item, [indexName]: idx,
            loop: { item, index: idx, key: idx, first: idx === 0, last: idx === items.length - 1, length: items.length },
          };
          return resolve(condition, itemCtx, v => {
            if (self.toBoolean(v)) results.push(item);
            return next();
          });
        }
        return next();
      });
    });
  }

  find(def: Record<string, unknown>, context: Context) {
    const args = this.toArray(def.find);
    return resolveAll([def.item, def.index], context, ([itemRaw, indexRaw]) => {
      const itemName = typeof itemRaw === "string" ? itemRaw : "item";
      const indexName = typeof indexRaw === "string" ? indexRaw : "index";
      return resolve(args[0], context, arr => {
        const items = this.toArray(arr);
        const condition = args[1];
        let i = 0;
        const self = this;
        function next(): unknown {
          if (i >= items.length) return undefined;
          const idx = i++;
          const item = items[idx];
          const itemCtx: Context = {
            ...context, [itemName]: item, [indexName]: idx,
            loop: { item, index: idx, key: idx, first: idx === 0, last: idx === items.length - 1, length: items.length },
          };
          return resolve(condition, itemCtx, v => {
            if (self.toBoolean(v)) return item;
            return next();
          });
        }
        return next();
      });
    });
  }

  map(def: Record<string, unknown>, context: Context) {
    const itemName = typeof def.item === "string" ? def.item : "item";
    const template = def.do;
    return resolve(def.map, context, arr => {
      const items = this.toArray(arr);
      const results: unknown[] = [];
      let i = 0;
      function next(): unknown {
        if (i >= items.length) return results;
        const idx = i++;
        const item = items[idx];
        const itemCtx: Context = {
          ...context,
          [itemName]: item,
          loop: { item, index: idx, key: idx, first: idx === 0, last: idx === items.length - 1, length: items.length },
        };
        return resolve(template, itemCtx, v => { results.push(v); return next(); });
      }
      return next();
    });
  }

  reduce(def: Record<string, unknown>, context: Context) {
    const args = this.toArray(def.reduce);
    return resolveAll([def.item, def.index], context, ([itemRaw, indexRaw]) => {
      const itemName = typeof itemRaw === "string" ? itemRaw : "item";
      const indexName = typeof indexRaw === "string" ? indexRaw : "index";
      return resolve(args[0], context, arr => {
        const items = this.toArray(arr);
        const reducer = args[1];
        return resolve(args.length > 2 ? args[2] : undefined, context, initial => {
          let accumulator: unknown = initial;
          let i = 0;
          function next(): unknown {
            if (i >= items.length) return accumulator;
            const idx = i++;
            const item = items[idx];
            const itemCtx: Context = {
              ...context, [itemName]: item, [indexName]: idx, accumulator,
              loop: { item, index: idx, key: idx, first: idx === 0, last: idx === items.length - 1, length: items.length },
            };
            return resolve(reducer, itemCtx, v => { accumulator = v; return next(); });
          }
          return next();
        });
      });
    });
  }

  groupBy(def: Record<string, unknown>, c: Context) {
    return resolve(def.groupBy, c, args => {
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

  includes(def: Record<string, unknown>, c: Context) {
    return resolve(def.includes, c, args => {
      const a = this.toArray(args);
      const arr = this.toArray(a[0]);
      if (a.length >= 3) {
        const key = this.toString(a[1]);
        const value = a[2];
        return arr.some(item => this.isObject(item) && (item as Record<string, unknown>)[key] === value);
      }
      return arr.includes(a[1]);
    });
  }

  index(def: Record<string, unknown>, c: Context) {
    return resolve(def.index, c, args => {
      const a = this.toArray(args);
      return this.toArray(a[0])[this.toNumber(a[1])];
    });
  }

  range(def: Record<string, unknown>, c: Context) {
    return resolve(def.range, c, args => {
      const a = this.toArray(args);
      const start = this.toNumber(a[0]);
      const end = this.toNumber(a[1]);
      const step = a.length > 2 ? this.toNumber(a[2]) : 1;
      if (step === 0) return [];
      const result: number[] = [];
      if (step > 0) { for (let i = start; i <= end; i += step) result.push(i); }
      else { for (let i = start; i >= end; i += step) result.push(i); }
      return result;
    });
  }

  entries(def: Record<string, unknown>, c: Context) {
    return resolve(def.entries, c, value => {
      if (this.isObject(value)) return Object.entries(value).map(([key, val]) => ({ key, value: val }));
      if (Array.isArray(value)) return value.map((val, i) => ({ key: String(i), value: val }));
      return [];
    });
  }
}

function doSort(value: unknown, desc: boolean): unknown[] {
  const arr = Array.isArray(value) ? value : value != null ? [value] : [];
  const sorted = [...arr].sort((a, b) => {
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a ?? "").localeCompare(String(b ?? ""));
  });
  return desc ? sorted.reverse() : sorted;
}
