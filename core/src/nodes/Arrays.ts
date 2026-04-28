import { Node, Context } from "./Node.js";
import { resolve } from "../Resolver.js";
import { getNestedValue } from "../helpers.js";

export class ArrayNode extends Node {
  /** Returns the first element of an array. @example { "first": { "var": "$items" } } */
  first(def: Record<string, unknown>, c: Context) {
    return resolve(def.first, c, v => this.toArray(v)[0]);
  }

  /** Returns the last element of an array. @example { "last": { "var": "$items" } } */
  last(def: Record<string, unknown>, c: Context) {
    return resolve(def.last, c, v => { const a = this.toArray(v); return a[a.length - 1]; });
  }

  /** Returns the length of an array, object (key count), or string. @example { "count": { "var": "$items" } } */
  count(def: Record<string, unknown>, c: Context) {
    return resolve(def.count, c, value => {
      if (Array.isArray(value)) return value.length;
      if (this.isObject(value)) return Object.keys(value).length;
      if (typeof value === "string") return value.length;
      return 0;
    });
  }

  /** Returns the keys of an object, or string indices of an array. @example { "keys": { "var": "$obj" } } */
  keys(def: Record<string, unknown>, c: Context) {
    return resolve(def.keys, c, value => {
      if (this.isObject(value)) return Object.keys(value);
      if (Array.isArray(value)) return value.map((_, i) => String(i));
      return [];
    });
  }

  /** Returns the values of an object as an array. @example { "values": { "var": "$obj" } } */
  values(def: Record<string, unknown>, c: Context) {
    return resolve(def.values, c, value => {
      if (this.isObject(value)) return Object.values(value);
      if (Array.isArray(value)) return value;
      return [];
    });
  }

  /** Returns a new array with elements in reverse order. @example { "reverse": { "var": "$items" } } */
  reverse(def: Record<string, unknown>, c: Context) {
    return resolve(def.reverse, c, v => [...this.toArray(v)].reverse());
  }

  /** Removes duplicate values using strict equality. @example { "unique": [1, 2, 2, 3] } */
  unique(def: Record<string, unknown>, c: Context) {
    return resolve(def.unique, c, v => [...new Set(this.toArray(v))]);
  }

  /** Recursively flattens a nested array. @example { "flatten": [[1, [2, [3]]]] } */
  flatten(def: Record<string, unknown>, c: Context) {
    return resolve(def.flatten, c, v => this.toArray(v).flat(Infinity));
  }

  /** Sorts an array ascending (numbers numerically, strings lexicographically). @example { "sort": [3, 1, 2] } */
  sort(def: Record<string, unknown>, c: Context) {
    return resolve(def.sort, c, v => doSort(v, false));
  }

  /** Sorts an array descending. @example { "sortDesc": [3, 1, 2] } */
  sortDesc(def: Record<string, unknown>, c: Context) {
    return resolve(def.sortDesc, c, v => doSort(v, true));
  }

  /**
   * Sorts an array of objects by a key. Direction is `"asc"` (default) or `"desc"`.
   *
   * @param {expr[]} sortBy `[array, key, direction?]` — the array to sort, the key to sort by, and optional direction.
   * @example
   * { "sortBy": [{ "var": "$users" }, "name", "desc"] }
   */
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

  /**
   * Extracts the value of a key from each object in an array.
   *
   * @param {[2]} pluck `[array, key]`.
   * @example
   * { "pluck": [{ "var": "$users" }, "name"] }
   */
  pluck(def: Record<string, unknown>, c: Context) {
    return resolve(def.pluck, c, args => {
      const a = this.toArray(args);
      const arr = this.toArray(a[0]);
      const key = this.toString(a[1]);
      return arr.map(item => this.isObject(item) ? getNestedValue(item, key) : undefined);
    });
  }

  /**
   * Returns a portion of an array.
   *
   * @param {[2,3]} slice `[array, start, end?]`.
   * @example
   * { "slice": [{ "var": "$items" }, 0, 5] }
   */
  slice(def: Record<string, unknown>, c: Context) {
    return resolve(def.slice, c, args => {
      const a = this.toArray(args);
      const arr = this.toArray(a[0]);
      const start = this.toNumber(a[1]);
      const end = a.length > 2 ? this.toNumber(a[2]) : undefined;
      return arr.slice(start, end);
    });
  }

  /**
   * Returns a new array with an item appended.
   *
   * @param {[2]} push `[array, item]`.
   * @example
   * { "push": [{ "var": "$items" }, "new"] }
   */
  push(def: Record<string, unknown>, c: Context) {
    return resolve(def.push, c, args => {
      const a = this.toArray(args);
      return [...this.toArray(a[0]), a.length > 1 ? a[1] : undefined];
    });
  }

