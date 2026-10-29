import { Node, Context, NodeValue, childContext } from "./Node.js";
import { resolve, resolveAll, isStep, runSteps } from "../Resolver.js";
import { Html, hasAnyKey, isObject, operands } from "../helpers.js";
import type { JexsNodeSchema } from "../schema.js";

export class LogicNode extends Node {
  static schema: JexsNodeSchema = {
    if: {
      markdownDescription: "Resolves `then` when the condition is truthy, otherwise `else`. `then` is required and `else` optional; for a branch on a falsy condition alone, negate it with `not`.",
      outputDescription: "The resolved value of the taken branch, or `undefined` for a falsy condition without `else`. A branch that is an **array** is run as a step sequence and yields only its LAST value, so wrap multiple elements in one container if you need them all.",
      examples: [
        "{ \"$if\": { \"$var\": \"active\" }, \"then\": \"yes\", \"else\": \"no\" }",
      ],
      siblings: {
        then: {
          required: true,
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
        "{ \"$switch\": { \"$var\": \"role\" }, \"cases\": { \"admin\": \"full\", \"user\": \"limited\" }, \"default\": \"none\" }",
      ],
      siblings: {
        cases: {
          map: true,
          required: true,
          description: "Object mapping string keys to result expressions; only the matched one is resolved. A step here resolves to a lookup table instead, and the matched entry is returned as data.",
        },
        default: {
          description: "Value to resolve when no case matches.",
        },
      },
    },
    foreach: {
      markdownDescription: "Iterates over an array, resolving `do` for each item, for side-effects or accumulation. Each iteration exposes the current element as `item` and its position as `index` (rename via the `item`/`index` siblings). Pass `parallel: true` to resolve all iterations concurrently.",
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
    and: {
      type: "array",
      output: "boolean",
      markdownDescription: "Short-circuit AND. Evaluates conditions left to right, stopping at the first falsy one.",
      outputDescription: "`true` if every condition is truthy, otherwise `false` (an empty array is `true`).",
      examples: [
        "{ \"$and\": [{ \"$var\": \"loggedIn\" }, { \"$var\": \"verified\" }] }",
      ],
    },
    or: {
      type: "array",
      output: "boolean",
      markdownDescription: "Short-circuit OR. Evaluates conditions left to right, stopping at the first truthy one.",
      outputDescription: "`true` at the first truthy condition, otherwise `false` (an empty array is `false`).",
      examples: [
        "{ \"$or\": [{ \"$var\": \"isAdmin\" }, { \"$var\": \"isModerator\" }] }",
      ],
    },
    coalesce: {
      type: "array",
      output: "any",
      markdownDescription: "Resolves values left to right, returning the first non-empty one: the value itself, not a boolean. Short-circuits, so later expressions are never resolved once a value is found. Use it to supply a fallback without repeating an expression across `$if`/`then`.",
      outputDescription: "The first value that is not empty (`null`, `undefined`, `\"\"`, `[]`, `{}` are skipped; `0` and `false` are kept, the same rule as `empty`). If every value is empty, the LAST one is returned; an empty array yields `undefined`.",
      examples: [
        "{ \"$coalesce\": [{ \"$var\": \"props.button.properties.size.type\" }, \"any\"] }",
      ],
    },
    not: {
      output: "boolean",
      markdownDescription: "Boolean negation of the resolved value's truthiness.",
      outputDescription: "`true` when the value is falsy, otherwise `false`.",
      examples: [
        "{ \"$not\": { \"$var\": \"active\" } }",
      ],
    },
    eq: {
      tuple: 2,
      prefixItems: [
        { description: "One value, of any type." },
        { description: "The other value." },
      ],
      output: "boolean",
      markdownDescription: "Strict equality check between two resolved values.",
      examples: [
        "{ \"$eq\": [{ \"$var\": \"status\" }, \"active\"] }",
      ],
    },
    neq: {
      tuple: 2,
      prefixItems: [
        { description: "One value, of any type." },
        { description: "The other value." },
      ],
      output: "boolean",
      markdownDescription: "Strict inequality check between two resolved values.",
      examples: [
        "{ \"$neq\": [{ \"$var\": \"status\" }, \"banned\"] }",
      ],
    },
    gt: {
      tuple: 2,
      prefixItems: [
        { type: "number", description: "The value `a`." },
        { type: "number", description: "The value `b` it must be greater than." },
      ],
      output: "boolean",
      markdownDescription: "Greater-than comparison: `a > b`.",
      examples: [
        "{ \"$gt\": [{ \"$var\": \"age\" }, 18] }",
      ],
    },
    gte: {
      tuple: 2,
      prefixItems: [
        { type: "number", description: "The value `a`." },
        { type: "number", description: "The value `b` it must be at least." },
      ],
      output: "boolean",
      markdownDescription: "Greater-than-or-equal comparison: `a >= b`.",
      examples: [
        "{ \"$gte\": [{ \"$var\": \"score\" }, 100] }",
      ],
    },
    lt: {
      tuple: 2,
      prefixItems: [
        { type: "number", description: "The value `a`." },
        { type: "number", description: "The value `b` it must be less than." },
      ],
      output: "boolean",
      markdownDescription: "Less-than comparison: `a < b`.",
      examples: [
        "{ \"$lt\": [{ \"$var\": \"remaining\" }, 10] }",
      ],
    },
    lte: {
      tuple: 2,
      prefixItems: [
        { type: "number", description: "The value `a`." },
        { type: "number", description: "The value `b` it must be at most." },
      ],
      output: "boolean",
      markdownDescription: "Less-than-or-equal comparison: `a <= b`.",
      examples: [
        "{ \"$lte\": [{ \"$var\": \"quantity\" }, 100] }",
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
        "{ \"$between\": [{ \"$var\": \"age\" }, 18, 65] }",
      ],
    },
    typeof: {
      output: "string",
      markdownDescription: "Resolves a value and returns its Jexs type name as a string.",
      outputDescription: "One of `\"null\"`, `\"undefined\"`, `\"array\"`, `\"object\"`, `\"number\"`, `\"string\"`, `\"boolean\"`, `\"html\"`. Arrays report `\"array\"` (not `\"object\"`); `null` and `undefined` are distinct; what `$tag` and `$html` return is `\"html\"`.",
      examples: [
        "{ \"$typeof\": { \"$var\": \"value\" } }",
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
            "html",
          ],
          description: "The type name to match against.",
        },
      ],
      output: "boolean",
      markdownDescription: "Tests whether a value's type matches a type name. Tuple form `[value, type]` where `type` is one of `\"null\"`, `\"undefined\"`, `\"array\"`, `\"object\"`, `\"number\"`, `\"string\"`, `\"boolean\"`, `\"html\"`. Equivalent to `{ $eq: [{ $typeof: value }, type] }`.",
      outputDescription: "`true` when `typeof(value) === type`, otherwise `false`.",
      examples: [
        "{ \"$isType\": [{ \"$var\": \"roles\" }, \"array\"] }",
      ],
    },
    empty: {
      output: "boolean",
      markdownDescription: "Tests whether the resolved value is empty. For the opposite, wrap it in `not`.",
      outputDescription: "`true` for `null`, `undefined`, `\"\"`, `[]`, or `{}`; otherwise `false`.",
      examples: [
        "{ \"$empty\": { \"$var\": \"items\" } }",
        "{ \"$not\": { \"$empty\": { \"$var\": \"items\" } } }",
      ],
    },
  };

