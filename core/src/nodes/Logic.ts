import { Node, Context, NodeValue } from "./Node.js";
import { resolve, resolveAll } from "../Resolver.js";
import { runSteps, resolveSteps } from "../Resolver.js";
import type { JexsNodeSchema } from "../schema.js";

export class LogicNode extends Node {
  static schema: JexsNodeSchema = {
    if: {
      markdownDescription: "Resolves `then` when the condition is truthy, otherwise `else`. Both branches are optional.",
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
      output: "array",
      markdownDescription: "Iterates over an array, resolving `do` for each item. Use `item` to name the item variable (default `\"item\"`), `key` for the index variable, and `parallel: true` to resolve all iterations concurrently.\nEach iteration receives a `loop` context with `item`, `index`, `first`, `last`, and `length`.",
      examples: [
        "{ \"foreach\": { \"var\": \"$users\" }, \"item\": \"user\", \"do\": { \"var\": \"user.name\" } }",
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
      markdownDescription: "Short-circuit AND — returns `true` only if all conditions are truthy, stops at first falsy value.",
      examples: [
        "{ \"and\": [{ \"var\": \"$loggedIn\" }, { \"var\": \"$verified\" }] }",
      ],
    },
    or: {
      type: "array",
      output: "boolean",
      markdownDescription: "Short-circuit OR — returns `true` at the first truthy condition, `false` if all are falsy.",
      examples: [
        "{ \"or\": [{ \"var\": \"$isAdmin\" }, { \"var\": \"$isModerator\" }] }",
      ],
    },
    not: {
      output: "boolean",
      markdownDescription: "Boolean negation — resolves the value and returns its logical inverse.",
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
      output: "boolean",
      markdownDescription: "Inclusive range check: `min <= value <= max`.",
      examples: [
        "{ \"between\": [{ \"var\": \"$age\" }, 18, 65] }",
      ],
    },
    empty: {
      output: "boolean",
      markdownDescription: "Returns `true` if the value is `null`, `undefined`, `\"\"`, `[]`, or `{}`.",
      examples: [
        "{ \"empty\": { \"var\": \"$items\" } }",
      ],
    },
    notEmpty: {
      output: "boolean",
      markdownDescription: "Returns `true` if the value is non-null and non-empty. Inverse of `empty`.",
      examples: [
        "{ \"notEmpty\": { \"var\": \"$items\" } }",
      ],
    },
    sleep: {
      type: "number",
      output: "null",
      markdownDescription: "Pauses execution for the given number of milliseconds, then resolves to `null`.",
      examples: [
        "{ \"sleep\": 500 }",
      ],
    },
    exec: {
      markdownDescription: "Resolves its value, then executes the result as a step sequence. Useful for running dynamically resolved step arrays.",
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

      if (template === undefined) return [];

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
        return Promise.all(arr.map((item, i) => run(buildContext(item, i))));
      }

      const results: unknown[] = [];
      let i = 0;
      function next(): unknown {
        if (i >= arr.length) return results;
        const idx = i++;
        const r = run(buildContext(arr[idx], idx));
        if (r instanceof Promise) return r.then(v => { results.push(v); return next(); });
        results.push(r);
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

  empty(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.empty, context, value => {
      if (value === null || value === undefined) return true;
      if (typeof value === "string") return value === "";
      if (Array.isArray(value)) return value.length === 0;
      if (this.isObject(value)) return Object.keys(value).length === 0;
      return false;
    });
  }

  notEmpty(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.notEmpty, context, value => {
      if (value === null || value === undefined) return false;
      if (typeof value === "string") return value !== "";
      if (Array.isArray(value)) return value.length > 0;
      if (this.isObject(value)) return Object.keys(value).length > 0;
      return true;
    });
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
