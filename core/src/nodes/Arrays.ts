import { Node, Context } from "./Node.js";
import { resolve } from "../Resolver.js";
import { getNestedValue } from "../helpers.js";

/**
 * Handles array/collection operations.
 *
 * Supported operations:
 * - { "first": array }                          -> first element
 * - { "last": array }                           -> last element
 * - { "count": array }                          -> length
 * - { "keys": object }                          -> array of keys
 * - { "values": object }                        -> array of values
 * - { "reverse": array }                        -> reversed array
 * - { "unique": array }                         -> deduplicated array
 * - { "flatten": array }                        -> flattened array
 * - { "sort": array }                           -> sorted array (ascending)
 * - { "sortDesc": array }                       -> sorted array (descending)
 * - { "sortBy": [array, "key"] }                -> sort by object key
 * - { "pluck": [array, "key"] }                 -> extract key from each object
 * - { "slice": [array, start, end] }            -> slice array
 * - { "push": [array, item] }                   -> add to end
 * - { "unshift": [array, item] }                -> add to start
 * - { "merge": [array1, array2] }               -> combine arrays
 * - { "filter": [array, condition] }            -> filter with condition
 * - { "find": [array, condition] }              -> find first match
 * - { "map": [array, transform] }               -> transform each item
 * - { "reduce": [array, reducer, initial] }     -> reduce to single value
 * - { "groupBy": [array, "key"] }               -> group by key
 * - { "includes": [array, value] }              -> array.includes(value)
 * - { "includes": [array, "key", value] }       -> array.some(item => item[key] === value)
 * - { "index": [array, index] }                 -> get item at index
 * - { "range": [start, end, step?] }            -> generate number range
 * - { "entries": object }                        -> array of { key, value } pairs
 */
export class ArrayNode extends Node {
  async first(def: Record<string, unknown>, context: Context): Promise<unknown> {
    const arr = this.toArray(await resolve(def.first, context));
    return arr[0];
  }

  async last(def: Record<string, unknown>, context: Context): Promise<unknown> {
    const arr = this.toArray(await resolve(def.last, context));
    return arr[arr.length - 1];
  }

  async count(def: Record<string, unknown>, context: Context): Promise<number> {
    const value = await resolve(def.count, context);
    if (Array.isArray(value)) return value.length;
    if (this.isObject(value)) return Object.keys(value).length;
    if (typeof value === "string") return value.length;
    return 0;
  }

  async keys(def: Record<string, unknown>, context: Context): Promise<string[]> {
    const value = await resolve(def.keys, context);
    if (this.isObject(value)) return Object.keys(value);
    if (Array.isArray(value)) return value.map((_, i) => String(i));
    return [];
  }

  async values(def: Record<string, unknown>, context: Context): Promise<unknown[]> {
    const value = await resolve(def.values, context);
    if (this.isObject(value)) return Object.values(value);
    if (Array.isArray(value)) return value;
    return [];
  }

  async reverse(def: Record<string, unknown>, context: Context): Promise<unknown[]> {
    const arr = this.toArray(await resolve(def.reverse, context));
    return [...arr].reverse();
  }

  async unique(def: Record<string, unknown>, context: Context): Promise<unknown[]> {
    const arr = this.toArray(await resolve(def.unique, context));
    return [...new Set(arr)];
  }

  async flatten(def: Record<string, unknown>, context: Context): Promise<unknown[]> {
    const arr = this.toArray(await resolve(def.flatten, context));
    return arr.flat(Infinity);
  }

  async sort(def: Record<string, unknown>, context: Context): Promise<unknown[]> {
    return doSort(await resolve(def.sort, context), false);
  }

  async sortDesc(def: Record<string, unknown>, context: Context): Promise<unknown[]> {
    return doSort(await resolve(def.sortDesc, context), true);
  }

  async sortBy(def: Record<string, unknown>, context: Context): Promise<unknown[]> {
    const args = this.toArray(def.sortBy);
    const arr = this.toArray(await resolve(args[0], context));
    const key = this.toString(await resolve(args[1], context));
    const direction =
      args.length > 2 && (await resolve(args[2], context)) === "desc" ? -1 : 1;

    return [...arr].sort((a, b) => {
      const aVal = this.isObject(a) ? a[key] : undefined;
      const bVal = this.isObject(b) ? b[key] : undefined;

      if (typeof aVal === "number" && typeof bVal === "number") {
        return (aVal - bVal) * direction;
      }
      return this.toString(aVal).localeCompare(this.toString(bVal)) * direction;
    });
  }

  async pluck(def: Record<string, unknown>, context: Context): Promise<unknown[]> {
    const args = this.toArray(def.pluck);
    const arr = this.toArray(await resolve(args[0], context));
    const key = this.toString(await resolve(args[1], context));

    return arr.map((item) => {
      if (this.isObject(item)) return getNestedValue(item, key);
      return undefined;
    });
  }

  async slice(def: Record<string, unknown>, context: Context): Promise<unknown[]> {
    const args = this.toArray(def.slice);
    const arr = this.toArray(await resolve(args[0], context));
    const start = this.toNumber(await resolve(args[1], context));
    const end =
      args.length > 2
        ? this.toNumber(await resolve(args[2], context))
        : undefined;
    return arr.slice(start, end);
  }

  async push(def: Record<string, unknown>, context: Context): Promise<unknown[]> {
    const args = this.toArray(def.push);
    const arr = this.toArray(await resolve(args[0], context));
    const item = args.length > 1 ? await resolve(args[1], context) : undefined;
    return [...arr, item];
  }

