import { Node, Context, NodeValue, childContext } from "./Node.js";
import { andThen, inOrder, resolve, resolveAll, runSteps } from "../Resolver.js";
import { SKIP, STOP, isStream, mapStream, readEach } from "../streams.js";
import type { JexsNodeSchema } from "../schema.js";

export class IteratorNode extends Node {
  static schema: JexsNodeSchema = {
    foreach: {
      $ref: "#/$defs/_iterable",
      markdownDescription: "Iterates over an array, resolving `do` for each item, for side-effects or accumulation. Each iteration exposes the current element as `item` and its position as `index` (rename via the `item`/`index` siblings). Pass `parallel: true` to resolve all iterations concurrently.\n\nOver a stream, `do` runs for each value as it arrives, and the next value is read only once its steps finish (`parallel` does not apply). An error in `do` cancels the rest of the stream.",
      outputDescription: "The **last** iteration's resolved value, not an array (an empty/absent input yields `null`). For an array `do`, that is the last step of the last iteration. Reach for `map` when you need a result per item, e.g. rendering N elements from a collection.",
      examples: [
        "{ \"$foreach\": { \"$var\": \"users\" }, \"item\": \"user\", \"do\": { \"$setVars\": { \"seen\": { \"$add\": [{ \"$var\": \"seen\" }, 1] } } } }",
      ],
      siblings: {
        do: {
          required: true,
          description: "Steps or expression to resolve for each item.",
        },
        item: {
          type: "string",
          description: "Variable name for the current item (default `\"item\"`).",
        },
        index: {
          type: "string",
          description: "Variable name for the current index (default `\"index\"`).",
        },
        parallel: {
          type: "boolean",
          description: "Resolve all iterations concurrently instead of sequentially.",
        },
      },
    },
    map: {
      $ref: "#/$defs/_iterable",
      output: "array",
      markdownDescription: "Transforms each item by running `do` for it.\nEach iteration exposes the current element as `item` and its position as `index` (rename via the `item`/`index` siblings).\n`do` runs as steps: an array is a step sequence whose last value (or a `$return`'s) is the item's result.\n\nOver a stream it resolves at once to a stream of the results, reading the source only as that stream is read; an error in `do` fails it and cancels the source.",
      outputDescription: "The results: an array, or a stream of them for a stream.",
      examples: [
        "{ \"$map\": { \"$var\": \"nums\" }, \"item\": \"num\", \"do\": { \"$multiply\": [{ \"$var\": \"num\" }, 2] } }",
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
        do: {
          required: true,
          description: "Steps or expression run for each item; its result is the item's place in the new array.",
        },
      },
    },
    filter: {
      $ref: "#/$defs/_iterable",
      output: "array",
      markdownDescription: "Returns the items of an array for which the `do` condition is truthy.\nEach iteration exposes the current element as `item` and its position as `index` (rename via the `item`/`index` siblings).\n\nOver a stream it resolves at once to a stream of the values kept, reading the source only as that stream is read; an error in `do` fails it and cancels the source.",
      outputDescription: "The kept items: an array, or a stream of them for a stream.",
      examples: [
        "{ \"$filter\": { \"$var\": \"nums\" }, \"do\": { \"$gt\": [{ \"$var\": \"item\" }, 2] } }",
        "{ \"$filter\": { \"$var\": \"users\" }, \"do\": { \"$eq\": [{ \"$var\": \"u.role\" }, \"admin\"] }, \"item\": \"u\" }",
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
        do: {
          required: true,
          description: "Steps or expression run for each item; the item is kept when the result is truthy.",
        },
      },
    },
    find: {
      $ref: "#/$defs/_iterable",
      markdownDescription: "Returns the first item of an array for which the `do` condition is truthy.\nEach iteration exposes the current element as `item` and its position as `index` (rename via the `item`/`index` siblings).\n\nOver a stream it reads until the first match and cancels the rest.",
      outputDescription: "The first matching item (any type), or `undefined` if none match.",
      examples: [
        "{ \"$find\": { \"$var\": \"users\" }, \"do\": { \"$eq\": [{ \"$var\": \"item.role\" }, \"admin\"] } }",
        "{ \"$find\": { \"$var\": \"users\" }, \"do\": { \"$eq\": [{ \"$var\": \"u.role\" }, \"admin\"] }, \"item\": \"u\" }",
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
        do: {
          required: true,
          description: "Steps or expression run for each item; the first item whose result is truthy is returned.",
        },
      },
    },
    reduce: {
      $ref: "#/$defs/_iterable",
      markdownDescription: "Reduces an array to a single value: the `do` reducer runs for each item, and what it returns is the next `accumulator`, starting from `initial`.\nEach iteration exposes the current element as `item`, its position as `index` and the running `accumulator` (rename via the `item`/`index`/`accumulator` siblings).\n\nOver a stream it reads every value as it arrives and resolves once the stream ends. With `initial: []` and `$push` it collects a stream into an array.",
      outputDescription: "The final accumulator value, typed by the reducer or initial value (the initial value is returned as-is for an empty array).",
      examples: [
        "{ \"$reduce\": { \"$var\": \"nums\" }, \"do\": { \"$add\": [{ \"$var\": \"accumulator\" }, { \"$var\": \"item\" }] }, \"initial\": 0 }",
        "{ \"$reduce\": { \"$var\": \"nums\" }, \"do\": { \"$add\": [{ \"$var\": \"total\" }, { \"$var\": \"n\" }] }, \"initial\": 0, \"item\": \"n\", \"accumulator\": \"total\" }",
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
        accumulator: {
          type: "string",
          description: "Variable name for the running value (default `\"accumulator\"`).",
        },
        do: {
          required: true,
          description: "Steps or expression run for each item; its result becomes the next `accumulator`.",
        },
        initial: {
          description: "The accumulator's starting value (default: none, so the first `accumulator` is undefined).",
        },
      },
    },
  };

