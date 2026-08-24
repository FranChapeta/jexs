import { Node, Context, NodeValue } from "@jexs/core";
import { resolve, resolveAll, runSteps, runStepsDetached } from "@jexs/core";
import {
  resolvePath, adjustPathAfterRemoval, getChildArrayKey,
  getChildGroups, describeNode, getEditMode, getTextContent, getPotentialChildKeys,
} from "../treeUtils.js";
import type { JexsNodeSchema } from "@jexs/core";
import { hydrate } from "../events.js";

/** Delta describes a single tree mutation */
export interface TreeDelta {
  /** insert/remove/set: the affected path. move: the SOURCE node path. */
  path: string;
  action: "insert" | "remove" | "set" | "move";
  value?: unknown;
  /** move: destination parent-list path (may differ from the source's parent). */
  toPath?: string;
  /** move: destination index within `toPath`. */
  to?: number;
}

/**
 * Per-tree runtime handles that can't live in serializable context — the DOM
 * target, the collapsed set, drag listeners, the row template, and the hook
 * steps. The tree DATA itself lives in the resolver context at `path`, so it is
 * readable with `{ "var": "$<path>" }` and written by the `tree-*` ops.
 *
 * The store is keyed by the context object (scoped per-Client, GC'd with the
 * context — no static registry to leak) then by the normalized context path.
 */
interface TreeRuntime {
  context: Context;             // the live resolver context that owns the data
  path: string;                 // normalized context dot-path to the data array
  target: HTMLElement;
  row: unknown;                 // JSON row template — resolved per node via the resolver
  selectedPath: string | null;
  collapsed: Set<string>;
  onChangeSteps: unknown[] | null;
  onSelectSteps: unknown[] | null;
}

const stores = new WeakMap<Context, Map<string, TreeRuntime>>();

function setRuntime(context: Context, path: string, rt: TreeRuntime): void {
  let byPath = stores.get(context);
  if (!byPath) { byPath = new Map(); stores.set(context, byPath); }
  byPath.set(path, rt);
}

// Note: tree ops are expected to run against the context that owns the tree
// (the client's single shared context). A derived context (e.g. inside a map)
// would not find the runtime — tree mutation belongs in event steps, not loops.
function getRuntime(context: Context, path: string): TreeRuntime | undefined {
  return stores.get(context)?.get(path);
}

/** Strip a single leading `$` so `$editor` and `editor` resolve to one key. */
function normalizePath(path: string): string {
  return path.charCodeAt(0) === 36 ? path.slice(1) : path;
}

