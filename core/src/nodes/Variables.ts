import { Node, Context, NodeValue } from "./Node.js";
import { resolve } from "../Resolver.js";
import { getNestedValue } from "../helpers.js";

/**
 * Resolves variable references from context.
 *
 * Formats supported:
 * - { "var": "$name" }                              -> read variable
 * - { "setVars": { "$hp": 100, "$round": 0 } }     -> set multiple (values resolved)
 * - { "setVars": { "$fn": {...} }, "raw": true }    -> set multiple (values stored raw)
 */
export class VariablesNode extends Node {
  async var(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    let varPath = def.var;
    if (typeof varPath !== "string") {
      varPath = await resolve(varPath, context);
      if (typeof varPath !== "string") return undefined;
    }
    return resolveVariable(varPath, context);
  }

  async setVars(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const vars = def.setVars;
    if (!vars || typeof vars !== "object" || Array.isArray(vars)) return null;
    const raw = !!def.raw;
    for (const [key, value] of Object.entries(vars as Record<string, unknown>)) {
      Node.setContextValue(context, key, raw ? value : await resolve(value, context));
    }
    return null;
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

