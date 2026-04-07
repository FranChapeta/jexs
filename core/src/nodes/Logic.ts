import { Node, Context, NodeValue } from "./Node.js";
import { resolve } from "../Resolver.js";

/**
 * Handles logic operations: conditionals, loops, comparisons.
 *
 * Supported operations:
 * - { "if": condition, "then": value, "else": value }
 * - { "switch": value, "cases": { "a": v1, "b": v2 }, "default": v3 }
 * - { "foreach": array, "as": "item", "do": template }
 * - { "and": [conditions...] }
 * - { "or": [conditions...] }
 * - { "not": condition }
 * - { "eq": [a, b] }, { "neq": [a, b] }
 * - { "gt": [a, b] }, { "gte": [a, b] }, { "lt": [a, b] }, { "lte": [a, b] }
 * - { "in": [needle, haystack] }
 * - { "between": [value, min, max] }
 * - { "empty": value }, { "notEmpty": value }
 */
export class LogicNode extends Node {
  async eq(d: Record<string, unknown>, c: Context) {
    return comparison(d.eq, c, (a, b) => a === b);
  }
  async neq(d: Record<string, unknown>, c: Context) {
    return comparison(d.neq, c, (a, b) => a !== b);
  }
  async gt(d: Record<string, unknown>, c: Context) {
    return comparison(d.gt, c, (a, b) => this.toNumber(a) > this.toNumber(b));
  }
  async gte(d: Record<string, unknown>, c: Context) {
    return comparison(d.gte, c, (a, b) => this.toNumber(a) >= this.toNumber(b));
  }
  async lt(d: Record<string, unknown>, c: Context) {
    return comparison(d.lt, c, (a, b) => this.toNumber(a) < this.toNumber(b));
  }
  async lte(d: Record<string, unknown>, c: Context) {
    return comparison(d.lte, c, (a, b) => this.toNumber(a) <= this.toNumber(b));
  }
  async notEmpty(d: Record<string, unknown>, c: Context) {
    return !(await this.empty({ empty: d.notEmpty }, c));
  }

  async if(def: Record<string, unknown>, context: Context): Promise<unknown> {
    const condition = await resolve(def.if, context);

    if (this.toBoolean(condition)) {
      return "then" in def ? resolveSteps(def.then, context) : true;
    }

    return "else" in def ? resolveSteps(def.else, context) : undefined;
  }

  async switch(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const value = await resolve(def.switch, context);
    const cases = def.cases;

    if (!this.isObject(cases)) {
      return "default" in def ? resolveSteps(def.default, context) : undefined;
    }

    const key = this.toString(value);
    if (key in cases) {
      return resolveSteps(cases[key], context);
    }

    return "default" in def ? resolveSteps(def.default, context) : undefined;
  }

  async foreach(def: Record<string, unknown>, context: Context): Promise<unknown[]> {
    const items = await resolve(def.foreach, context);
    const itemName = typeof def.as === "string" ? def.as : "item";
    const keyName = typeof def.key === "string" ? def.key : null;
    const template = def.do;
    const parallel = this.toBoolean(def.parallel);

    if (template === undefined) return [];

    const arr = this.toArray(items);

    const buildContext = (item: unknown, i: number): Context => ({
      ...context,
      [itemName]: item,
      ...(keyName ? { [keyName]: i } : {}),
      loop: {
        item,
        index: i,
        key: i,
        first: i === 0,
        last: i === arr.length - 1,
        length: arr.length,
      },
    });

    const run = Array.isArray(template)
      ? (ctx: Context) => runSteps(template, ctx)
      : (ctx: Context) => resolve(template, ctx);

    if (parallel) {
      return Promise.all(
        arr.map((item, i) => run(buildContext(item, i))),
      );
    }

    const results: unknown[] = [];
    for (let i = 0; i < arr.length; i++) {
      results.push(await run(buildContext(arr[i], i)));
    }
    return results;
  }

  async and(def: Record<string, unknown>, context: Context): Promise<boolean> {
    const conditions = this.toArray(def.and);
    for (const cond of conditions) {
      if (!this.toBoolean(await resolve(cond, context))) return false;
    }
    return true;
  }

  async or(def: Record<string, unknown>, context: Context): Promise<boolean> {
    const conditions = this.toArray(def.or);
    for (const cond of conditions) {
      if (this.toBoolean(await resolve(cond, context))) return true;
    }
    return false;
  }

  async not(def: Record<string, unknown>, context: Context): Promise<boolean> {
    return !this.toBoolean(await resolve(def.not, context));
  }

  async in(def: Record<string, unknown>, context: Context): Promise<boolean> {
    const arr = this.toArray(def.in);
    if (arr.length < 2) return false;

    const needle = await resolve(arr[0], context);
    const haystack = await resolve(arr[1], context);

    if (Array.isArray(haystack)) {
      return haystack.includes(needle);
    }

    if (typeof haystack === "string" && typeof needle === "string") {
      return haystack.includes(needle);
    }

    if (this.isObject(haystack) && typeof needle === "string") {
      return needle in haystack;
    }

    return false;
  }

  async between(def: Record<string, unknown>, context: Context): Promise<boolean> {
    const arr = this.toArray(def.between);
    if (arr.length < 3) return false;

    const value = this.toNumber(await resolve(arr[0], context));
    const min = this.toNumber(await resolve(arr[1], context));
    const max = this.toNumber(await resolve(arr[2], context));

    return value >= min && value <= max;
  }

  async sleep(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const ms = this.toNumber(await resolve(def.sleep, context));
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
    return null;
  }

  async exec(def: Record<string, unknown>, context: Context): Promise<unknown> {
    const value = await resolve(def.exec, context);
    return resolveSteps(value, context);
  }

  async empty(def: Record<string, unknown>, context: Context): Promise<boolean> {
    const value = await resolve(def.empty, context);

    if (value === null || value === undefined) return true;
    if (typeof value === "string") return value === "";
    if (Array.isArray(value)) return value.length === 0;
    if (this.isObject(value)) return Object.keys(value).length === 0;

    return false;
  }
}

async function comparison(
  operands: unknown,
  context: Context,
  comparator: (a: unknown, b: unknown) => boolean,
): Promise<boolean> {
  if (!Array.isArray(operands) || operands.length < 2) return false;
  const a = await resolve(operands[0], context);
  const b = await resolve(operands[1], context);
  return comparator(a, b);
}

// resolveSteps is imported from the shared utility
import { runSteps, resolveSteps } from "../runSteps.js";