/** Read a value at a normalized dot-path in the context. */
function readContextPath(context: Context, path: string): unknown {
  let cur: unknown = context;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** The live tree data array at the runtime's context path (never a copy). */
function getData(rt: TreeRuntime): unknown[] {
  const d = readContextPath(rt.context, rt.path);
  return Array.isArray(d) ? d : [];
}

/**
 * TreeNode — Client-side hierarchical JSON editor.
 *
 * Stores the tree data in the resolver context at a caller-supplied dot-path and
 * recursively renders it using a JSON row template resolved by the resolver. The
 * row template defines the full element for each node — no hardcoded HTML tags.
 * Children are placed into data-children="key" containers within the rendered
 * row element.
 *
 * Every op addresses its tree by the same context path it was initialized with:
 * - { "tree-init": "$editor", "target": "#el", "data": [], "row": {...}, "on-change": [], "on-select": [] }
 * - { "tree-render": "$editor", "path": "0.content" }         re-render (partial if path given)
 * - { "tree-insert": "$editor", "value": {...} }              into the selected node / root
 * - { "tree-remove": "$editor" }                              the selected node
 * - { "tree-update": "$editor", "key": "k", "value": "v" }    a key on the selected node
 * - { "tree-move": "$editor", "direction": "up"|"down" }      reorder the selected node
 * - { "tree-move": "$editor", "to": "2.content", "index": 0 } relocate to any list path
 * - { "tree-select": "$editor", "path": "0.content.1" }
 * - { "tree-toggle": "$editor", "path": "0" }
 * - { "tree-apply": "$editor", "delta": {...} }               replay a TreeDelta
 *
 * The data is plain context state: read it with `{ "var": "$editor" }`, replace it with
 * `setVars` + `tree-render`, and edit it with the array mutators (`push`/`remove`/`move`/…)
 * + `tree-render`. The ops above cover only the interactive, selection-aware editing that
 * needs the runtime (selection, collapse, DOM) — everything else is plain context work.
 */
export class TreeNode extends Node {
  static schema: JexsNodeSchema = {
    "tree-init": {
      type: "string",
      output: "null",
      markdownDescription: "Initializes a JSON tree editor. The primary key value is a context dot-path (`$editor`) where the tree data is stored, so you read it back with `{ \"var\": \"$editor\" }`. Also pass `target` (CSS selector), `data` (array; if omitted, adopts any array already at the path), and `row` (JSON template).\nThe `row` template is resolved per node with context vars: `path`, `type`, `summary`, `depth`, `selected`, `expanded`.\nHook `on-change` steps receive `$delta` and `$editorData`; `on-select` receives `$selectedPath` and `$selectedNode`.",
      examples: [
        "{ \"tree-init\": \"$editor\", \"target\": \"#editor\", \"data\": [], \"row\": { \"tag\": \"div\", \"content\": [{ \"var\": \"path\" }] }, \"on-change\": [] }",
      ],
      siblings: {
        target: {
          type: "string",
          description: "CSS selector of the container element.",
        },
        data: {
          description: "Initial data array or expression. If omitted, adopts any array already at the context path.",
        },
        row: {
          map: true,
          description: "JSON row template resolved per tree node.",
        },
        "on-change": {
          steps: true,
          description: "Steps run on each mutation with `$delta` and `$editorData`.",
        },
        "on-select": {
          steps: true,
          description: "Steps run on selection change with `$selectedPath` and `$selectedNode`.",
        },
      },
    },
    "tree-render": {
      type: "string",
      output: "null",
      markdownDescription: "Re-renders the tree at the given context path from its current data. Pass `path` for a **partial** render: a child-list path (e.g. `\"0.content\"`, where you `push`ed/`remove`d) re-renders just that list's items; a node path (e.g. `\"0.content.1\"`, whose data you changed) replaces that node and its subtree. Omit `path` for a full render. Call after editing the data with `setVars` or the array mutators (`push`/`remove`/`insert`/`move`/…), since there is no automatic reactivity.",
      examples: [
        "{ \"tree-render\": \"$editor\", \"path\": \"0.content\" }",
      ],
      siblings: {
        path: {
          type: "string",
          description: "Optional tree path to render partially (child-list path or node path). Omit for a full render.",
        },
      },
    },
    "tree-insert": {
      type: "string",
      markdownDescription: "Inserts a node into the tree at the given context path. If `path` is omitted, inserts as a\nchild of the selected node (if it is a container) or appends to the root array.",
      examples: [
        "{ \"tree-insert\": \"$editor\", \"value\": { \"tag\": \"p\", \"content\": [\"\"] } }",
      ],
      siblings: {
        value: {
          description: "Node to insert.",
        },
        path: {
          type: "string",
          description: "Optional dot-path of the insertion target (within the tree).",
        },
      },
    },
    "tree-remove": {
      type: "string",
      markdownDescription: "Removes the currently selected node from the tree at the given context path. Returns the removed node's `TreeDelta`.",
      examples: [
        "{ \"tree-remove\": \"$editor\" }",
      ],
    },
    "tree-update": {
      type: "string",
      markdownDescription: "Updates a single key on the currently selected node.\nSetting `value` to `null`, `undefined`, or `\"\"` deletes the key.",
      examples: [
        "{ \"tree-update\": \"$editor\", \"key\": \"class\", \"value\": { \"var\": \"$class\" } }",
      ],
      siblings: {
        key: {
          type: "string",
          description: "Key to update on the selected node.",
        },
        value: {
          description: "New value (null/undefined/\"\" deletes the key).",
        },
      },
    },
    "tree-move": {
      type: "string",
      markdownDescription: "Moves a node: either **reorder** the selected node among its siblings (`direction`) or **relocate** it to any list (`to`).",
      examples: [
        "{ \"tree-move\": \"$editor\", \"direction\": \"up\" }",
        "{ \"tree-move\": \"$editor\", \"to\": \"2.content\", \"index\": 0 }",
      ],
      variants: {
        direction: {
          type: "string",
          enum: [
            "up",
            "down",
          ],
          markdownDescription: "Reorder the selected node up or down among its siblings.",
        },
        to: {
          type: "string",
          markdownDescription: "Relocate a node into the list at this path (any list in the tree). Pair with `index` (position) and `from` (a non-selected source node).",
          siblings: {
            index: {
              type: "number",
              description: "Insertion index within `to` (default: append to the end).",
            },
            from: {
              type: "string",
              description: "Source node path to move (default: the currently selected node).",
            },
          },
        },
      },
    },
    "tree-select": {
      type: "string",
      markdownDescription: "Selects a node by path, firing `on-select` steps with `$selectedPath` and `$selectedNode`.\nPass `path: null` to deselect. Returns the selected node data.",
      examples: [
        "{ \"tree-select\": \"$editor\", \"path\": \"0.content.1\" }",
      ],
      siblings: {
        path: {
          type: "string",
          description: "Dot-path string to select, or `null` to deselect.",
        },
      },
    },
    "tree-toggle": {
      type: "string",
      output: "boolean",
      markdownDescription: "Toggles the collapsed/expanded state of a node at the given `path`. Returns `true` if now expanded.",
      examples: [
        "{ \"tree-toggle\": \"$editor\", \"path\": \"0\" }",
      ],
      siblings: {
        path: {
          type: "string",
          description: "Dot-path of the node to toggle.",
        },
      },
    },
    "tree-apply": {
      type: "string",
      output: "null",
      markdownDescription: "Applies a `TreeDelta` mutation (`insert` / `remove` / `set` / `move`) to the tree.\nUseful for replaying remote changes in collaborative editing scenarios.",
      examples: [
        "{ \"tree-apply\": \"$editor\", \"delta\": { \"var\": \"$delta\" } }",
      ],
      siblings: {
        delta: {
          description: "TreeDelta object to apply.",
        },
      },
    },
  };

  // ══════════════════════════════════════════════
  //  Data operations
  // ══════════════════════════════════════════════

  ["tree-init"](def: Record<string, unknown>, context: Context): NodeValue {
    // Extract row before resolution to prevent ElementNode from rendering it to HTML.
    const rawRow = def.row;

    return resolveAll([def["tree-init"], def.target, def.data ?? null], context, async ([pathRaw, target, data]) => {
      const targetEl = document.querySelector(String(target)) as HTMLElement;
      if (!targetEl) return null;

      const path = normalizePath(String(pathRaw ?? "default"));

      // Resolve the data array: use `data` if given, else adopt what's already at
      // the context path, else start empty. Then write it into the context so it
      // is readable via `{ "var": "$<path>" }` and mutated in place by later ops.
      let dataArr: unknown[] = [];
      if (data != null) {
        if (typeof data === "string") {
          try { dataArr = JSON.parse(data); } catch { dataArr = []; }
        } else if (Array.isArray(data)) {
          dataArr = data;
        } else {
          dataArr = [data];
        }
      } else {
        const existing = readContextPath(context, path);
        if (Array.isArray(existing)) dataArr = existing;
      }
      Node.setContextValue(context, path, dataArr);

      const rt: TreeRuntime = {
        context,
        path,
        target: targetEl,
        row: rawRow,
        selectedPath: null,
        collapsed: new Set(),
        onChangeSteps: Array.isArray(def["on-change"]) ? def["on-change"] : null,
        onSelectSteps: Array.isArray(def["on-select"]) ? def["on-select"] : null,
      };

      setRuntime(context, path, rt);
      await renderTree(rt);
      setupDrag(rt);
      return null;
    });
  }

  ["tree-render"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def["tree-render"], def.path ?? null], context, async ([pathRaw, path]) => {
      const rt = getRuntime(context, normalizePath(String(pathRaw)));
      if (!rt) return null;
      const p = path != null ? String(path) : "";
      if (!p) {
        await renderTree(rt);
      } else if (Array.isArray(resolvePath(getData(rt), p))) {
        // Path points at a child-list (e.g. "0.content") — re-render its items.
        await renderSubtree(rt, p);
      } else {
        // Path points at a node — replace it and its subtree in place.
        await renderNodeEl(rt, p);
      }
      return null;
    });
  }

  ["tree-insert"](def: Record<string, unknown>, context: Context): NodeValue {
    // Extract value before resolution to prevent ElementNode from rendering
    const rawValue = def.value;
    const isVarRef = this.isObject(rawValue) && "var" in rawValue;

    return resolveAll([def["tree-insert"], def.path ?? null], context, ([pathRaw, path]) => {
      const rt = getRuntime(context, normalizePath(String(pathRaw)));
      if (!rt) return null;

      const doInsert = async (valueResolved: unknown) => {
        let value = valueResolved;
        if (typeof value === "string") {
          try { value = JSON.parse(value); } catch { /* keep as string */ }
        }
        value = JSON.parse(JSON.stringify(value));
        const targetPath = path ? String(path) : null;
        const insertPath = targetPath ?? rt.selectedPath;
        let parentArrayPath: string;

        if (insertPath) {
          const parent = resolvePath(getData(rt), insertPath);
          if (this.isObject(parent)) {
            const childKey = getChildArrayKey(parent);
            if (childKey) {
              if (!Array.isArray(parent[childKey])) parent[childKey] = parent[childKey] != null ? [parent[childKey]] : [];
              (parent[childKey] as unknown[]).push(value);
              parentArrayPath = insertPath + "." + childKey;
            } else {
              getData(rt).push(value);
              parentArrayPath = "";
            }
          } else {
            getData(rt).push(value);
            parentArrayPath = "";
          }
        } else {
          getData(rt).push(value);
          parentArrayPath = "";
        }

        await renderSubtree(rt, parentArrayPath);
        const delta: TreeDelta = { path: parentArrayPath, action: "insert", value };
        fireChange(rt, delta);
        return delta;
      };

      return isVarRef ? resolve(rawValue, context, doInsert) : doInsert(rawValue);
    });
  }

  ["tree-remove"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["tree-remove"], context, async pathRaw => {
      const rt = getRuntime(context, normalizePath(String(pathRaw)));
      if (!rt || !rt.selectedPath) return null;

      const parts = rt.selectedPath.split(".");
      const index = parseInt(parts[parts.length - 1]);
      if (isNaN(index)) return null;

      const parentPath = parts.slice(0, -1).join(".");
      const parent = parentPath ? resolvePath(getData(rt), parentPath) : getData(rt);
      if (!Array.isArray(parent) || index < 0 || index >= parent.length) return null;

      parent.splice(index, 1);
      const removedPath = rt.selectedPath;
      rt.selectedPath = null;

      await renderSubtree(rt, parentPath);
      await fireSelect(rt);

      const delta: TreeDelta = { path: removedPath, action: "remove" };
      fireChange(rt, delta);
      return delta;
    });
  }

  ["tree-update"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def["tree-update"], def.key, def.value ?? null], context, async ([pathRaw, key, value]) => {
      const rt = getRuntime(context, normalizePath(String(pathRaw)));
      if (!rt || !rt.selectedPath) return null;

      const node = resolvePath(getData(rt), rt.selectedPath);
      if (!this.isObject(node)) return null;

      const k = String(key);

      if (value === null || value === undefined || value === "") {
        delete node[k];
      } else {
        node[k] = value;
      }

      await renderNodeEl(rt, rt.selectedPath);

      const delta: TreeDelta = { path: rt.selectedPath + "." + k, action: "set", value };
      fireChange(rt, delta);
      return delta;
    });
  }

  ["tree-move"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll(
      [def["tree-move"], def.direction ?? null, def.to ?? null, def.index ?? null, def.from ?? null],
      context,
      async ([pathRaw, direction, to, index, from]) => {
        const rt = getRuntime(context, normalizePath(String(pathRaw)));
        if (!rt) return null;

        // Relocation: move a node to any parent-list path (+ index; default append).
        if (to != null) {
          const sourcePath = from != null ? String(from) : rt.selectedPath;
          if (!sourcePath) return null;
          const toParent = String(to);
          const toArr = resolvePath(getData(rt), toParent);
          const toIndex = index != null ? this.toNumber(index) : (Array.isArray(toArr) ? toArr.length : 0);
          return moveNodeTo(rt, sourcePath, toParent, toIndex);
        }

        // Reorder: shift the selected node up/down among its siblings.
        if (!rt.selectedPath) return null;
        const dir = String(direction);
        const parts = rt.selectedPath.split(".");
        const idx = parseInt(parts[parts.length - 1]);
        if (isNaN(idx)) return null;

        const parentPath = parts.slice(0, -1).join(".");
        const parent = parentPath ? resolvePath(getData(rt), parentPath) : getData(rt);
        if (!Array.isArray(parent)) return null;

        const newIndex = dir === "up" ? idx - 1 : idx + 1;
        if (newIndex < 0 || newIndex >= parent.length) return null;

        const sourcePath = rt.selectedPath;
        const item = parent.splice(idx, 1)[0];
        parent.splice(newIndex, 0, item);

        parts[parts.length - 1] = String(newIndex);
        rt.selectedPath = parts.join(".");

        await renderSubtree(rt, parentPath);

        const delta: TreeDelta = { path: sourcePath, action: "move", toPath: parentPath, to: newIndex, value: item };
        fireChange(rt, delta);
        return delta;
      },
    );
  }

  ["tree-select"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def["tree-select"], def.path ?? null], context, async ([pathRaw, path]) => {
      const rt = getRuntime(context, normalizePath(String(pathRaw)));
      if (!rt) return null;

      const oldPath = rt.selectedPath;
      rt.selectedPath = path != null ? String(path) : null;

      // Toggle CSS class without re-rendering
      if (oldPath) {
        const oldEl = findNode(rt, oldPath);
        if (oldEl) oldEl.classList.remove("selected");
      }
      if (rt.selectedPath) {
        const newEl = findNode(rt, rt.selectedPath);
        if (newEl) newEl.classList.add("selected");
      }

      await fireSelect(rt);
      return rt.selectedPath ? resolvePath(getData(rt), rt.selectedPath) : null;
    });
  }

  ["tree-toggle"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def["tree-toggle"], def.path], context, async ([pathRaw, path]) => {
      const rt = getRuntime(context, normalizePath(String(pathRaw)));
      if (!rt) return null;

      const p = String(path);
      if (rt.collapsed.has(p)) {
        rt.collapsed.delete(p);
      } else {
        rt.collapsed.add(p);
      }

      await renderNodeEl(rt, p);
      return !rt.collapsed.has(p);
    });
  }

  ["tree-apply"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def["tree-apply"], def.delta], context, async ([pathRaw, delta]) => {
      const rt = getRuntime(context, normalizePath(String(pathRaw)));
      if (!rt) return null;

      const d = delta as TreeDelta;
      if (!d || !d.action) return null;

      switch (d.action) {
        case "insert": {
          const arr = d.path ? resolvePath(getData(rt), d.path) : getData(rt);
          if (Array.isArray(arr)) {
            arr.push(JSON.parse(JSON.stringify(d.value)));
            await renderSubtree(rt, d.path);
          }
          break;
        }
        case "remove": {
          const parts = d.path.split(".");
          const index = parseInt(parts[parts.length - 1]);
          const parentPath = parts.slice(0, -1).join(".");
          const parent = parentPath ? resolvePath(getData(rt), parentPath) : getData(rt);
          if (Array.isArray(parent) && !isNaN(index)) {
            parent.splice(index, 1);
            if (rt.selectedPath?.startsWith(d.path)) rt.selectedPath = null;
            await renderSubtree(rt, parentPath);
          }
          break;
        }
        case "set": {
          const parts = d.path.split(".");
          const key = parts.pop()!;
          const nodePath = parts.join(".");
          const node = nodePath ? resolvePath(getData(rt), nodePath) : null;
          if (this.isObject(node)) {
            node[key] = d.value;
            await renderNodeEl(rt, nodePath);
          }
          break;
        }
        case "move": {
          // Remove the node at the source path, insert it into `toPath` at `to`.
          const srcParts = d.path.split(".");
          const srcIdx = parseInt(srcParts[srcParts.length - 1]);
          const srcParent = srcParts.slice(0, -1).join(".");
          const srcArr = srcParent ? resolvePath(getData(rt), srcParent) : getData(rt);
          if (!Array.isArray(srcArr) || isNaN(srcIdx) || srcIdx < 0 || srcIdx >= srcArr.length) break;
          const [node] = srcArr.splice(srcIdx, 1);
          const dstArr = d.toPath ? resolvePath(getData(rt), d.toPath) : getData(rt);
          if (Array.isArray(dstArr)) {
            const at = d.to != null ? Math.max(0, Math.min(d.to, dstArr.length)) : dstArr.length;
            dstArr.splice(at, 0, node);
          }
          await renderTree(rt);
          break;
        }
      }

      return null;
    });
  }

}

