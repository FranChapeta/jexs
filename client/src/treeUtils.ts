/**
 * Pure utility functions for TreeNode — no DOM, no resolver, no side effects.
 */

// ─── Path navigation ────────────────────────────────────────────────────────

/** Navigate into a JSON structure by dot-separated path */
export function resolvePath(root: unknown, path: string): unknown {
  if (!path) return root;
  let current: unknown = root;
  for (const part of path.split(".")) {
    if (current === null || current === undefined) return null;
    if (Array.isArray(current)) {
      current = current[parseInt(part)];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return null;
    }
  }
  return current;
}

/** Adjust a target path after an element has been removed from the tree */
export function adjustPathAfterRemoval(targetPath: string, removedPath: string): string {
  if (!targetPath) return targetPath;
  const rParts = removedPath.split(".");
  const rIdx = parseInt(rParts[rParts.length - 1]);
  const rParent = rParts.slice(0, -1);
  const tParts = targetPath.split(".");
  if (tParts.length >= rParts.length) {
    if (rParent.every((p, i) => tParts[i] === p)) {
      const segIdx = rParts.length - 1;
      const tIdx = parseInt(tParts[segIdx]);
      if (!isNaN(tIdx) && tIdx > rIdx) {
        tParts[segIdx] = String(tIdx - 1);
        return tParts.join(".");
      }
    }
  }
  return targetPath;
}

// ─── Child structure ────────────────────────────────────────────────────────

/** Get the key that holds child nodes for a given object */
export function getChildArrayKey(obj: Record<string, unknown>): string | null {
  if ("tag" in obj) return "content";
  if ("if" in obj) return "then";
  if ("foreach" in obj) return "do";
  return null;
}

/** Get child groups with their key names and items */
export function getChildGroups(node: unknown): { key: string; items: unknown[] }[] {
  if (!node || typeof node !== "object" || Array.isArray(node)) return [];
  const obj = node as Record<string, unknown>;
  const groups: { key: string; items: unknown[] }[] = [];

  if ("tag" in obj && Array.isArray(obj.content)) {
    groups.push({ key: "content", items: obj.content });
  }

  if ("if" in obj) {
    if (Array.isArray(obj.then)) {
      groups.push({ key: "then", items: obj.then });
    }
    if (Array.isArray(obj.else)) {
      groups.push({ key: "else", items: obj.else });
    }
  }

  if ("foreach" in obj) {
    if (Array.isArray(obj.do)) {
      groups.push({ key: "do", items: obj.do });
    }
  }

  return groups;
}

// ─── Node description ───────────────────────────────────────────────────────

