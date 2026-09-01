import { Node, Context, childContext } from "./Node.js";
import { resolve, resolveAll } from "../Resolver.js";
import { getNestedValue } from "../helpers.js";
import { nextRandom } from "./Math.js";
import type { JexsNodeSchema, JexsPropertySchema } from "../schema.js";

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
    shuffle: {
      output: "array",
      markdownDescription: "Randomly reorders an array **in place** (Fisher-Yates) and returns it. Draws from the seeded RNG when `randomSeed` has been set (reproducible), otherwise `Math.random`. Pass `clone: true` to shuffle a copy and leave the source unchanged.",
      examples: [
        "{ \"shuffle\": { \"var\": \"$deck\" } }",
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
      prefixItems: [
        { type: "array", description: "The array of objects to read from." },
        { type: "string", description: "The key (dot-path) to extract from each object." },
      ],
      output: "array",
      markdownDescription: "Extracts the value of a key (dot-path) from each object in an array.",
      outputDescription: "An array of each object's value at the key, with `undefined` in slots where the object lacks it.",
      examples: [
        "{ \"pluck\": [{ \"var\": \"$users\" }, \"name\"] }",
      ],
    },
    slice: {
      tuple: [
        2,
        3,
      ],
      prefixItems: [
        { type: "array", description: "The array to slice." },
        { type: "number", description: "Start index (inclusive)." },
        { type: "number", description: "End index (exclusive). Defaults to the end of the array." },
      ],
      output: "array",
      markdownDescription: "Returns a portion of an array.",
      examples: [
        "{ \"slice\": [{ \"var\": \"$items\" }, 0, 5] }",
      ],
    },
    push: {
      tuple: 2,
      prefixItems: [
        { type: "array", description: "The array to append to (mutated in place)." },
        { description: "The item to append." },
      ],
      output: "array",
      markdownDescription: "Appends an item to an array **in place** and returns that array. The array referenced by the first argument is mutated, so point it at a `var` (e.g. `{ \"var\": \"$items\" }`), not a literal. If the first argument is not an array, returns a new single-element array. For a non-mutating append use `{ \"merge\": [arr, [item]] }`.",
      outputDescription: "The same (now longer) array; or a new `[item]` when the target is not an array.",
      examples: [
        "{ \"push\": [{ \"var\": \"$items\" }, \"new\"] }",
      ],
    },
    unshift: {
      tuple: 2,
      prefixItems: [
        { type: "array", description: "The array to prepend to (mutated in place)." },
        { description: "The item to prepend." },
      ],
      output: "array",
      markdownDescription: "Prepends an item to an array **in place** and returns that array. Mutates the array referenced by the first argument, so point it at a `var`, not a literal. If the first argument is not an array, returns a new single-element array.",
      outputDescription: "The same (now longer) array; or a new `[item]` when the target is not an array.",
      examples: [
        "{ \"unshift\": [{ \"var\": \"$items\" }, \"first\"] }",
      ],
    },
    pop: {
      markdownDescription: "Removes the **last** element of an array **in place** and returns it.",
      outputDescription: "The removed element (any type), or `undefined` if the array is empty or not an array.",
      examples: [
        "{ \"pop\": { \"var\": \"$items\" } }",
      ],
    },
    shift: {
      markdownDescription: "Removes the **first** element of an array **in place** and returns it.",
      outputDescription: "The removed element (any type), or `undefined` if the array is empty or not an array.",
      examples: [
        "{ \"shift\": { \"var\": \"$items\" } }",
      ],
    },
    remove: {
      tuple: 2,
      prefixItems: [
        { type: "array", description: "The array to remove from (mutated in place)." },
        { type: "number", description: "Index of the element to remove." },
      ],
      markdownDescription: "Removes the element at an index **in place** and returns it. (For predicate/value removal use `filter`.)",
      outputDescription: "The removed element (any type), or `undefined` if the index is out of range.",
      examples: [
        "{ \"remove\": [{ \"var\": \"$items\" }, 2] }",
      ],
    },
    insert: {
      tuple: 3,
      prefixItems: [
        { type: "array", description: "The array to insert into (mutated in place)." },
        { type: "number", description: "Index to insert at (clamped to the array bounds)." },
        { description: "The value to insert." },
      ],
      output: "array",
      markdownDescription: "Inserts a value at an index **in place** (clamped to the array bounds) and returns the array.",
      outputDescription: "The same (now longer) array.",
      examples: [
        "{ \"insert\": [{ \"var\": \"$items\" }, 0, \"first\"] }",
      ],
    },
    move: {
      tuple: 3,
      prefixItems: [
        { type: "array", description: "The array to reorder (mutated in place)." },
        { type: "number", description: "Index of the element to move (`from`)." },
        { type: "number", description: "Destination index (`to`, clamped to bounds)." },
      ],
      output: "array",
      markdownDescription: "Moves the element at `from` to index `to` **in place** and returns the array. Out-of-range `from` is a no-op; `to` is clamped to bounds.",
      outputDescription: "The same array, reordered.",
      examples: [
        "{ \"move\": [{ \"var\": \"$items\" }, 2, 0] }",
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
      markdownDescription: "Returns the items of an array for which a condition is truthy. Tuple form: `[<array>, <condition>]`.\nEach iteration exposes the current element as `item` (rename via the `item`/`index` siblings), plus `index` and `loop`. Read the element with `{ \"var\": \"item\" }`; a leading `$` is optional.",
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
      markdownDescription: "Returns the first item of an array for which a condition is truthy. Tuple form: `[<array>, <condition>]`.\nEach iteration exposes the current element as `item` (rename via the `item`/`index` siblings), plus `index` and `loop`. Read the element with `{ \"var\": \"item\" }`; a leading `$` is optional.",
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
          required: true,
          description: "Template to resolve for each item.",
        },
      },
    },
    reduce: {
      tuple: 3,
      markdownDescription: "Reduces an array to a single value. Tuple form: `[<array>, <reducer>, <initial>]`.\nEach iteration exposes the current element as `item` (rename via the `item`/`index` siblings), plus `index`, `accumulator`, and `loop`. Read them with `{ \"var\": \"item\" }` / `{ \"var\": \"accumulator\" }`; a leading `$` is optional.",
      outputDescription: "The final accumulator value, typed by the reducer or initial value (the initial value is returned as-is for an empty array).",
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
      prefixItems: [
        { type: "array", description: "The array of objects to group." },
        { type: "string", description: "The key to group by." },
      ],
      output: "object",
      markdownDescription: "Groups an array of objects by a key. Returns an object keyed by group values.",
      outputDescription: "An object mapping each distinct group-key (stringified) to the **array** of items in that group.",
      examples: [
        "{ \"groupBy\": [{ \"var\": \"$users\" }, \"role\"] }",
      ],
    },
    fromEntries: {
      output: "object",
      markdownDescription: "Builds an object from `[{ key, value }]` pairs (the inverse of `entries` in the object node). Also accepts `[key, value]` tuple arrays.",
      examples: [
        "{ \"fromEntries\": { \"var\": \"$pairs\" } }",
      ],
    },
    includes: {
      tuple: [
        2,
        3,
      ],
      prefixItems: [
        { type: "array", description: "The array to search." },
        { description: "The value to find; or, with a third argument, the object key to match." },
        { description: "With a key in the second slot, the value that key must equal." },
      ],
      output: "boolean",
      markdownDescription: "Checks if an array contains a value: `[arr, value]`.\nWith three arguments `[arr, key, value]`, checks if any object has that key-value pair.",
      examples: [
        "{ \"includes\": [{ \"var\": \"$roles\" }, \"admin\"] }",
      ],
    },
    index: {
      tuple: 2,
      prefixItems: [
        { type: "array", description: "The array to read from." },
        { type: "number", description: "The index to read." },
      ],
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
      prefixItems: [
        { type: "number", description: "Start of the sequence (inclusive)." },
        { type: "number", description: "End of the sequence (inclusive)." },
        { type: "number", description: "Step between values (default 1)." },
      ],
      output: "array",
      markdownDescription: "Generates a numeric sequence. Inclusive on both ends.",
      examples: [
        "{ \"range\": [1, 5] }",
      ],
    },
    listFormat: {
      type: "array",
      output: "string",
      markdownDescription: "Joins an array into a locale-aware list string via `Intl.ListFormat`. Each element is coerced to a string.",
      outputDescription: "A single string, e.g. `[\"a\", \"b\", \"c\"]` -> `\"a, b, and c\"` (defaults: `conjunction`, `long`).",
      examples: [
        "{ \"listFormat\": [\"a\", \"b\", \"c\"] }",
        "{ \"listFormat\": { \"var\": \"$tags\" }, \"type\": \"disjunction\" }",
      ],
      siblings: {
        locale: {
          type: "string",
          description: "BCP-47 locale tag (default: the runtime locale).",
        },
        type: {
          type: "string",
          enum: [
            "conjunction",
            "disjunction",
            "unit",
          ],
          description: "Grouping relation: `\"conjunction\"` (and, default), `\"disjunction\"` (or), or `\"unit\"`.",
        },
        style: {
          type: "string",
          enum: [
            "long",
            "short",
            "narrow",
          ],
          description: "Length of the connector words (default `\"long\"`).",
        },
      },
    },
  };

  static commonSiblings: Record<string, JexsPropertySchema> = {
    clone: {
      type: "boolean",
      description: "Operate on a shallow copy and return it, leaving the source array unchanged (default `false`). Applies to the mutating/reordering verbs (`sort`, `reverse`, `unique`, `flatten`, `shuffle`, `push`, `unshift`, `pop`, `shift`, `remove`, `insert`, `move`); the pure verbs (`map`, `filter`, `slice`, …) always return a new array regardless.",
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

  reverse(def: Record<string, unknown>, c: Context) {
    return resolve(def.clone, c, cl =>
      resolve(def.reverse, c, v => mutArr(v, this.toBoolean(cl)).reverse()));
  }

  unique(def: Record<string, unknown>, c: Context) {
    return resolve(def.clone, c, cl => {
      const clone = this.toBoolean(cl);
      return resolve(def.unique, c, v => {
        const u = [...new Set(this.toArray(v))];
        if (clone || !Array.isArray(v)) return u;
        v.splice(0, v.length, ...u);
        return v;
      });
    });
  }

  flatten(def: Record<string, unknown>, c: Context) {
    return resolve(def.clone, c, cl => {
      const clone = this.toBoolean(cl);
      return resolve(def.flatten, c, v => {
        const f = this.toArray(v).flat(Infinity);
        if (clone || !Array.isArray(v)) return f;
        v.splice(0, v.length, ...f);
        return v;
      });
    });
  }

  sort(def: Record<string, unknown>, c: Context) {
    return resolve(def.clone, c, cl =>
      resolve(def.sort, c, v => sortInPlace(mutArr(v, this.toBoolean(cl)), false)));
  }

  sortDesc(def: Record<string, unknown>, c: Context) {
    return resolve(def.clone, c, cl =>
      resolve(def.sortDesc, c, v => sortInPlace(mutArr(v, this.toBoolean(cl)), true)));
  }

  shuffle(def: Record<string, unknown>, c: Context) {
    return resolve(def.clone, c, cl =>
      resolve(def.shuffle, c, v => shuffleInPlace(mutArr(v, this.toBoolean(cl)), c)));
  }

  sortBy(def: Record<string, unknown>, c: Context) {
    return resolve(def.clone, c, cl => {
      const clone = this.toBoolean(cl);
      return resolve(def.sortBy, c, args => {
        const a = this.toArray(args);
        const arr = mutArr(a[0], clone);
        const key = this.toString(a[1]);
        const direction = a.length > 2 && a[2] === "desc" ? -1 : 1;
        return arr.sort((x, y) => {
          const xVal = this.isObject(x) ? (x as Record<string, unknown>)[key] : undefined;
          const yVal = this.isObject(y) ? (y as Record<string, unknown>)[key] : undefined;
          if (typeof xVal === "number" && typeof yVal === "number") return (xVal - yVal) * direction;
          return this.toString(xVal).localeCompare(this.toString(yVal)) * direction;
        });
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
    return resolve(def.clone, c, cl => {
      const clone = this.toBoolean(cl);
      return resolve(def.push, c, args => {
        const a = this.toArray(args);
        const item = a.length > 1 ? a[1] : undefined;
        if (!Array.isArray(a[0])) return [item];
        const arr = clone ? [...a[0]] : a[0];
        arr.push(item);
        return arr;
      });
    });
  }

  unshift(def: Record<string, unknown>, c: Context) {
    return resolve(def.clone, c, cl => {
      const clone = this.toBoolean(cl);
      return resolve(def.unshift, c, args => {
        const a = this.toArray(args);
        const item = a.length > 1 ? a[1] : undefined;
        if (!Array.isArray(a[0])) return [item];
        const arr = clone ? [...a[0]] : a[0];
        arr.unshift(item);
        return arr;
      });
    });
  }

  pop(def: Record<string, unknown>, c: Context) {
    return resolve(def.clone, c, cl => {
      const clone = this.toBoolean(cl);
      return resolve(def.pop, c, v => {
        if (!Array.isArray(v)) return undefined;
        return clone ? v[v.length - 1] : v.pop();
      });
    });
  }

  shift(def: Record<string, unknown>, c: Context) {
    return resolve(def.clone, c, cl => {
      const clone = this.toBoolean(cl);
      return resolve(def.shift, c, v => {
        if (!Array.isArray(v)) return undefined;
        return clone ? v[0] : v.shift();
      });
    });
  }

  remove(def: Record<string, unknown>, c: Context) {
    return resolve(def.clone, c, cl => {
      const clone = this.toBoolean(cl);
      return resolve(def.remove, c, args => {
        const a = this.toArray(args);
        const arr = a[0];
        if (!Array.isArray(arr)) return undefined;
        const i = this.toNumber(a[1]);
        if (i < 0 || i >= arr.length) return undefined;
        return clone ? arr[i] : arr.splice(i, 1)[0];
      });
    });
  }

  insert(def: Record<string, unknown>, c: Context) {
    return resolve(def.clone, c, cl => {
      const clone = this.toBoolean(cl);
      return resolve(def.insert, c, args => {
        const a = this.toArray(args);
        if (!Array.isArray(a[0])) return a[0];
        const arr = clone ? [...a[0]] : a[0];
        const i = Math.max(0, Math.min(this.toNumber(a[1]), arr.length));
        arr.splice(i, 0, a[2]);
        return arr;
      });
    });
  }

  move(def: Record<string, unknown>, c: Context) {
    return resolve(def.clone, c, cl => {
      const clone = this.toBoolean(cl);
      return resolve(def.move, c, args => {
        const a = this.toArray(args);
        if (!Array.isArray(a[0])) return a[0];
        const arr = clone ? [...a[0]] : a[0];
        const from = this.toNumber(a[1]);
        if (from < 0 || from >= arr.length) return arr;
        const to = Math.max(0, Math.min(this.toNumber(a[2]), arr.length - 1));
        const [item] = arr.splice(from, 1);
        arr.splice(to, 0, item);
        return arr;
      });
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
          const itemCtx: Context = childContext(context, {
            [itemName]: item, [indexName]: idx,
            loop: { item, index: idx, key: idx, first: idx === 0, last: idx === items.length - 1, length: items.length },
          });
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
          const itemCtx: Context = childContext(context, {
            [itemName]: item, [indexName]: idx,
            loop: { item, index: idx, key: idx, first: idx === 0, last: idx === items.length - 1, length: items.length },
          });
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
    if (template === undefined) throw new Error("map needs a `do` template");
    return resolve(def.map, context, arr => {
      const items = this.toArray(arr);
      const results: unknown[] = [];
      let i = 0;
      function next(): unknown {
        if (i >= items.length) return results;
        const idx = i++;
        const item = items[idx];
        const itemCtx: Context = childContext(context, {
          [itemName]: item,
          loop: { item, index: idx, key: idx, first: idx === 0, last: idx === items.length - 1, length: items.length },
        });
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
            const itemCtx: Context = childContext(context, {
              [itemName]: item, [indexName]: idx, accumulator,
              loop: { item, index: idx, key: idx, first: idx === 0, last: idx === items.length - 1, length: items.length },
            });
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

  fromEntries(def: Record<string, unknown>, c: Context) {
    return resolve(def.fromEntries, c, value => {
      const result: Record<string, unknown> = {};
      for (const e of this.toArray(value)) {
        if (this.isObject(e) && "key" in e) result[this.toString(e.key)] = e.value;
        else if (Array.isArray(e)) result[this.toString(e[0])] = e[1];
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

  listFormat(def: Record<string, unknown>, c: Context) {
    return resolveAll([def.listFormat, def.locale, def.type, def.style], c, ([value, locale, type, style]) => {
      const opts: Intl.ListFormatOptions = {};
      if (type != null) opts.type = this.toString(type) as Intl.ListFormatType;
      if (style != null) opts.style = this.toString(style) as Intl.ListFormatStyle;
      const list = new Intl.ListFormat(locale != null ? this.toString(locale) : undefined, opts);
      return list.format(this.toArray(value).map(v => this.toString(v)));
    });
  }
}

/** The array to edit in place — the source itself, or a shallow copy when
 *  `clone`. A non-array is wrapped into a fresh array (nothing to mutate). */
function mutArr(value: unknown, clone: boolean): unknown[] {
  if (!Array.isArray(value)) return value != null ? [value] : [];
  return clone ? [...value] : value;
}

function sortInPlace(arr: unknown[], desc: boolean): unknown[] {
  arr.sort((a, b) => {
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a ?? "").localeCompare(String(b ?? ""));
  });
  return desc ? arr.reverse() : arr;
}

/** Fisher-Yates shuffle in place, drawing from this resolver's (seedable) RNG. */
function shuffleInPlace(arr: unknown[], context: Context): unknown[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(nextRandom(context) * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