// ══════════════════════════════════════════════
//  Rendering — element-agnostic, uses resolver + JSON row template
// ══════════════════════════════════════════════

/** Full render of the entire tree */
async function renderTree(rt: TreeRuntime): Promise<void> {
  rt.target.innerHTML = "";

  const data = getData(rt);
  for (let i = 0; i < data.length; i++) {
    const el = await buildNodeEl(rt, data[i], String(i), 0);
    if (el) rt.target.appendChild(el);
  }

  hydrate(rt.target, rt.context);
}

/**
 * Build a DOM element for one tree node by resolving the row template.
 * Children are recursively rendered into data-children="key" containers.
 */
async function buildNodeEl(
  rt: TreeRuntime, node: unknown, path: string, depth: number,
): Promise<HTMLElement | null> {
  const { type, summary, color } = describeNode(node);
  const groups = getChildGroups(node);
  const hasChildren = groups.some(g => g.items.length > 0);
  const expanded = !rt.collapsed.has(path);
  const selected = path === rt.selectedPath;
  const childKeys = groups.map(g => g.key);

  const editMode = getEditMode(node);
  const isContainer = editMode === "children" || editMode === "list";
  const expandable = editMode !== "none" && editMode !== "string";
  const textContent = getTextContent(node);

  const isString = typeof node === "string";

  // Include potential child keys for expandable nodes (so drop zones render even when empty)
  const allChildKeys = [...childKeys];
  if (expandable) {
    for (const k of getPotentialChildKeys(node)) {
      if (!allChildKeys.includes(k)) allChildKeys.push(k);
    }
  }

  const ctx: Context = {
    ...rt.context,
    treeNode: node,
    path, type, summary, color,
    depth, hasChildren, expanded, selected,
    childKeys: allChildKeys,
    editMode, isContainer, expandable, textContent,
    showHeader: !expanded || !expandable,
    isString,
  };

  const rowHtml = String(await resolve(rt.row, ctx) ?? "");

  // Parse row HTML — use <template> to avoid side effects (no img loads, no script eval)
  const tpl = document.createElement("template");
  tpl.innerHTML = rowHtml;
  const el = tpl.content.firstElementChild as HTMLElement;
  if (!el) return null;

  // TreeNode owns structural data attributes — templates don't need to set these
  el.setAttribute("data-path", path);
  el.setAttribute("data-type", type);
  if (isString) el.setAttribute("data-string", "true");
  if (editMode) el.setAttribute("data-edit-mode", editMode);

  // Store render-time context so event handlers can access $path, $type, etc.
  // without DOM traversal (closest + getAttr boilerplate)
  el.setAttribute("data-jexs-tree-ctx", JSON.stringify({
    path, type, editMode, depth,
  }));

  if (selected) el.classList.add("selected");

  // Render children into template-provided [data-children="key"] containers.
  // The template controls where children go — TreeNode just fills them in.
  if (expanded) {
    for (const { key, items } of groups) {
      if (items.length === 0) continue;
      const container = el.querySelector(`[data-children="${key}"]`) as HTMLElement;
      if (!container) continue;
      for (let i = 0; i < items.length; i++) {
        const childPath = `${path}.${key}.${i}`;
        const childEl = await buildNodeEl(rt, items[i], childPath, depth + 1);
        if (childEl) container.appendChild(childEl);
      }
    }
  }

  return el;
}