  async unshift(def: Record<string, unknown>, context: Context): Promise<unknown[]> {
    const args = this.toArray(def.unshift);
    const arr = this.toArray(await resolve(args[0], context));
    const item = args.length > 1 ? await resolve(args[1], context) : undefined;
    return [item, ...arr];
  }

  async merge(def: Record<string, unknown>, context: Context): Promise<unknown> {
    const args = this.toArray(def.merge);
    const resolved: unknown[] = [];
    for (const arg of args) resolved.push(await resolve(arg, context));
    // Object merge: if all args are plain objects, spread-merge them
    if (resolved.length > 0 && resolved.every(r => this.isObject(r) && !Array.isArray(r))) {
      let result: Record<string, unknown> = {};
      for (const obj of resolved) result = { ...result, ...(obj as Record<string, unknown>) };
      return result;
    }
    // Array merge: concatenate arrays
    const result: unknown[] = [];
    for (const r of resolved) {
      const arr = this.toArray(r);
      result.push(...arr);
    }
    return result;
  }

  async filter(def: Record<string, unknown>, context: Context): Promise<unknown[]> {
    const args = this.toArray(def.filter);
    const arr = this.toArray(await resolve(args[0], context));
    const condition = args[1];

    const results: unknown[] = [];
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      const itemContext: Context = {
        ...context,
        item,
        index: i,
        loop: {
          item,
          index: i,
          key: i,
          first: i === 0,
          last: i === arr.length - 1,
          length: arr.length,
        },
      };
      if (this.toBoolean(await resolve(condition, itemContext))) {
        results.push(item);
      }
    }
    return results;
  }

  async find(def: Record<string, unknown>, context: Context): Promise<unknown> {
    const args = this.toArray(def.find);
    const arr = this.toArray(await resolve(args[0], context));
    const condition = args[1];

    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      const itemContext: Context = {
        ...context,
        item,
        index: i,
        loop: {
          item,
          index: i,
          key: i,
          first: i === 0,
          last: i === arr.length - 1,
          length: arr.length,
        },
      };
      if (this.toBoolean(await resolve(condition, itemContext))) {
        return item;
      }
    }
    return undefined;
  }

  async map(def: Record<string, unknown>, context: Context): Promise<unknown[]> {
    const args = this.toArray(def.map);
    const arr = this.toArray(await resolve(args[0], context));
    const transform = args[1];

    const results: unknown[] = [];
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      const itemContext: Context = {
        ...context,
        item,
        index: i,
        loop: {
          item,
          index: i,
          key: i,
          first: i === 0,
          last: i === arr.length - 1,
          length: arr.length,
        },
      };
      results.push(await resolve(transform, itemContext));
    }
    return results;
  }

  async reduce(def: Record<string, unknown>, context: Context): Promise<unknown> {
    const args = this.toArray(def.reduce);
    const arr = this.toArray(await resolve(args[0], context));
    const reducer = args[1];
    let accumulator =
      args.length > 2 ? await resolve(args[2], context) : undefined;

    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      const itemContext: Context = {
        ...context,
        item,
        index: i,
        accumulator,
        loop: {
          item,
          index: i,
          key: i,
          first: i === 0,
          last: i === arr.length - 1,
          length: arr.length,
        },
      };
      accumulator = await resolve(reducer, itemContext);
    }

    return accumulator;
  }

  async groupBy(def: Record<string, unknown>, context: Context): Promise<Record<string, unknown[]>> {
    const args = this.toArray(def.groupBy);
    const arr = this.toArray(await resolve(args[0], context));
    const key = this.toString(await resolve(args[1], context));

    const result: Record<string, unknown[]> = {};
    for (const item of arr) {
      const groupKey = this.isObject(item)
        ? this.toString(getNestedValue(item, key))
        : "";
      if (!result[groupKey]) result[groupKey] = [];
      result[groupKey].push(item);
    }
    return result;
  }

  async includes(def: Record<string, unknown>, context: Context): Promise<boolean> {
    const args = this.toArray(def.includes);
    const arr = this.toArray(await resolve(args[0], context));
    if (args.length >= 3) {
      const key = this.toString(await resolve(args[1], context));
      const value = await resolve(args[2], context);
      return arr.some(
        (item) => this.isObject(item) && (item as Record<string, unknown>)[key] === value,
      );
    }
    const value = await resolve(args[1], context);
    return arr.includes(value);
  }

  async index(def: Record<string, unknown>, context: Context): Promise<unknown> {
    const args = this.toArray(def.index);
    const arr = this.toArray(await resolve(args[0], context));
    const index = this.toNumber(await resolve(args[1], context));
    return arr[index];
  }

  async range(def: Record<string, unknown>, context: Context): Promise<number[]> {
    const args = this.toArray(def.range);
    const start = this.toNumber(await resolve(args[0], context));
    const end = this.toNumber(await resolve(args[1], context));
    const step =
      args.length > 2 ? this.toNumber(await resolve(args[2], context)) : 1;

    if (step === 0) return [];

    const result: number[] = [];
    if (step > 0) {
      for (let i = start; i <= end; i += step) result.push(i);
    } else {
      for (let i = start; i >= end; i += step) result.push(i);
    }
    return result;
  }

  async entries(def: Record<string, unknown>, context: Context): Promise<Array<{ key: string; value: unknown }>> {
    const value = await resolve(def.entries, context);
    if (this.isObject(value)) {
      return Object.entries(value).map(([key, val]) => ({ key, value: val }));
    }
    if (Array.isArray(value)) {
      return value.map((val, i) => ({ key: String(i), value: val }));
    }
    return [];
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
