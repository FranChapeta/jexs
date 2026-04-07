/**
 * Base class for all value resolver nodes.
 *
 * Nodes interpret JSON expressions at runtime, transforming data structures
 * like { "var": "$user.name" } or { "concat": ["Hello", " ", "World"] }
 * into actual values.
 */

export interface Context {
  [key: string]: unknown;
  /** HTTP request data */
  request?: {
    method?: string;
    path?: string;
    body?: Record<string, unknown>;
    query?: Record<string, unknown>;
    params?: Record<string, unknown>;
    headers?: Record<string, string | string[] | undefined>;
    cookies?: Record<string, string>;
  };
  /** Session data */
  session?: Record<string, unknown>;
  /** Current loop context for foreach */
  loop?: {
    item: unknown;
    index: number;
    key: string | number;
    first: boolean;
    last: boolean;
    length: number;
  };
}

export type NodeValue = unknown;

export abstract class Node {
  /**
   * Keys this node handles for key-based dispatch in the resolver.
   * Default: auto-discovers own prototype methods not on Node.prototype.
   */
  get handlerKeys(): readonly string[] | null {
    const own = Object.getOwnPropertyNames(Object.getPrototypeOf(this));
    const result = own.filter(k => !nodeProtoKeys.has(k) && k !== "constructor");
    return result.length > 0 ? result : null;
  }

  /**
   * Resolve this node to a concrete value.
   * matchedKey is the key that triggered dispatch (e.g. "concat", "if").
   * Default: calls this[matchedKey](definition, context) via prototype.
   */
  resolve(definition: unknown, context: Context, matchedKey?: string): NodeValue {
    if (!matchedKey || !this.isObject(definition)) return undefined;
    const handler = Object.getPrototypeOf(this)[matchedKey];
    return typeof handler === "function" ? handler.call(this, definition, context) : null;
  }

  /**
   * Helper: Check if value is a plain object
   */
  protected isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  /**
   * Helper: Set nested value in context using dot notation for "as" support.
   * e.g. setContextValue(ctx, "request.body.value", hash) sets ctx.request.body.value
   */
  static setContextValue(context: Context, varName: string, value: unknown): void {
    const parts = varName.replace(/^\$/, "").split(".");
    if (parts.length === 1) {
      context[parts[0]] = value;
      return;
    }
    let target: Record<string, unknown> = context;
    for (let i = 0; i < parts.length - 1; i++) {
      if (target[parts[i]] && typeof target[parts[i]] === "object") {
        target = target[parts[i]] as Record<string, unknown>;
      } else {
        target[parts[i]] = {};
        target = target[parts[i]] as Record<string, unknown>;
      }
    }
    target[parts[parts.length - 1]] = value;
  }

  /**
   * Helper: Convert value to string
   */
  protected toString(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean")
      return String(value);
    return JSON.stringify(value);
  }

  /**
   * Helper: Convert value to number
   */
  protected toNumber(value: unknown): number {
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const num = parseFloat(value);
      return isNaN(num) ? 0 : num;
    }
    if (typeof value === "boolean") return value ? 1 : 0;
    return 0;
  }

  /**
   * Helper: Convert value to boolean
   */
  protected toBoolean(value: unknown): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      return value !== "" && value !== "0" && value.toLowerCase() !== "false";
    }
    if (Array.isArray(value)) return value.length > 0;
    if (this.isObject(value)) {
      if ("nodeType" in value) return true; // DOM nodes are truthy
      return Object.keys(value).length > 0;
    }
    return value !== null && value !== undefined;
  }

  /**
   * Helper: Convert value to array
   */
  protected toArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined) return [];
    return [value];
  }
}

const nodeProtoKeys = new Set(Object.getOwnPropertyNames(Node.prototype));
