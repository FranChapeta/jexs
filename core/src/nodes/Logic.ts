import { Node, Context, NodeValue } from "./Node.js";
import { resolve, resolveAll } from "../Resolver.js";
import { runSteps, resolveSteps } from "../runSteps.js";

export class LogicNode extends Node {
  /**
   * Resolves `then` when the condition is truthy, otherwise `else`. Both branches are optional.
   *
   * @param {expr} if The condition expression to evaluate.
   * @param {stepsOrExpr} then Value to resolve when condition is truthy.
   * @param {stepsOrExpr} else Value to resolve when condition is falsy.
   * @example
   * { "if": { "var": "$active" }, "then": "yes", "else": "no" }
   */
  if(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.if, context, condition =>
      this.toBoolean(condition)
        ? ("then" in def ? resolveSteps(def.then, context) : true)
        : ("else" in def ? resolveSteps(def.else, context) : undefined)
    );
  }

  /**
   * Resolves the value of `switch`, matches it against string keys in `cases`, falls back to `default`.
   *
   * @param {expr} switch The value to match against case keys.
   * @param {map} cases Object mapping string keys to result expressions.
   * @param {stepsOrExpr} default Value to resolve when no case matches.
   * @example
   * { "switch": { "var": "$role" }, "cases": { "admin": "full", "user": "limited" }, "default": "none" }
   */
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

  /**
   * Iterates over an array, resolving `do` for each item. Use `as` to name the item variable (default `"item"`),
   * `key` for the index variable, and `parallel: true` to resolve all iterations concurrently.
   * Each iteration receives a `loop` context with `item`, `index`, `first`, `last`, and `length`.
   *
   * @param {expr} foreach The array or expression to iterate over.
   * @param {stepsOrExpr} do Steps or expression to resolve for each item.
   * @param {string} key Variable name to expose the current index (default `"index"`).
   * @param {boolean} parallel Resolve all iterations concurrently instead of sequentially.
   * @example
   * { "foreach": { "var": "$users" }, "as": "user", "do": { "var": "user.name" } }
   */
  foreach(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.foreach, def.parallel], context, ([items, parallel]) => {
      const arr = this.toArray(items);
      const itemName = typeof def.as === "string" ? def.as : "item";
      const keyName = typeof def.key === "string" ? def.key : null;
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

  /**
   * Short-circuit AND — returns `true` only if all conditions are truthy, stops at first falsy value.
   *
   * @param {expr[]} and Array of conditions to evaluate.
   * @example
   * { "and": [{ "var": "$loggedIn" }, { "var": "$verified" }] }
   */
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

  /**
   * Short-circuit OR — returns `true` at the first truthy condition, `false` if all are falsy.
   *
   * @param {expr[]} or Array of conditions to evaluate.
   * @example
   * { "or": [{ "var": "$isAdmin" }, { "var": "$isModerator" }] }
   */
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

  /**
   * Boolean negation — resolves the value and returns its logical inverse.
   *
   * @param {expr} not The expression to negate.
   * @example
   * { "not": { "var": "$active" } }
   */
  not(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.not, context, v => !this.toBoolean(v));
  }

  /**
   * Strict equality check between two resolved values.
   *
   * @param {[2]} eq Two values to compare: `[a, b]`.
   * @example
   * { "eq": [{ "var": "$status" }, "active"] }
   */
  eq(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.eq, context, ops => {
      const [a, b] = this.toArray(ops);
      return a === b;
    });
  }

  /**
   * Strict inequality check between two resolved values.
   *
   * @param {[2]} neq Two values to compare: `[a, b]`.
   * @example
   * { "neq": [{ "var": "$status" }, "banned"] }
   */
  neq(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.neq, context, ops => {
      const [a, b] = this.toArray(ops);
      return a !== b;
    });
  }

  /**
   * Greater-than comparison: `a > b`.
   *
   * @param {[2]} gt Two values: `[a, b]`.
   * @example
   * { "gt": [{ "var": "$age" }, 18] }
   */
  gt(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.gt, context, ops => {
      const [a, b] = this.toArray(ops);
      return this.toNumber(a) > this.toNumber(b);
    });
  }

  /**
   * Greater-than-or-equal comparison: `a >= b`.
   *
   * @param {[2]} gte Two values: `[a, b]`.
   * @example
   * { "gte": [{ "var": "$score" }, 100] }
   */
  gte(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.gte, context, ops => {
      const [a, b] = this.toArray(ops);
      return this.toNumber(a) >= this.toNumber(b);
    });
  }

  /**
   * Less-than comparison: `a < b`.
   *
   * @param {[2]} lt Two values: `[a, b]`.
   * @example
   * { "lt": [{ "var": "$remaining" }, 10] }
   */
  lt(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.lt, context, ops => {
      const [a, b] = this.toArray(ops);
      return this.toNumber(a) < this.toNumber(b);
    });
  }

  /**
   * Less-than-or-equal comparison: `a <= b`.
   *
   * @param {[2]} lte Two values: `[a, b]`.
   * @example
   * { "lte": [{ "var": "$quantity" }, 100] }
   */
  lte(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.lte, context, ops => {
      const [a, b] = this.toArray(ops);
      return this.toNumber(a) <= this.toNumber(b);
    });
  }

  /**
   * Tests membership: `needle in haystack`. Works with arrays, strings (substring), and object keys.
   *
   * @param {[2]} in Two values: `[needle, haystack]`.
   * @example
   * { "in": ["admin", { "var": "$roles" }] }
   */
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

  /**
   * Inclusive range check: `min <= value <= max`.
   *
   * @param {[3]} between Three values: `[value, min, max]`.
   * @example
   * { "between": [{ "var": "$age" }, 18, 65] }
   */
  between(def: Record<string, unknown>, context: Context): NodeValue {
    const arr = this.toArray(def.between);
    if (arr.length < 3) return false;
    return resolveAll([arr[0], arr[1], arr[2]], context, ([value, min, max]) =>
      this.toNumber(value) >= this.toNumber(min) && this.toNumber(value) <= this.toNumber(max)
    );
  }

  /**
   * Returns `true` if the value is `null`, `undefined`, `""`, `[]`, or `{}`.
   *
   * @param {expr} empty The value to check.
   * @example
   * { "empty": { "var": "$items" } }
   */
  empty(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.empty, context, value => {
      if (value === null || value === undefined) return true;
      if (typeof value === "string") return value === "";
      if (Array.isArray(value)) return value.length === 0;
      if (this.isObject(value)) return Object.keys(value).length === 0;
      return false;
    });
  }

  /**
   * Returns `true` if the value is non-null and non-empty. Inverse of `empty`.
   *
   * @param {expr} notEmpty The value to check.
   * @example
   * { "notEmpty": { "var": "$items" } }
   */
  notEmpty(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.notEmpty, context, value => {
      if (value === null || value === undefined) return false;
      if (typeof value === "string") return value !== "";
      if (Array.isArray(value)) return value.length > 0;
      if (this.isObject(value)) return Object.keys(value).length > 0;
      return true;
    });
  }

  /**
   * Pauses execution for the given number of milliseconds, then resolves to `null`.
   *
   * @param {number} sleep Duration in milliseconds.
   * @example
   * { "sleep": 500 }
   */
  sleep(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.sleep, context, ms => {
      const delay = this.toNumber(ms);
      if (delay <= 0) return null;
      return new Promise<null>(r => setTimeout(r, delay)).then(() => null);
    });
  }

  /**
   * Resolves its value, then executes the result as a step sequence. Useful for running dynamically resolved step arrays.
   *
   * @param {expr} exec The expression or step array to execute.
   * @example
   * { "exec": { "var": "$steps" } }
   */
  exec(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.exec, context, value => resolveSteps(value, context));
  }
}