/** Re-render the children inside a parent's data-children container */
async function renderSubtree(rt: TreeRuntime, parentPath: string): Promise<void> {
  if (!parentPath) {
    await renderTree(rt);
    return;
  }

  // parentPath is like "0.content" — split into nodePath + key
  const parts = parentPath.split(".");
  const key = parts.pop()!;
  const nodePath = parts.join(".");

  // Find the node element in the DOM
  const nodeEl = nodePath ? findNode(rt, nodePath) : rt.target;
  if (!nodeEl) {
    await renderTree(rt);
    return;
  }

  // Find the children container
  const container = key
    ? (nodeEl.querySelector(`[data-children="${key}"]`) as HTMLElement)
    : nodeEl;
  if (!container) return;

  container.innerHTML = "";

  // Get the data array at parentPath
  const dataArray = resolvePath(getData(rt), parentPath);
  if (!Array.isArray(dataArray)) return;

  const depth = nodePath
    ? nodePath.split(".").filter(p => /^\d+$/.test(p)).length
    : 0;

  for (let i = 0; i < dataArray.length; i++) {
    const childPath = `${parentPath}.${i}`;
    const el = await buildNodeEl(rt, dataArray[i], childPath, depth);
    if (el) container.appendChild(el);
  }

  hydrate(container, rt.context);
}

