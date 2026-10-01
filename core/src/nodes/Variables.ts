import { Node, Context, NodeValue } from "./Node.js";
import { resolve, isStep } from "../Resolver.js";
import { getNestedValue } from "../helpers.js";
import type { JexsNodeSchema } from "../schema.js";

export class VariablesNode extends Node {
  static schema: JexsNodeSchema = {
    var: {
      markdownDescription: "Reads a value from the current context by dot-path. Prefix the path with `$`. The path itself may be an expression that resolves to a string (e.g. `{ \"$concat\": [...] }`).",
      outputDescription: "The value stored at the dot-path, whatever type it holds (string, number, boolean, array, object), or `undefined` if any segment of the path is missing.",
      examples: [
        "{ \"$var\": \"user.name\" }",
      ],
    },
    setVars: {
      map: true,
      output: "null",
      markdownDescription: "Resolves each value in the map, in order, and writes the result back into the context (supports dot-paths, e.g. `\"request.body.id\"`). A step in place of the map resolves to an object whose keys are all written.\nPass `\"data\": true` to write the values as data, without resolving them.\nPass `\"$bubble\": true` to also write into every enclosing scope, so the values survive after the current file/loop/branch returns.",
      outputDescription: "Always `null`. `setVars` is used for its side-effect of writing into the context, which later steps read via `{ \"$var\": \"…\" }`.",
      examples: [
        "{ \"$setVars\": { \"count\": 0, \"name\": { \"$var\": \"user.name\" } } }",
      ],
      siblings: {
        data: {
          type: "boolean",
          description: "Write a literal map's values as data, without resolving them, as `$file` does with `data: true`.",
        },
      },
    },
  };

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
    return resolve(def.$bubble, context, bubbleRaw => {
      const bubble = this.toBoolean(bubbleRaw);
      // A step resolves to an object whose keys are all written at once.
      if (isStep(vars)) {
        return resolve(vars, context, values => {
          if (!this.isObject(values)) return null;
          for (const key of Object.keys(values)) Node.setContextValue(context, key, values[key], bubble);
          return null;
        });
      }
      if (!this.isObject(vars)) return null;
      // A literal map is written in order, so a later value can read an earlier one.
      const data = !!def.data;
      const keys = Object.keys(vars);
      let i = 0;
      const next = (): unknown => {
        if (i >= keys.length) return null;
        const key = keys[i++];
        if (data) { Node.setContextValue(context, key, vars[key], bubble); return next(); }
        return resolve(vars[key], context, v => { Node.setContextValue(context, key, v, bubble); return next(); });
      };
      return next();
    });
  }
}

export function resolveVariable(path: string, context: Context): unknown {
  if (!path) return undefined;
  return getNestedValue(context, path);
}

// `/g` const used only with String.replace (lastIndex-safe); never call .test/.exec.
const VAR_TOKEN = /\$([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)/g;
// Non-global, used only with .test — safe to share as a module const.
const HAS_VAR = /\$[a-zA-Z_][a-zA-Z0-9_]*/;

export function interpolate(template: string, context: Context): string {
  return template.replace(
    VAR_TOKEN,
    (_, path) => valueToString(resolveVariable(path, context)),
  );
}

export function hasVariables(value: string): boolean {
  return HAS_VAR.test(value);
}

function valueToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
