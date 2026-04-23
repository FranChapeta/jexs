import { Node, Context, NodeValue } from "./Node.js";
import { resolve } from "../Resolver.js";
import { getNestedValue } from "../helpers.js";

export class VariablesNode extends Node {
  /**
   * Reads a value from the current context by dot-path. Prefix the path with `$`.
   *
   * @example
   * { "var": "$user.name" }
   */
  var(def: Record<string, unknown>, context: Context): NodeValue {
    const varPath = def.var;
    if (typeof varPath === "string") return resolveVariable(varPath, context);
    return resolve(varPath, context, resolved => {
      if (typeof resolved !== "string") return undefined;
      return resolveVariable(resolved, context);
    });
  }

  /**
   * Resolves each value in the map and writes the result back into the context.
   * Pass `"raw": true` to skip resolving values.
   *
   * @example
   * { "setVars": { "count": 0, "name": { "var": "$user.name" } } }
   */
  setVars(def: Record<string, unknown>, context: Context): NodeValue {
    const vars = def.setVars;
    if (!vars || typeof vars !== "object" || Array.isArray(vars)) return null;
    const raw = !!def.raw;
    const entries = Object.entries(vars as Record<string, unknown>);
    let i = 0;
    function next(): unknown {
      if (i >= entries.length) return null;
      const [key, value] = entries[i++];
      if (raw) { Node.setContextValue(context, key, value); return next(); }
      return resolve(value, context, v => { Node.setContextValue(context, key, v); return next(); });
    }
    return next();
  }
}

export function resolveVariable(path: string, context: Context): unknown {
  const cleanPath = path.startsWith("$") ? path.slice(1) : path;
  if (!cleanPath) return undefined;
  return getNestedValue(context, cleanPath);
}

export function interpolate(template: string, context: Context): string {
  return template.replace(
    /\$([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)/g,
    (_, path) => valueToString(resolveVariable(path, context)),
  );
}

export function hasVariables(value: string): boolean {
  return /\$[a-zA-Z_][a-zA-Z0-9_]*/.test(value);
}

function valueToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
