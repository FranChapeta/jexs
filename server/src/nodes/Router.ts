import { Node, Context, NodeValue, resolve } from "@jexs/core";

/**
 * Route handler structure
 */
interface RouteHandler {
  file?: string;
  run?: unknown[];
  params?: Record<string, unknown>;
  body?: Record<string, unknown>;
  options?: Record<string, unknown>;
}

/**
 * Route node structure
 */
interface RouteNode {
  paramName?: string;
  paramRegex?: string;
  methods?: Record<string, RouteHandler>;
  children?: Record<string, RouteNode>;
  if?: unknown;
  else?: unknown;
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value !== "" && value !== "0" && value.toLowerCase() !== "false";
  return value !== null && value !== undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const regexCache = new Map<string, RegExp>();
function getCachedRegex(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    re = new RegExp(`^${pattern}$`);
    regexCache.set(pattern, re);
  }
  return re;
}

/**
 * RouterNode - Handles route matching and execution.
 *
 * Matches when definition has "routes" key:
 * {
 *   "routes": {
 *     "login": { "methods": { "GET": { "file": "..." } } },
 *     "*": { "paramName": "id", "methods": { ... } }
 *   }
 * }
 *
 * Uses request path and method from context to find matching route,
 * then executes the handler's run steps.
 */
export class RouterNode extends Node {
  /**
   * Matches the incoming request path and method against a route tree, then executes the handler.
   * Supports exact segments, `*` (single param with optional `paramName`/`paramRegex`),
   * `**` (catch-all), conditional `"if"` guards per node, param/body validation, and WebSocket upgrade.
   *
   * @example
   * { "routes": { "children": { "users": { "methods": { "GET": { "file": "pages/users.json" } } } } } }
   */
  routes(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.routes, context, async rootNode => {
      if (!isObject(rootNode)) {
        console.error("[RouterNode] Invalid routes definition");
        return null;
      }

      // Get request info from context
      const method = context.request?.method?.toUpperCase() ?? "GET";
      const path = context.request?.path ?? "/";

      // Match route (conditions evaluated during traversal, params set on context)
      const handler = await matchRoute(
        rootNode as RouteNode,
        path,
        method,
        context,
      );

      if (!handler) {
        return { type: "notFound" };
      }

      // Execute handler
      return executeHandler(handler, context);
    });
  }
}

/**
 * Match route against path starting from root node.
 * Conditions are evaluated during traversal, params set on context.
 */
async function matchRoute(
  root: RouteNode,
  urlPath: string,
  method: string,
  context: Context,
): Promise<RouteHandler | null> {
  const segments = urlPath.split("/").filter(Boolean);

  // If path is "/" (no segments), check root methods
  if (segments.length === 0) {
    if (await checkConditionFails(root, context)) return null;
    return root.methods?.[method] ?? null;
  }

  // Match segments starting from root's children
  if (root.children) {
    return matchSegments(root.children, segments, 0, method, context);
  }

  return null;
}

/**
 * Recursively match segments against children
 */
async function matchSegments(
  children: Record<string, RouteNode>,
  segments: string[],
  index: number,
  method: string,
  context: Context,
): Promise<RouteHandler | null> {
  const segment = segments[index];

  // 1. Try exact match
  if (segment in children) {
    const node = children[segment];
    const result = await matchNode(node, segments, index, method, context);
    if (result) return result;
  }

  // 2. Try * (single param)
  if ("*" in children) {
    const node = children["*"];

    // Check regex constraint
    if (node.paramRegex) {
      const regex = getCachedRegex(node.paramRegex);
      if (!regex.test(segment)) {
        return tryCatchAll(children, segments, index, method, context);
      }
    }

    // Capture param on context
    if (node.paramName) {
      context[node.paramName] = segment;
    }

    const result = await matchNode(node, segments, index, method, context);
    if (result) return result;
  }

  // 3. Try ** (catch-all)
  return tryCatchAll(children, segments, index, method, context);
}

/**
 * Try to match catch-all route
 */
async function tryCatchAll(
  children: Record<string, RouteNode>,
  segments: string[],
  index: number,
  method: string,
  context: Context,
): Promise<RouteHandler | null> {
  if ("**" in children) {
    const node = children["**"];

    // Capture rest of path
    if (node.paramName) {
      context[node.paramName] = segments.slice(index).join("/");
    }

    if (await checkConditionFails(node, context)) return null;
    return node.methods?.[method] ?? null;
  }

  return null;
}