  static schemaDefs = {
    _iterable: {
      anyOf: [
        { type: "array", items: { $ref: "#/$defs/anyVal" } },
        { $ref: "#/$defs/_stream" },
      ],
      description: "What the iteration ops go through: an array, or a stream read as its values arrive.",
    },
  };

  foreach(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$foreach, def.parallel, def.item, def.index], context, ([items, parallel, itemRaw, indexRaw]) => {
      const itemName = typeof itemRaw === "string" ? itemRaw : "item";
      const indexName = typeof indexRaw === "string" ? indexRaw : "index";
      const template = def.do;
      if (template === undefined) throw new Error("foreach needs a `do` template");

      const buildContext = (item: unknown, i: number): Context =>
        childContext(context, { [itemName]: item, [indexName]: i });

      // A stream's values arrive one at a time, so each runs as it comes, the
      // next read only once its steps finish.
      if (isStream(items)) {
        if (this.toBoolean(parallel)) throw new Error("foreach cannot run a stream's values in parallel: they arrive one at a time");
        let last: unknown = null;
        return readEach(items, (item, i) => andThen(runSteps(template, buildContext(item, i)), v => { last = v; }))
          .then(() => last);
      }

      // foreach iterates for effect/accumulation and yields the LAST iteration's
      // value (empty input → null). Use `map` when you need an array of every
      // result (e.g. rendering N elements from a collection).
      const arr = this.toArray(items);
      if (arr.length === 0) return null;

      if (this.toBoolean(parallel)) {
        return Promise.all(arr.map((item, i) => runSteps(template, buildContext(item, i))))
          .then(results => results.length ? results[results.length - 1] : null);
      }

      let last: unknown = null;
      return andThen(inOrder(arr.length, i => runSteps(template, buildContext(arr[i], i)), v => { last = v; }), () => last);
    });
  }

  map(def: Record<string, unknown>, context: Context) {
    const template = def.do;
    if (template === undefined) throw new Error("map needs a `do` template");
    // As in `filter`/`find`/`reduce`, the item and index variable names are
    // resolved first, so either may be handed in as an expression.
    return resolveAll([def.item, def.index], context, ([itemRaw, indexRaw]) => {
      const itemName = typeof itemRaw === "string" ? itemRaw : "item";
      const indexName = typeof indexRaw === "string" ? indexRaw : "index";
      return resolve(def.$map, context, arr => {
        if (isStream(arr)) {
          return mapStream(arr, (item, idx) =>
            runSteps(template, childContext(context, { [itemName]: item, [indexName]: idx })));
        }
        const items = this.toArray(arr);
        const results: unknown[] = [];
        return andThen(inOrder(items.length,
          i => runSteps(template, childContext(context, { [itemName]: items[i], [indexName]: i })),
          v => { results.push(v); }), () => results);
      });
    });
  }

  filter(def: Record<string, unknown>, context: Context) {
    const condition = def.do;
    if (condition === undefined) throw new Error("filter needs a `do` condition");
    return resolveAll([def.item, def.index], context, ([itemRaw, indexRaw]) => {
      const itemName = typeof itemRaw === "string" ? itemRaw : "item";
      const indexName = typeof indexRaw === "string" ? indexRaw : "index";
      return resolve(def.$filter, context, arr => {
        if (isStream(arr)) {
          return mapStream(arr, (item, idx) =>
            andThen(runSteps(condition, childContext(context, { [itemName]: item, [indexName]: idx })), v =>
              this.toBoolean(v) ? item : SKIP));
        }
        const items = this.toArray(arr);
        const results: unknown[] = [];
        return andThen(inOrder(items.length,
          i => runSteps(condition, childContext(context, { [itemName]: items[i], [indexName]: i })),
          (v, i) => { if (this.toBoolean(v)) results.push(items[i]); }), () => results);
      });
    });
  }

  find(def: Record<string, unknown>, context: Context) {
    const condition = def.do;
    if (condition === undefined) throw new Error("find needs a `do` condition");
    return resolveAll([def.item, def.index], context, ([itemRaw, indexRaw]) => {
      const itemName = typeof itemRaw === "string" ? itemRaw : "item";
      const indexName = typeof indexRaw === "string" ? indexRaw : "index";
      return resolve(def.$find, context, arr => {
        if (isStream(arr)) {
          let found: unknown;
          return readEach(arr, (item, idx) =>
            andThen(runSteps(condition, childContext(context, { [itemName]: item, [indexName]: idx })), v => {
              if (!this.toBoolean(v)) return undefined;
              found = item;
              return STOP;
            })).then(() => found);
        }
        const items = this.toArray(arr);
        let found: unknown;
        return andThen(inOrder(items.length,
          i => runSteps(condition, childContext(context, { [itemName]: items[i], [indexName]: i })),
          (v, i) => {
            if (!this.toBoolean(v)) return false;
            found = items[i];
            return true;
          }), () => found);
      });
    });
  }

  reduce(def: Record<string, unknown>, context: Context) {
    const reducer = def.do;
    if (reducer === undefined) throw new Error("reduce needs a `do` reducer");
    return resolveAll([def.item, def.index, def.accumulator], context, ([itemRaw, indexRaw, accumulatorRaw]) => {
      const itemName = typeof itemRaw === "string" ? itemRaw : "item";
      const indexName = typeof indexRaw === "string" ? indexRaw : "index";
      const accumulatorName = typeof accumulatorRaw === "string" ? accumulatorRaw : "accumulator";
      return resolve(def.$reduce, context, arr => {
        if (isStream(arr)) {
          return resolve(def.initial, context, initial => {
            let accumulator: unknown = initial;
            return readEach(arr, (item, idx) =>
              andThen(runSteps(reducer, childContext(context, { [itemName]: item, [indexName]: idx, [accumulatorName]: accumulator })), v => {
                accumulator = v;
              })).then(() => accumulator);
          });
        }
        const items = this.toArray(arr);
        return resolve(def.initial, context, initial => {
          let accumulator: unknown = initial;
          return andThen(inOrder(items.length,
            i => runSteps(reducer, childContext(context, { [itemName]: items[i], [indexName]: i, [accumulatorName]: accumulator })),
            v => { accumulator = v; }), () => accumulator);
        });
      });
    });
  }
}