  if(def: Record<string, unknown>, context: Context): NodeValue {
    if (!("then" in def)) throw new Error("if needs a `then`");
    return resolve(def.$if, context, condition =>
      this.toBoolean(condition)
        ? runSteps(def.then, context)
        : ("else" in def ? runSteps(def.else, context) : undefined)
    );
  }

  switch(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$switch, context, value => {
      const cases = def.cases;
      const key = this.toString(value);
      const fallback = (): unknown => "default" in def ? runSteps(def.default, context) : undefined;
      // A step resolves to a lookup table, whose entries are data: the matched one
      // comes back as it is, never run. A literal map stays lazy: only the matched
      // case is resolved.
      if (isStep(cases)) {
        return resolve(cases, context, table =>
          this.isObject(table) && Object.hasOwn(table, key) ? table[key] : fallback());
      }
      if (!this.isObject(cases)) {
        if (!("cases" in def)) throw new Error("switch needs a `cases` map");
        return fallback();
      }
      return Object.hasOwn(cases, key) ? runSteps(cases[key], context) : fallback();
    });
  }

  foreach(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$foreach, def.parallel, def.item, def.index], context, ([items, parallel, itemRaw, indexRaw]) => {
      const arr = this.toArray(items);
      const itemName = typeof itemRaw === "string" ? itemRaw : "item";
      const indexName = typeof indexRaw === "string" ? indexRaw : "index";
      const template = def.do;
      if (template === undefined) throw new Error("foreach needs a `do` template");

      // foreach iterates for effect/accumulation and yields the LAST iteration's
      // value (empty input → null). Use `map` when you need an array of every
      // result (e.g. rendering N elements from a collection).
      if (arr.length === 0) return null;

      const buildContext = (item: unknown, i: number): Context =>
        childContext(context, { [itemName]: item, [indexName]: i });

      if (this.toBoolean(parallel)) {
        return Promise.all(arr.map((item, i) => runSteps(template, buildContext(item, i))))
          .then(results => results.length ? results[results.length - 1] : null);
      }

      let last: unknown = null;
      let i = 0;
      function next(): unknown {
        if (i >= arr.length) return last;
        const idx = i++;
        const r = runSteps(template, buildContext(arr[idx], idx));
        if (r instanceof Promise) return r.then(v => { last = v; return next(); });
        last = r;
        return next();
      }
      return next();
    });
  }

  and(def: Record<string, unknown>, context: Context): NodeValue {
    const conditions = this.toArray(def.$and);
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
    const conditions = this.toArray(def.$or);
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
    const values = this.toArray(def.$coalesce);
    let i = 0;
    let last: unknown = undefined;
    function next(): unknown {
      if (i >= values.length) return last;
      return resolve(values[i++], context, v => {
        last = v;
        if (!isEmptyValue(v)) return v;
        return next();
      });
    }
    return next();
  }

  not(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$not, context, v => !this.toBoolean(v));
  }

  eq(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$eq, context, ops => {
      const [a, b] = operands("eq", ops, 2);
      return a === b;
    });
  }

  neq(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$neq, context, ops => {
      const [a, b] = operands("neq", ops, 2);
      return a !== b;
    });
  }

  gt(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$gt, context, ops => {
      const [a, b] = operands("gt", ops, 2);
      return this.toNumber(a) > this.toNumber(b);
    });
  }

  gte(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$gte, context, ops => {
      const [a, b] = operands("gte", ops, 2);
      return this.toNumber(a) >= this.toNumber(b);
    });
  }

  lt(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$lt, context, ops => {
      const [a, b] = operands("lt", ops, 2);
      return this.toNumber(a) < this.toNumber(b);
    });
  }

  lte(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$lte, context, ops => {
      const [a, b] = operands("lte", ops, 2);
      return this.toNumber(a) <= this.toNumber(b);
    });
  }

  between(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$between, context, ops => {
      const [value, min, max] = operands("between", ops, 3);
      return this.toNumber(value) >= this.toNumber(min) && this.toNumber(value) <= this.toNumber(max);
    });
  }

  typeof(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$typeof, context, value => typeName(value));
  }

  isType(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$isType, context, args => {
      const [value, type] = this.toArray(args);
      return typeName(value) === this.toString(type);
    });
  }

  empty(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$empty, context, value => isEmptyValue(value));
  }

}

// Jexs type name: arrays report "array" (not "object"), markup "html", and
// null/undefined are distinct. Everything else follows JS `typeof`.
function typeName(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  if (value instanceof Html) return "html";
  return typeof value;
}

// Shared emptiness rule for empty / coalesce: null, undefined, "",
// [], {} are empty; 0 and false (and other non-collections) are not.
function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value === "";
  if (Array.isArray(value)) return value.length === 0;
  if (isObject(value)) return !hasAnyKey(value);
  return false;
}