/** Re-render a single node element (replace in-place) */
async function renderNodeEl(rt: TreeRuntime, path: string): Promise<void> {
  const oldEl = findNode(rt, path);
  if (!oldEl) return;

  const node = resolvePath(getData(rt), path);
  const depth = path.split(".").filter(p => /^\d+$/.test(p)).length - 1;

  const newEl = await buildNodeEl(rt, node, path, Math.max(0, depth));
  if (!newEl) return;

  oldEl.replaceWith(newEl);
  hydrate(newEl, rt.context);
}

// ══════════════════════════════════════════════
//  DOM traversal — follows path through child elements
//  and data-children containers, element-agnostic
// ══════════════════════════════════════════════

/**
 * Find the DOM element for a tree path.
 * Path format: "0.content.2.then.0"
 *   - numeric parts → nth child element of the current container
 *   - key parts → querySelector("[data-children=key]")
 */
function findNode(rt: TreeRuntime, path: string): HTMLElement | null {
  const parts = path.split(".");
  let current: HTMLElement = rt.target;
  let i = 0;

  while (i < parts.length) {
    const idx = parseInt(parts[i]);
    if (isNaN(idx)) return null;

    const children = Array.from(current.children) as HTMLElement[];
    if (idx >= children.length) return null;
    current = children[idx];
    i++;

    if (i >= parts.length) return current;

    // Key part — find data-children container
    const key = parts[i];
    const container = current.querySelector(`[data-children="${key}"]`) as HTMLElement;
    if (!container) return null;
    current = container;
    i++;
  }

  return null;
}

