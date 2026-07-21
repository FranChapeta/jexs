import { Node, Context, NodeValue } from "./Node.js";
import { resolve, resolveAll } from "../Resolver.js";
import { runSteps, resolveSteps } from "../Resolver.js";
import { hasAnyKey } from "../helpers.js";
import type { JexsNodeSchema } from "../schema.js";

export class LogicNode extends Node {
  static schema: JexsNodeSchema = {
    if: {
      markdownDescription: "Resolves `then` when the condition is truthy, otherwise `else`. Both branches are optional.",
      outputDescription: "The resolved value of the taken branch. A branch that is an **array** is run as a step sequence and yields only its LAST value — wrap multiple elements in one container if you need them all. With no `then` a truthy condition yields `true`; with no `else` a falsy condition yields `undefined`.",
      examples: [
        "{ \"if\": { \"var\": \"$active\" }, \"then\": \"yes\", \"else\": \"no\" }",
      ],
      siblings: {
        then: {
          description: "Value to resolve when condition is truthy.",
        },
        else: {
          description: "Value to resolve when condition is falsy.",
        },
      },
    },
    switch: {
      markdownDescription: "Resolves the value of `switch`, matches it against string keys in `cases`, falls back to `default`.",
      outputDescription: "The matched case's value, or `default` if no case matches (and `undefined` when neither matches nor a `default` is given). A case/`default` that is an **array** is run as steps and yields only its LAST value.",
      examples: [
        "{ \"switch\": { \"var\": \"$role\" }, \"cases\": { \"admin\": \"full\", \"user\": \"limited\" }, \"default\": \"none\" }",
      ],
      siblings: {
        cases: {
          map: true,
          description: "Object mapping string keys to result expressions.",
        },
        default: {
          description: "Value to resolve when no case matches.",
        },
      },
    },
    foreach: {
      markdownDescription: "Iterates over an array, resolving `do` for each item — for side-effects or accumulation. Use `item` to name the item variable (default `\"item\"`), `key` for the index variable, and `parallel: true` to resolve all iterations concurrently.\nEach iteration receives a `loop` context with `item`, `index`, `first`, `last`, and `length`.",
      outputDescription: "The **last** iteration's resolved value, not an array (an empty/absent input yields `null`). For an array `do`, that is the last step of the last iteration. Reach for `map` when you need a result per item — e.g. rendering N elements from a collection.",
      examples: [
        "{ \"foreach\": { \"var\": \"$users\" }, \"item\": \"user\", \"do\": { \"setVars\": { \"seen\": { \"add\": [{ \"var\": \"$seen\" }, 1] } } } }",
      ],
      siblings: {
        do: {
          description: "Steps or expression to resolve for each item.",
        },
        item: {
          type: "string",
          description: "Variable name to expose the current item (default `\"item\"`).",
        },
        key: {
          type: "string",
          description: "Variable name to expose the current index (default `\"index\"`).",
        },
        parallel: {
          type: "boolean",
          description: "Resolve all iterations concurrently instead of sequentially.",
        },
      },
    },
    and: {
      type: "array",
      output: "boolean",
      markdownDescription: "Short-circuit AND — evaluates conditions left to right, stopping at the first falsy one.",
      outputDescription: "`true` if every condition is truthy, otherwise `false` (an empty array is `true`).",
      examples: [
        "{ \"and\": [{ \"var\": \"$loggedIn\" }, { \"var\": \"$verified\" }] }",
      ],
    },
    or: {
      type: "array",
      output: "boolean",
      markdownDescription: "Short-circuit OR — evaluates conditions left to right, stopping at the first truthy one.",
      outputDescription: "`true` at the first truthy condition, otherwise `false` (an empty array is `false`).",
      examples: [
        "{ \"or\": [{ \"var\": \"$isAdmin\" }, { \"var\": \"$isModerator\" }] }",
      ],
    },
    coalesce: {
      type: "array",
      output: "any",
      markdownDescription: "Resolves values left to right, returning the first non-empty one — the value itself, not a boolean. Short-circuits, so later expressions are never resolved once a value is found. Use it to supply a fallback without repeating an expression across `if`/`then`.",
      outputDescription: "The first value that is not empty (`null`, `undefined`, `\"\"`, `[]`, `{}` are skipped; `0` and `false` are kept — the same rule as `notEmpty`). If every value is empty, the LAST one is returned; an empty array yields `undefined`.",
      examples: [
        "{ \"coalesce\": [{ \"var\": \"$props.button.properties.size.type\" }, \"any\"] }",
      ],
    },
    not: {
      output: "boolean",
      markdownDescription: "Boolean negation of the resolved value's truthiness.",
      outputDescription: "`true` when the value is falsy, otherwise `false`.",
      examples: [
        "{ \"not\": { \"var\": \"$active\" } }",
      ],
    },
    eq: {
      tuple: 2,
      output: "boolean",
      markdownDescription: "Strict equality check between two resolved values.",
      examples: [
        "{ \"eq\": [{ \"var\": \"$status\" }, \"active\"] }",
      ],
    },
    neq: {
      tuple: 2,
      output: "boolean",
      markdownDescription: "Strict inequality check between two resolved values.",
      examples: [
        "{ \"neq\": [{ \"var\": \"$status\" }, \"banned\"] }",
      ],
    },
    gt: {
      tuple: 2,
      output: "boolean",
      markdownDescription: "Greater-than comparison: `a > b`.",
      examples: [
        "{ \"gt\": [{ \"var\": \"$age\" }, 18] }",
      ],
    },
    gte: {
      tuple: 2,
      output: "boolean",
      markdownDescription: "Greater-than-or-equal comparison: `a >= b`.",
      examples: [
        "{ \"gte\": [{ \"var\": \"$score\" }, 100] }",
      ],
    },
    lt: {
      tuple: 2,
      output: "boolean",
      markdownDescription: "Less-than comparison: `a < b`.",
      examples: [
        "{ \"lt\": [{ \"var\": \"$remaining\" }, 10] }",
      ],
    },
    lte: {
      tuple: 2,
      output: "boolean",
      markdownDescription: "Less-than-or-equal comparison: `a <= b`.",
      examples: [
        "{ \"lte\": [{ \"var\": \"$quantity\" }, 100] }",
      ],
    },
    in: {
      tuple: 2,
      output: "boolean",
      markdownDescription: "Tests membership: `needle in haystack`. Works with arrays, strings (substring), and object keys.",
      examples: [
        "{ \"in\": [\"admin\", { \"var\": \"$roles\" }] }",
      ],
    },
    between: {
      tuple: 3,
      prefixItems: [
        { type: "number", description: "The value to test." },
        { type: "number", description: "Lower bound (inclusive)." },
        { type: "number", description: "Upper bound (inclusive)." },
      ],
      output: "boolean",
      markdownDescription: "Inclusive range check: `min <= value <= max`.",
      examples: [
        "{ \"between\": [{ \"var\": \"$age\" }, 18, 65] }",
      ],
    },
    typeof: {
      output: "string",
      markdownDescription: "Resolves a value and returns its Jexs type name as a string.",
      outputDescription: "One of `\"null\"`, `\"undefined\"`, `\"array\"`, `\"object\"`, `\"number\"`, `\"string\"`, `\"boolean\"`. Arrays report `\"array\"` (not `\"object\"`); `null` and `undefined` are distinct.",
      examples: [
        "{ \"typeof\": { \"var\": \"$value\" } }",
      ],
    },
    isType: {
      tuple: 2,
      prefixItems: [
        { description: "The value whose type to test." },
        {
          type: "string",
          enum: [
            "null",
            "undefined",
            "array",
            "object",
            "number",
            "string",
            "boolean",
          ],
          description: "The type name to match against.",
        },
      ],
      output: "boolean",
      markdownDescription: "Tests whether a value's type matches a type name. Tuple form `[value, type]` where `type` is one of `\"null\"`, `\"undefined\"`, `\"array\"`, `\"object\"`, `\"number\"`, `\"string\"`, `\"boolean\"`. Equivalent to `{ eq: [{ typeof: value }, type] }`.",
      outputDescription: "`true` when `typeof(value) === type`, otherwise `false`.",
      examples: [
        "{ \"isType\": [{ \"var\": \"$roles\" }, \"array\"] }",
      ],
    },
    empty: {
      output: "boolean",
      markdownDescription: "Tests whether the resolved value is empty.",
      outputDescription: "`true` for `null`, `undefined`, `\"\"`, `[]`, or `{}`; otherwise `false`.",
      examples: [
        "{ \"empty\": { \"var\": \"$items\" } }",
      ],
    },
    notEmpty: {
      output: "boolean",
      markdownDescription: "Tests whether the resolved value is non-empty. Inverse of `empty`.",
      outputDescription: "`true` when the value is non-null and non-empty; otherwise `false`.",
      examples: [
        "{ \"notEmpty\": { \"var\": \"$items\" } }",
      ],
    },
    sleep: {
      type: "number",
      output: "null",
      markdownDescription: "Pauses execution for the given number of milliseconds.",
      outputDescription: "Always `null`, after the delay elapses (a value ≤ 0 resolves immediately).",
      examples: [
        "{ \"sleep\": 500 }",
      ],
    },

    exec: {
      markdownDescription: "Resolves its value to a step sequence, then runs it. The steps are supplied as an expression — typically a `var` holding a step array (that is how you feed a step sequence in). The resolved array is executed as steps, so each step's `as` binding is visible to later steps.",
      outputDescription: "The LAST step's value when the resolved value is an array; otherwise the resolved value itself.",
      examples: [
        "{ \"exec\": { \"var\": \"$steps\" } }",
      ],
    },
  };