/** Describe a JSON node for tree labels */
export function describeNode(node: unknown): { type: string; summary: string; color: string } {
  if (node === null || node === undefined) return { type: "null", summary: "", color: "#94a3b8" };
  if (typeof node === "string") return { type: "text", summary: node.length > 40 ? node.slice(0, 40) + "\u2026" : node, color: "#22c55e" };
  if (typeof node === "number") return { type: "number", summary: String(node), color: "#f59e0b" };
  if (typeof node === "boolean") return { type: "bool", summary: String(node), color: "#f59e0b" };
  if (Array.isArray(node)) return { type: "array", summary: `[${node.length}]`, color: "#94a3b8" };

  const obj = node as Record<string, unknown>;

  if ("tag" in obj) {
    const tag = String(obj.tag);
    const parts: string[] = [];
    if (obj.id) parts.push("#" + obj.id);
    if (obj.class) parts.push("." + String(obj.class).split(" ").slice(0, 2).join("."));
    return { type: tag, summary: parts.join(""), color: "#3b82f6" };
  }

  if ("if" in obj) return { type: "if/then/else", summary: "", color: "#a855f7" };
  if ("foreach" in obj) return { type: "foreach", summary: obj.as ? `$${obj.as}` : "", color: "#a855f7" };
  if ("switch" in obj) return { type: "switch", summary: "", color: "#a855f7" };

  if ("var" in obj) return { type: "var", summary: String(obj.var), color: "#f97316" };
  if ("as" in obj) {
    const mainKey = Object.keys(obj).find(k => k !== "as");
    return { type: `$${obj.as}`, summary: mainKey ? `\u2190 ${mainKey}` : "", color: "#f97316" };
  }

  for (const k of ["concat", "upper", "lower", "substring", "replace", "trim"]) {
    if (k in obj) return { type: k, summary: "", color: "#06b6d4" };
  }
  for (const k of ["add", "subtract", "multiply", "divide"]) {
    if (k in obj) return { type: k, summary: "", color: "#eab308" };
  }
  for (const k of ["map", "filter", "find", "sort", "length", "first"]) {
    if (k in obj) return { type: k, summary: "", color: "#ec4899" };
  }
  for (const k of ["show", "hide", "toggle", "addClass", "removeClass", "setText", "setHtml", "append", "getValue", "setValue"]) {
    if (k in obj) return { type: k, summary: "", color: "#14b8a6" };
  }

  if ("ws-connect" in obj) return { type: "ws-connect", summary: String(obj["ws-connect"]), color: "#8b5cf6" };
  if ("ws-send" in obj) return { type: "ws-send", summary: "", color: "#8b5cf6" };
  if ("ws-close" in obj) return { type: "ws-close", summary: "", color: "#8b5cf6" };

  if ("query" in obj) return { type: "query", summary: "", color: "#ef4444" };
  if ("file" in obj) return { type: "file", summary: String(obj.file), color: "#ef4444" };
  if ("cache" in obj) return { type: "cache", summary: String(obj.cache), color: "#ef4444" };
  if ("session" in obj) return { type: "session", summary: "", color: "#ef4444" };

  const keys = Object.keys(obj).slice(0, 3).join(", ");
  return { type: "object", summary: `{${keys}}`, color: "#94a3b8" };
}

// ─── Edit mode ──────────────────────────────────────────────────────────────

const LAYOUT_TAGS = new Set(["div", "section", "aside", "main", "header", "footer", "nav", "article", "form", "fieldset", "li", "td", "th", "tr", "table", "thead", "tbody", "tfoot", "details", "summary", "figure", "figcaption", "dl", "dd", "dt", "dialog"]);
const TEXT_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "span", "a", "label", "button", "strong", "em", "small", "code", "abbr", "cite", "q", "time", "mark", "sub", "sup", "legend", "caption", "option", "title"]);
const TEXTAREA_TAGS = new Set(["p", "pre", "blockquote"]);

/** Determine the editing mode for a tree node */
export function getEditMode(node: unknown): string {
  if (typeof node === "string") return "string";
  if (!node || typeof node !== "object" || Array.isArray(node)) return "none";
  const obj = node as Record<string, unknown>;
  if ("if" in obj) return "children";
  if ("foreach" in obj) return "children";
  if (!("tag" in obj)) return "none";
  const tag = String(obj.tag).toLowerCase();
  if (LAYOUT_TAGS.has(tag)) return "children";
  if (tag === "ul" || tag === "ol") return "list";
  if (TEXTAREA_TAGS.has(tag)) return "textarea";
  if (TEXT_TAGS.has(tag)) return "text";
  return "none";
}

/** Extract the first text string from a node's content array */
export function getTextContent(node: unknown): string {
  if (!node || typeof node !== "object" || Array.isArray(node)) return "";
  const obj = node as Record<string, unknown>;
  if (!Array.isArray(obj.content)) return "";
  const first = obj.content[0];
  return typeof first === "string" ? first : "";
}

/** Get child keys that a node could potentially have, even if empty */
export function getPotentialChildKeys(node: unknown): string[] {
  if (!node || typeof node !== "object" || Array.isArray(node)) return [];
  const obj = node as Record<string, unknown>;
  const keys: string[] = [];
  if ("tag" in obj) {
    const mode = getEditMode(node);
    if (mode !== "none") keys.push("content");
  }
  if ("if" in obj) { keys.push("then"); keys.push("else"); }
  if ("foreach" in obj) keys.push("do");
  return keys;
}