// ══════════════════════════════════════════════
//  Callbacks
// ══════════════════════════════════════════════

function fireChange(rt: TreeRuntime, delta: TreeDelta): void {
  if (!rt.onChangeSteps) return;
  runStepsDetached(rt.onChangeSteps, {
    ...rt.context,
    delta,
    editorData: JSON.stringify(getData(rt), null, 2),
  }).catch(err => console.error("[TreeNode] onChange error:", err));
}

function fireSelect(rt: TreeRuntime): unknown {
  if (!rt.onSelectSteps) return;
  const node = rt.selectedPath ? resolvePath(getData(rt), rt.selectedPath) : null;
  return runSteps(rt.onSelectSteps, {
    ...rt.context,
    selectedPath: rt.selectedPath,
    selectedNode: node,
    selectedEditMode: node ? getEditMode(node) : null,
  });
}

// ══════════════════════════════════════════════
//  Drag & Drop — event delegation on tree target
// ══════════════════════════════════════════════

function setupDrag(rt: TreeRuntime): void {
  const target = rt.target;
  if (target.hasAttribute("data-tree-drag")) return;
  target.setAttribute("data-tree-drag", "");

  let sourceEl: HTMLElement | null = null;
  let sourcePath: string | null = null;

  const clearIndicators = () => {
    target.querySelectorAll(".drop-before").forEach(el => el.classList.remove("drop-before"));
    target.querySelectorAll(".drop-after").forEach(el => el.classList.remove("drop-after"));
    target.querySelectorAll(".drop-target").forEach(el => el.classList.remove("drop-target"));
  };

  const getDropInfo = (e: DragEvent): {
    parentPath: string; index: number; container: HTMLElement; isInto: boolean; listOnly: boolean; textOnly: boolean;
  } | null => {
    const pt = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement;
    if (!pt || !target.contains(pt)) return null;

    const wrapper = pt.closest("[data-path]") as HTMLElement;
    if (!wrapper || !target.contains(wrapper)) {
      return { parentPath: "", index: getData(rt).length, container: target, isInto: false, listOnly: false, textOnly: false };
    }

    const wrapperPath = wrapper.getAttribute("data-path")!;
    if (wrapperPath === sourcePath) return null;

    const rect = wrapper.getBoundingClientRect();
    const ratio = (e.clientY - rect.top) / rect.height;

    const parts = wrapperPath.split(".");
    const idx = parseInt(parts[parts.length - 1]);
    const parentPath = parts.slice(0, -1).join(".");
    const parentContainer = wrapper.parentElement!;

    // Check if element can have children
    const nodeData = resolvePath(getData(rt), wrapperPath);
    const editMode = getEditMode(nodeData);
    const isContainer = editMode === "children" || editMode === "list";
    const isTextContainer = editMode === "text" || editMode === "textarea";

    if ((isContainer || isTextContainer) && ratio > 0.25 && ratio < 0.75) {
      const childKey = nodeData && typeof nodeData === "object" && !Array.isArray(nodeData)
        ? getChildArrayKey(nodeData as Record<string, unknown>) ?? "content"
        : "content";
      const childContainer = wrapper.querySelector(`[data-children="${childKey}"]`) as HTMLElement;
      const arr = resolvePath(getData(rt), wrapperPath + "." + childKey);
      return {
        parentPath: wrapperPath + "." + childKey,
        index: Array.isArray(arr) ? arr.length : 0,
        container: childContainer || wrapper,
        isInto: true,
        listOnly: editMode === "list",
        textOnly: isTextContainer,
      };
    } else if (ratio < 0.5) {
      return { parentPath, index: idx, container: parentContainer, isInto: false, listOnly: false, textOnly: false };
    } else {
      return { parentPath, index: idx + 1, container: parentContainer, isInto: false, listOnly: false, textOnly: false };
    }
  };

  // Set draggable dynamically — only on left-click, skip inputs
  target.addEventListener("mousedown", (e: MouseEvent) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (!t || typeof t.closest !== "function") return;
    if (t.closest("input, textarea")) return;
    const wrapper = t.closest("[data-path]") as HTMLElement;
    if (wrapper) {
      wrapper.draggable = true;
      const cleanup = () => { wrapper.draggable = false; };
      window.addEventListener("mouseup", cleanup, { once: true });
      window.addEventListener("dragend", cleanup, { once: true });
    }
  }, true);

  target.addEventListener("dragstart", (e: DragEvent) => {
    const wrapper = (e.target as HTMLElement).closest("[data-path]") as HTMLElement;
    if (!wrapper?.draggable) return;
    sourceEl = wrapper;
    sourcePath = wrapper.getAttribute("data-path")!;
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("text/plain", sourcePath);
    requestAnimationFrame(() => {
      if (sourceEl) {
        sourceEl.style.opacity = "0.4";
        sourceEl.style.pointerEvents = "none";
      }
    });
  });

  target.addEventListener("dragover", (e: DragEvent) => {
    if (!sourcePath) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    clearIndicators();

    const info = getDropInfo(e);
    if (!info) return;

    // Don't allow dropping into self or descendants
    if (info.parentPath === sourcePath || info.parentPath.startsWith(sourcePath + ".")) return;

    // List-only validation: ul/ol only accept li children
    if (info.listOnly) {
      const sourceNode = resolvePath(getData(rt), sourcePath);
      const isLi = sourceNode && typeof sourceNode === "object" && !Array.isArray(sourceNode)
        && "tag" in (sourceNode as Record<string, unknown>)
        && String((sourceNode as Record<string, unknown>).tag).toLowerCase() === "li";
      if (!isLi) return;
    }

    // Text-only validation: text/textarea elements reject layout containers and lists
    if (info.textOnly) {
      const sourceNode = resolvePath(getData(rt), sourcePath);
      const sourceMode = getEditMode(sourceNode);
      if (sourceMode === "children" || sourceMode === "list") return;
    }

    if (info.isInto) {
      info.container.classList.add("drop-target");
    } else {
      const children = Array.from(info.container.children).filter(
        c => (c as HTMLElement).hasAttribute("data-path"),
      ) as HTMLElement[];
      if (info.index < children.length) {
        children[info.index].classList.add("drop-before");
      } else if (children.length > 0) {
        children[children.length - 1].classList.add("drop-after");
      } else {
        info.container.classList.add("drop-target");
      }
    }
  });

  target.addEventListener("dragend", () => {
    if (sourceEl) {
      sourceEl.style.opacity = "";
      sourceEl.style.pointerEvents = "";
    }
    clearIndicators();
    sourceEl = null;
    sourcePath = null;
  });

  target.addEventListener("drop", async (e: DragEvent) => {
    e.preventDefault();
    const fromPath = sourcePath;
    if (!fromPath) return;

    if (sourceEl) {
      sourceEl.style.opacity = "";
      sourceEl.style.pointerEvents = "";
    }
    clearIndicators();
    sourceEl = null;
    sourcePath = null;

    const info = getDropInfo(e);
    if (!info) return;
    if (info.parentPath === fromPath || info.parentPath.startsWith(fromPath + ".")) return;

    // List-only validation on drop too
    if (info.listOnly) {
      const sourceNode = resolvePath(getData(rt), fromPath);
      const isLi = sourceNode && typeof sourceNode === "object" && !Array.isArray(sourceNode)
        && "tag" in (sourceNode as Record<string, unknown>)
        && String((sourceNode as Record<string, unknown>).tag).toLowerCase() === "li";
      if (!isLi) return;
    }

    // Text-only validation on drop too
    if (info.textOnly) {
      const sourceNode = resolvePath(getData(rt), fromPath);
      const sourceMode = getEditMode(sourceNode);
      if (sourceMode === "children" || sourceMode === "list") return;
    }

    await moveNodeTo(rt, fromPath, info.parentPath, info.index);
  });
}