  if(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.if, context, condition =>
      this.toBoolean(condition)
        ? ("then" in def ? resolveSteps(def.then, context) : true)
        : ("else" in def ? resolveSteps(def.else, context) : undefined)
    );
  }

  switch(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.switch, context, value => {
      const cases = def.cases;
      if (!this.isObject(cases)) {
        return "default" in def ? resolveSteps(def.default, context) : undefined;
      }
      const key = this.toString(value);
      if (key in cases) return resolveSteps(cases[key], context);
      return "default" in def ? resolveSteps(def.default, context) : undefined;
    });
  }

  foreach(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.foreach, def.parallel, def.item, def.key], context, ([items, parallel, itemRaw, keyRaw]) => {
      const arr = this.toArray(items);
      const itemName = typeof itemRaw === "string" ? itemRaw : "item";
      const keyName = typeof keyRaw === "string" ? keyRaw : null;
      const template = def.do;

      // foreach iterates for effect/accumulation and yields the LAST iteration's
      // value (empty input → null). Use `map` when you need an array of every
      // result (e.g. rendering N elements from a collection).
      if (template === undefined || arr.length === 0) return null;

      const buildContext = (item: unknown, i: number): Context => ({
        ...context,
        [itemName]: item,
        ...(keyName ? { [keyName]: i } : {}),
        loop: {
          item, index: i, key: i,
          first: i === 0, last: i === arr.length - 1, length: arr.length,
        },
      });

      const run = Array.isArray(template)
        ? (ctx: Context) => runSteps(template, ctx)
        : (ctx: Context) => resolve(template, ctx);

      if (this.toBoolean(parallel)) {
        return Promise.all(arr.map((item, i) => run(buildContext(item, i))))
          .then(results => results.length ? results[results.length - 1] : null);
      }

      let last: unknown = null;
      let i = 0;
      function next(): unknown {
        if (i >= arr.length) return last;
        const idx = i++;
        const r = run(buildContext(arr[idx], idx));
        if (r instanceof Promise) return r.then(v => { last = v; return next(); });
        last = r;
        return next();
      }
      return next();
    });
  }

  and(def: Record<string, unknown>, context: Context): NodeValue {
    const conditions = this.toArray(def.and);
    let i = 0;
    const self = this;
    function next(): unknown {
      if (i >= conditions.length) return true;
      const cond = conditions[i++];
      return resolve(cond, context, v => {
        if (!self.toBoolean(v)) return false;
        return next();
      });
    }
    return next();
  }

  or(def: Record<string, unknown>, context: Context): NodeValue {
    const conditions = this.toArray(def.or);
    let i = 0;
    const self = this;
    function next(): unknown {
      if (i >= conditions.length) return false;
      const cond = conditions[i++];
      return resolve(cond, context, v => {
        if (self.toBoolean(v)) return true;
        return next();
      });
    }
    return next();
  }

  coalesce(def: Record<string, unknown>, context: Context): NodeValue {
    const values = this.toArray(def.coalesce);
    let i = 0;
    let last: unknown = undefined;
    const self = this;
    function next(): unknown {
      if (i >= values.length) return last;
      return resolve(values[i++], context, v => {
        last = v;
        if (!self.isEmptyValue(v)) return v;
        return next();
      });
    }
    return next();
  }

  not(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.not, context, v => !this.toBoolean(v));
  }

  eq(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.eq, context, ops => {
      const [a, b] = this.toArray(ops);
      return a === b;
    });
  }

  neq(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.neq, context, ops => {
      const [a, b] = this.toArray(ops);
      return a !== b;
    });
  }

  gt(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.gt, context, ops => {
      const [a, b] = this.toArray(ops);
      return this.toNumber(a) > this.toNumber(b);
    });
  }

  gte(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.gte, context, ops => {
      const [a, b] = this.toArray(ops);
      return this.toNumber(a) >= this.toNumber(b);
    });
  }

  lt(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.lt, context, ops => {
      const [a, b] = this.toArray(ops);
      return this.toNumber(a) < this.toNumber(b);
    });
  }

  lte(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.lte, context, ops => {
      const [a, b] = this.toArray(ops);
      return this.toNumber(a) <= this.toNumber(b);
    });
  }

  in(def: Record<string, unknown>, context: Context): NodeValue {
    const arr = this.toArray(def.in);
    if (arr.length < 2) return false;
    return resolveAll([arr[0], arr[1]], context, ([needle, haystack]) => {
      if (Array.isArray(haystack)) return (haystack as unknown[]).includes(needle);
      if (typeof haystack === "string" && typeof needle === "string") return haystack.includes(needle);
      if (this.isObject(haystack) && typeof needle === "string") return needle in haystack;
      return false;
    });
  }

  between(def: Record<string, unknown>, context: Context): NodeValue {
    const arr = this.toArray(def.between);
    if (arr.length < 3) return false;
    return resolveAll([arr[0], arr[1], arr[2]], context, ([value, min, max]) =>
      this.toNumber(value) >= this.toNumber(min) && this.toNumber(value) <= this.toNumber(max)
    );
  }

  typeof(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.typeof, context, value => this.typeName(value));
  }

  isType(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.isType, context, args => {
      const [value, type] = this.toArray(args);
      return this.typeName(value) === this.toString(type);
    });
  }

  // Jexs type name: arrays report "array" (not "object"), and null/undefined are
  // distinct. Everything else follows JS `typeof`.
  private typeName(value: unknown): string {
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (Array.isArray(value)) return "array";
    return typeof value;
  }

  empty(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.empty, context, value => this.isEmptyValue(value));
  }

  notEmpty(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.notEmpty, context, value => !this.isEmptyValue(value));
  }

  // Shared emptiness rule for empty / notEmpty / coalesce: null, undefined, "",
  // [], {} are empty; 0 and false (and other non-collections) are not.
  private isEmptyValue(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value === "string") return value === "";
    if (Array.isArray(value)) return value.length === 0;
    if (this.isObject(value)) return !hasAnyKey(value);
    return false;
  }

  sleep(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.sleep, context, ms => {
      const delay = this.toNumber(ms);
      if (delay <= 0) return null;
      return new Promise<null>(r => setTimeout(r, delay)).then(() => null);
    });
  }

  exec(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.exec, context, value => resolveSteps(value, context));
  }
}