  /**
   * Returns a new array with an item prepended.
   *
   * @param {[2]} unshift `[array, item]`.
   * @example
   * { "unshift": [{ "var": "$items" }, "first"] }
   */
  unshift(def: Record<string, unknown>, c: Context) {
    return resolve(def.unshift, c, args => {
      const a = this.toArray(args);
      return [a.length > 1 ? a[1] : undefined, ...this.toArray(a[0])];
    });
  }

  /**
   * Merges multiple arrays (concatenation) or multiple objects (shallow merge).
   *
   * @param {expr[]} merge Arrays or objects to merge.
   * @example
   * { "merge": [{ "a": 1 }, { "b": 2 }] }
   */
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

  /**
   * Returns items for which the condition expression is truthy.
   * Each iteration exposes `item`, `index`, and `loop` in context.
   *
   * @param {[2]} filter `[array, condition]`.
   * @example
   * { "filter": [{ "var": "$nums" }, { "gt": [{ "var": "item" }, 2] }] }
   */
  filter(def: Record<string, unknown>, context: Context) {
    const args = this.toArray(def.filter);
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
          ...context, item, index: idx,
          loop: { item, index: idx, key: idx, first: idx === 0, last: idx === items.length - 1, length: items.length },
        };
        return resolve(condition, itemCtx, v => {
          if (self.toBoolean(v)) results.push(item);
          return next();
        });
      }
      return next();
    });
  }

  /**
   * Returns the first item for which the condition is truthy.
   * Each iteration exposes `item`, `index`, and `loop` in context.
   *
   * @param {[2]} find `[array, condition]`.
   * @example
   * { "find": [{ "var": "$users" }, { "eq": [{ "var": "item.role" }, "admin"] }] }
   */
  find(def: Record<string, unknown>, context: Context) {
    const args = this.toArray(def.find);
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
          ...context, item, index: idx,
          loop: { item, index: idx, key: idx, first: idx === 0, last: idx === items.length - 1, length: items.length },
        };
        return resolve(condition, itemCtx, v => {
          if (self.toBoolean(v)) return item;
          return next();
        });
      }
      return next();
    });
  }

  /**
   * Transforms each item by resolving a template.
   * Each iteration exposes the named variable (default `item`), `index`, and `loop` in context.
   * When `do` is an array it is resolved as a literal (all elements), not as sequential steps.
   *
   * @param {expr} map The array or expression to iterate over.
   * @param {string} item Variable name for the current item (default `"item"`).
   * @param {expr|expr[]} do Template to resolve for each item.
   * @example
   * { "map": { "var": "$nums" }, "as": "num", "do": { "multiply": [{ "var": "$num" }, 2] } }
   */
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

  /**
   * Reduces an array to a single value.
   * Each iteration exposes `item`, `index`, `accumulator`, and `loop` in context.
   *
   * @param {[3]} reduce `[array, reducer, initial]`.
   * @example
   * { "reduce": [{ "var": "$nums" }, { "add": [{ "var": "accumulator" }, { "var": "item" }] }, 0] }
   */
  reduce(def: Record<string, unknown>, context: Context) {
    const args = this.toArray(def.reduce);
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
            ...context, item, index: idx, accumulator,
            loop: { item, index: idx, key: idx, first: idx === 0, last: idx === items.length - 1, length: items.length },
          };
          return resolve(reducer, itemCtx, v => { accumulator = v; return next(); });
        }
        return next();
      });
    });
  }

  /**
   * Groups an array of objects by a key. Returns an object keyed by group values.
   *
   * @param {[2]} groupBy `[array, key]`.
   * @example
   * { "groupBy": [{ "var": "$users" }, "role"] }
   */
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

  /**
   * Checks if an array contains a value: `[arr, value]`.
   * With three arguments `[arr, key, value]`, checks if any object has that key-value pair.
   *
   * @param {[2,3]} includes `[array, value]` or `[array, key, value]`.
   * @example
   * { "includes": [{ "var": "$roles" }, "admin"] }
   */
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

  /**
   * Returns the element at a given index.
   *
   * @param {[2]} index `[array, index]`.
   * @example
   * { "index": [{ "var": "$items" }, 2] }
   */
  index(def: Record<string, unknown>, c: Context) {
    return resolve(def.index, c, args => {
      const a = this.toArray(args);
      return this.toArray(a[0])[this.toNumber(a[1])];
    });
  }

  /**
   * Generates a numeric sequence. Inclusive on both ends.
   *
   * @param {[2,3]} range `[start, end, step?]`.
   * @example
   * { "range": [1, 5] }
   */
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

  /** Returns `[{ key, value }]` pairs from an object or array. @example { "entries": { "var": "$obj" } } */
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