/**
 * Move a node from one path to another (any parent, any index). Returns the
 * replayable move delta, or `null` if the move couldn't be performed. Pass
 * `fire: false` to suppress the `on-change` hook (used when replaying a delta).
 */
async function moveNodeTo(
  rt: TreeRuntime, fromPath: string, toParentPath: string, toIndex: number, fire = true,
): Promise<TreeDelta | null> {
  const sourceNode = resolvePath(getData(rt), fromPath);
  if (sourceNode === undefined) return null;
  const copy = JSON.parse(JSON.stringify(sourceNode));

  // Parse source location
  const fromParts = fromPath.split(".");
  const fromIdx = parseInt(fromParts[fromParts.length - 1]);
  const fromParent = fromParts.slice(0, -1).join(".");
  if (isNaN(fromIdx)) return null;

  const fromArr = (fromParent ? resolvePath(getData(rt), fromParent) : getData(rt)) as unknown[];
  if (!Array.isArray(fromArr)) return null;

  // Remove source
  fromArr.splice(fromIdx, 1);

  // Adjust target path after removal
  const adjParent = adjustPathAfterRemoval(toParentPath, fromPath);
  let adjIndex = toIndex;
  if (fromParent === adjParent && fromIdx < toIndex) adjIndex--;

  // Get or create target array
  let toArr = (adjParent ? resolvePath(getData(rt), adjParent) : getData(rt)) as unknown[];
  if (!Array.isArray(toArr)) {
    const pp = adjParent.split(".");
    const key = pp.pop()!;
    const nodePath = pp.join(".");
    const node = nodePath ? resolvePath(getData(rt), nodePath) : null;
    if (node && typeof node === "object" && !Array.isArray(node)) {
      (node as Record<string, unknown>)[key] = [];
      toArr = (node as Record<string, unknown>)[key] as unknown[];
    } else return null;
  }

  adjIndex = Math.max(0, Math.min(adjIndex, toArr.length));
  toArr.splice(adjIndex, 0, copy);

  rt.selectedPath = adjParent ? `${adjParent}.${adjIndex}` : String(adjIndex);

  await renderTree(rt);

  // The delta is self-contained and replayable: remove `path`, insert into
  // `toPath` at `to` (already adjusted for the removal).
  const delta: TreeDelta = { path: fromPath, action: "move", toPath: adjParent, to: adjIndex, value: copy };
  if (fire) fireChange(rt, delta);
  return delta;
}

// Pure utility functions imported from ./treeUtils.ts
