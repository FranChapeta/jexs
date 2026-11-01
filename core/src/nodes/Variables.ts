import { Node, Context, NodeValue, childContext, boundaryContext, ALLOWED_OPS } from "./Node.js";
import { resolve, resolveAll, isStep, runSteps } from "../Resolver.js";
import { freezeData, getNestedValue } from "../helpers.js";
import type { JexsNodeSchema } from "../schema.js";

export class VariablesNode extends Node {
  static schema: JexsNodeSchema = {
    var: {
      markdownDescription: "Reads a value from the current context by dot-path. The path itself may be an expression that resolves to a string (e.g. `{ \"$concat\": [...] }`). The value comes back as data: steps stored in it do not run, unless through `$runVar`.",
      outputDescription: "The value stored at the dot-path, whatever type it holds (string, number, boolean, array, object), or `undefined` if any segment of the path is missing.",
      examples: [
        "{ \"$var\": \"user.name\" }",
      ],
    },
    setVars: {
      map: true,
      output: "null",
      markdownDescription: "Resolves each value in the map, in order, and writes the result back into the context (supports dot-paths, e.g. `\"request.body.id\"`). A step in place of the map resolves to an object whose keys are all written.\nPass `\"data\": true` to write the values as data, without resolving them.\nPass `\"$bubble\": true` to write them in an enclosing scope instead (the nearest that has each as its own, else the outermost the write can reach), so they survive after the current file/loop/handler returns.\nPass `\"readonly\": true` to make the values read-only, so no step can change the objects and arrays they hold.",
      outputDescription: "Always `null`. `setVars` is used for its side-effect of writing into the context, which later steps read via `{ \"$var\": \"…\" }`.",
      examples: [
        "{ \"$setVars\": { \"count\": 0, \"name\": { \"$var\": \"user.name\" } } }",
      ],
      siblings: {
        data: {
          type: "boolean",
          description: "Write a literal map's values as data, without resolving them, as `$file` does with `data: true`.",
        },
        readonly: {
          type: "boolean",
          description: "Make each value read-only as it is written: no step can change its objects and arrays afterwards, at any depth, whether through a dot-path `$setVars`, another variable holding the same object, or `$push`, `$sort` and the other ops that change an array (with `clone: true` they work on a copy instead). For data that many flows read and none should change, such as a server's startup data, which every request shares. The variable itself can still be set to a new value.",
        },
      },
    },
    runVar: {
      type: "string",
      output: "any",
      markdownDescription: "Runs the steps held in a variable, read by dot-path as `$var` reads it: one step, or a sequence whose `$as` bindings later steps see. Steps in a variable are data until run this way, so a value from a request or a file never runs by accident; this is how a template kept in a variable renders inside `content`.\nPass `params` to run them against a copy of the context with those variables added; the caller's context is left untouched.",
      outputDescription: "What the steps produce: the last step's value for a sequence.",
      examples: [
        "{ \"$runVar\": \"card\" }",
        "{ \"$runVar\": \"templates.row\", \"params\": { \"title\": \"Home\" } }",
      ],
      siblings: {
        params: {
          map: true,
          description: "Variables added for the steps, in a copy of the context: a map of values, or a step resolving to one.",
        },
        allow: {
          type: "array",
          items: { type: "string" },
          description: "The only ops the steps may run, by name without the `$` (`[\"tag\", \"if\", \"var\"]`); any other throws, in a step they hold, in a `$file` they load, or in a `$runVar` they run, which can narrow the list but never widen it. The steps run in a scope of their own, so a `$bubble` stops before the caller's variables. For steps an app holds but did not write, such as a page an editor saved.",
        },
      },
    },
  };

  runVar(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.$runVar, def.params ?? null, def.allow], context, ([path, params, allow]) => {
      if (typeof path !== "string" || path === "") {
        throw new Error("$runVar takes the dot-path of a variable holding steps");
      }
      const steps = resolveVariable(path, context);
      if (steps === undefined) throw new Error(`$runVar: no variable at "${path}"`);
      const vars = this.isObject(params) ? params : undefined;
      if (allow === undefined || allow === null) return runSteps(steps, vars ? childContext(context, vars) : context);
      if (!Array.isArray(allow) || allow.some(op => typeof op !== "string")) throw new Error("$runVar: `allow` takes a list of op names");
      // A list inside another keeps only what both allow.
      const outer = context[ALLOWED_OPS] as ReadonlySet<string> | undefined;
      const allowed = new Set((allow as string[]).map(op => op.replace(/^\$/, "")).filter(op => !outer || outer.has(op)));
      return runSteps(steps, boundaryContext(context, { ...vars, [ALLOWED_OPS]: allowed }));
    });
  }

  var(def: Record<string, unknown>, context: Context): NodeValue {
    const varPath = def.$var;
    if (typeof varPath === "string") return resolveVariable(varPath, context);
    return resolve(varPath, context, resolved => {
      if (typeof resolved !== "string") return undefined;
      return resolveVariable(resolved, context);
    });
  }

  setVars(def: Record<string, unknown>, context: Context): NodeValue {
    const vars = def.$setVars;
    // `$bubble` (the global write modifier) may be an expression: resolve it once,
    // then coerce with the shared node truthiness rules before writing the entries.
    return resolveAll([def.$bubble, def.data, def.readonly], context, ([bubbleRaw, dataRaw, readonlyRaw]) => {
      const bubble = this.toBoolean(bubbleRaw);
      const readonly = this.toBoolean(readonlyRaw);
      const write = (key: string, value: unknown) => Node.setContextValue(context, key, readonly ? freezeData(value) : value, bubble);
      // A step resolves to an object whose keys are all written at once.
      if (isStep(vars)) {
        return resolve(vars, context, values => {
          if (!this.isObject(values)) throw new Error(`$setVars: the step must resolve to an object of names and values, got ${JSON.stringify(values)}`);
          for (const key of Object.keys(values)) write(key, values[key]);
          return null;
        });
      }
      if (!this.isObject(vars)) throw new Error(`$setVars takes an object of names and values, got ${JSON.stringify(vars)}`);
      // A literal map is written in order, so a later value can read an earlier one.
      const data = this.toBoolean(dataRaw);
      const keys = Object.keys(vars);
      let i = 0;
      const next = (): unknown => {
        if (i >= keys.length) return null;
        const key = keys[i++];
        if (data) { write(key, vars[key]); return next(); }
        return resolve(vars[key], context, v => { write(key, v); return next(); });
      };
      return next();
    });
  }
}

export function resolveVariable(path: string, context: Context): unknown {
  if (!path) return undefined;
  return getNestedValue(context, path);
}