/**
 * Match a specific node (after segment matched).
 * Evaluates "if" condition before proceeding — stops early on failure.
 */
async function matchNode(
  node: RouteNode,
  segments: string[],
  index: number,
  method: string,
  context: Context,
): Promise<RouteHandler | null> {
  if (await checkConditionFails(node, context)) return null;

  const nextIndex = index + 1;
  const isLast = nextIndex >= segments.length;

  if (isLast) {
    return node.methods?.[method] ?? null;
  }

  if (node.children) {
    return matchSegments(
      node.children,
      segments,
      nextIndex,
      method,
      context,
    );
  }

  return null;
}

/**
 * Returns true if the node has an "if" condition that evaluates to false.
 */
function checkConditionFails(node: RouteNode, context: Context): unknown {
  if (!node.if) return false;
  return resolve(node.if, context, result => !toBoolean(result));
}

/**
 * Execute route handler
 */
async function executeHandler(
  handler: RouteHandler,
  context: Context,
): Promise<unknown> {
  // WebSocket handler: return definition for Server to complete the upgrade
  if ("on-connect" in handler || "on-message" in handler || "on-close" in handler) {
    return { type: "ws", handler, context };
  }

  // CSRF validation for state-changing methods (only when session exists)
  const CSRF_SAFE_METHODS = ["GET", "HEAD", "OPTIONS", "WS"];
  const reqMethod = context.request?.method?.toUpperCase() ?? "GET";
  const sessionToken = (context.session as Record<string, unknown> | undefined)?._csrf;
  if (!CSRF_SAFE_METHODS.includes(reqMethod) && sessionToken) {
    const submittedToken =
      (context.request?.body as Record<string, unknown> | undefined)?._csrf ??
      (context.request?.headers as Record<string, string | undefined> | undefined)?.["x-csrf-token"];
    if (!submittedToken || sessionToken !== submittedToken) {
      return { type: "error", status: 403, content: "CSRF token mismatch" };
    }
  }

  // Validate URL params
  if (handler.params) {
    const validation = validateSchema(handler.params, context as unknown as Record<string, unknown>, "param");
    if (validation) return validation;
  }

  // Validate body parameters
  if (handler.body) {
    const validation = validateSchema(handler.body, context.request?.body as Record<string, unknown> ?? {}, "field");
    if (validation) return validation;
  }

  // Execute run steps
  let lastResult: unknown = null;
  if (handler.run && Array.isArray(handler.run)) {
    for (const step of handler.run) {
      const result = await resolve(step, context);

      // Check for early return (response, redirect, error)
      if (isResponse(result)) {
        return result;
      }

      // If step has "as", store result in context (supports dot notation)
      if (isObject(step) && "as" in step) {
        Node.setContextValue(context, String(step.as), result);
      }

      if (result !== null && result !== undefined) {
        lastResult = result;
      }
    }
  }

  // Resolve file template through the resolver (FileNode + ElementNode)
  if (handler.file) {
    const rendered = await resolve(handler, context);
    if (typeof rendered === "string") {
      return { type: "html", content: rendered };
    }
    return rendered;
  }

  // If run steps produced a string, wrap as HTML response
  if (typeof lastResult === "string") {
    return { type: "html", content: lastResult };
  }

  return lastResult;
}

/**
 * Validate values against a schema (used for both params and body).
 * Returns an error response if validation fails, or null if valid.
 */
function validateSchema(
  schema: Record<string, unknown>,
  source: Record<string, unknown>,
  label: string,
): Record<string, unknown> | null {
  for (const [field, def] of Object.entries(schema)) {
    const fieldDef = isObject(def)
      ? (def as Record<string, unknown>)
      : { type: "string" };
    const raw = source[field];

    // Required check
    if (
      fieldDef.required &&
      (raw === undefined || raw === null || raw === "")
    ) {
      return {
        type: "error",
        status: 400,
        content: `Missing required ${label}: ${field}`,
      };
    }

    // Type check (only if value is present)
    if (raw !== undefined && raw !== null && raw !== "") {
      const expectedType = String(fieldDef.type ?? "string");
      if (expectedType === "number" && isNaN(Number(raw))) {
        return {
          type: "error",
          status: 400,
          content: `${label} ${field} must be a number`,
        };
      }
    }
  }

  return null;
}

/**
 * Check if result is a response object
 */
function isResponse(value: unknown): boolean {
  if (!isObject(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    "type" in obj &&
    ["html", "json", "redirect", "error", "notFound"].includes(
      String(obj.type),
    )
  );
}
