import { Node, Context, NodeValue } from "@jexs/core";
import { resolve, runSteps } from "@jexs/core";
import {
  resolvePath, adjustPathAfterRemoval, getChildArrayKey,
  getChildGroups, describeNode, getEditMode, getTextContent, getPotentialChildKeys,
} from "./treeUtils.js";

let initEventsFn: ((root: HTMLElement) => void) | null = null;

export function setInitEvents(fn: (root: HTMLElement) => void): void {
  initEventsFn = fn;
}

/** Delta describes a single tree mutation */
export interface TreeDelta {
  path: string;
  action: "insert" | "remove" | "set" | "move";
  value?: unknown;
  from?: number;
  to?: number;
}

/** Per-instance state */
interface TreeInstance {
  data: unknown[];
  target: HTMLElement;
  row: unknown;               // JSON row template — resolved per node via the resolver
  selectedPath: string | null;
  collapsed: Set<string>;
  onChangeSteps: unknown[] | null;
  onSelectSteps: unknown[] | null;
  baseContext: Context;
}

/**
 * TreeNode — Client-side hierarchical JSON editor.
 *
 * Stores the actual JSON tree in memory and recursively renders it
 * using a JSON row template resolved by the resolver. The row template
 * defines the full element for each node — no hardcoded HTML tags.
 * Children are placed into data-children="key" containers within the
 * rendered row element.
 *
 * Operations:
 * - { "tree-init": { "id": "t", "target": "#el", "data": [], "row": {...} }, "on-change": [], "on-select": [] }
 * - { "tree-insert": { "tree": "t", "value": {...} } }
 * - { "tree-remove": "t" }
 * - { "tree-update": { "tree": "t", "key": "k", "value": "v" } }
 * - { "tree-move": { "tree": "t", "direction": "up"|"down" } }
 * - { "tree-select": { "tree": "t", "path": "0.content.1" } }
 * - { "tree-toggle": { "tree": "t", "path": "0" } }
 * - { "tree-data": "t" }
 * - { "tree-node": { "tree": "t" } }
 * - { "tree-apply": { "tree": "t", "delta": {...} } }
 * - { "tree-set-data": { "tree": "t", "data": [...] } }
 */
export class TreeNode extends Node {
  private static instances = new Map<string, TreeInstance>();

  // ══════════════════════════════════════════════
  //  Data operations
  // ══════════════════════════════════════════════

  /**
   * Initializes a JSON tree editor. Pass `id`, `target` (CSS selector), `data` (array), and `row` (JSON template).
   * The `row` template is resolved per node with context vars: `path`, `type`, `summary`, `depth`, `selected`, `expanded`.
   * Hook `on-change` steps receive `$delta` and `$editorData`; `on-select` receives `$selectedPath` and `$selectedNode`.
   * @example
   * { "tree-init": { "id": "t", "target": "#editor", "data": [], "row": { "tag": "div", "content": [{ "var": "path" }] } }, "on-change": [] }
   */
  ["tree-init"](def: Record<string, unknown>, context: Context): NodeValue {
    const rawInit = def["tree-init"];

    // Extract row before resolution to prevent ElementNode from rendering it to HTML.
    let rawRow: unknown = undefined;
    let configToResolve: unknown = rawInit;

    if (this.isObject(rawInit) && "row" in rawInit) {
      rawRow = rawInit.row;
      const copy: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rawInit)) {
        if (k !== "row") copy[k] = v;
      }
      configToResolve = copy;
    }

    return resolve(configToResolve, context, async r => {
      if (!this.isObject(r)) return null;

      const id = String(r.id ?? "default");
      const target = document.querySelector(String(r.target)) as HTMLElement;
      if (!target) return null;

      let data: unknown[] = [];
      if (r.data) {
        if (typeof r.data === "string") {
          try { data = JSON.parse(r.data); } catch { data = []; }
        } else if (Array.isArray(r.data)) {
          data = r.data;
        } else {
          data = [r.data];
        }
      }

      const inst: TreeInstance = {
        data,
        target,
        row: rawRow !== undefined ? rawRow : r.row,
        selectedPath: null,
        collapsed: new Set(),
        onChangeSteps: Array.isArray(def["on-change"]) ? def["on-change"] : null,
        onSelectSteps: Array.isArray(def["on-select"]) ? def["on-select"] : null,
        baseContext: { ...context },
      };

      TreeNode.instances.set(id, inst);
      await renderTree(inst);
      setupDrag(inst);
      return null;
    });
  }

  /**
   * Inserts a node into the tree. Pass `tree` (id) and `value`. If `path` is omitted, inserts as a
   * child of the selected node (if it is a container) or appends to the root array.
   * @example
   * { "tree-insert": { "tree": "t", "value": { "tag": "p", "content": [""] } } }
   */
  ["tree-insert"](def: Record<string, unknown>, context: Context): NodeValue {
    const rawInsert = def["tree-insert"];

    // Extract value before resolution to prevent ElementNode from rendering
    let rawValue: unknown = undefined;
    let configToResolve: unknown = rawInsert;

    if (this.isObject(rawInsert) && "value" in rawInsert) {
      rawValue = rawInsert.value;
      const copy: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rawInsert)) {
        if (k !== "value") copy[k] = v;
      }
      configToResolve = copy;
    }

    const isVarRef = this.isObject(rawValue) && "var" in rawValue;

    return resolve(configToResolve, context, r => {
      if (!this.isObject(r)) return null;
      const inst = TreeNode.instances.get(String(r.tree));
      if (!inst) return null;

      const doInsert = async (valueResolved: unknown) => {
        let value = valueResolved;
        if (typeof value === "string") {
          try { value = JSON.parse(value); } catch { /* keep as string */ }
        }
        value = JSON.parse(JSON.stringify(value));
        const targetPath = r.path ? String(r.path) : null;
        const insertPath = targetPath ?? inst.selectedPath;
        let parentArrayPath: string;

        if (insertPath) {
          const parent = resolvePath(inst.data, insertPath);
          if (this.isObject(parent)) {
            const childKey = getChildArrayKey(parent);
            if (childKey) {
              if (!Array.isArray(parent[childKey])) parent[childKey] = parent[childKey] != null ? [parent[childKey]] : [];
              (parent[childKey] as unknown[]).push(value);
              parentArrayPath = insertPath + "." + childKey;
            } else {
              inst.data.push(value);
              parentArrayPath = "";
            }
          } else {
            inst.data.push(value);
            parentArrayPath = "";
          }
        } else {
          inst.data.push(value);
          parentArrayPath = "";
        }

        await renderSubtree(inst, parentArrayPath);
        const delta: TreeDelta = { path: parentArrayPath, action: "insert", value };
        fireChange(inst, delta);
        return delta;
      };

      return isVarRef ? resolve(rawValue, context, doInsert) : doInsert(rawValue);
    });
  }

  /** Removes the currently selected node from the tree. Returns the removed node's `TreeDelta`. */
  ["tree-remove"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["tree-remove"], context, async id => {
      const inst = TreeNode.instances.get(String(id));
      if (!inst || !inst.selectedPath) return null;

      const parts = inst.selectedPath.split(".");
      const index = parseInt(parts[parts.length - 1]);
      if (isNaN(index)) return null;

      const parentPath = parts.slice(0, -1).join(".");
      const parent = parentPath ? resolvePath(inst.data, parentPath) : inst.data;
      if (!Array.isArray(parent) || index < 0 || index >= parent.length) return null;

      parent.splice(index, 1);
      const removedPath = inst.selectedPath;
      inst.selectedPath = null;

      await renderSubtree(inst, parentPath);
      await fireSelect(inst);

      const delta: TreeDelta = { path: removedPath, action: "remove" };
      fireChange(inst, delta);
      return delta;
    });
  }

  /**
   * Updates a single key on the currently selected node. Pass `{ tree, key, value }`.
   * Setting `value` to `null`, `undefined`, or `""` deletes the key.
   * @example
   * { "tree-update": { "tree": "t", "key": "class", "value": { "var": "$class" } } }
   */
  ["tree-update"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["tree-update"], context, async r => {
      if (!this.isObject(r)) return null;
      const inst = TreeNode.instances.get(String(r.tree));
      if (!inst || !inst.selectedPath) return null;

      const node = resolvePath(inst.data, inst.selectedPath);
      if (!this.isObject(node)) return null;

      const key = String(r.key);
      const value = r.value;

      if (value === null || value === undefined || value === "") {
        delete node[key];
      } else {
        node[key] = value;
      }

      await renderNodeEl(inst, inst.selectedPath);

      const delta: TreeDelta = { path: inst.selectedPath + "." + key, action: "set", value };
      fireChange(inst, delta);
      return delta;
    });
  }

  /**
   * Moves the currently selected node up or down within its sibling array.
   * Pass `{ tree, direction: "up" | "down" }`.
   * @example
   * { "tree-move": { "tree": "t", "direction": "up" } }
   */
  ["tree-move"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["tree-move"], context, async r => {
      if (!this.isObject(r)) return null;
      const inst = TreeNode.instances.get(String(r.tree));
      if (!inst || !inst.selectedPath) return null;

      const direction = String(r.direction);
      const parts = inst.selectedPath.split(".");
      const index = parseInt(parts[parts.length - 1]);
      if (isNaN(index)) return null;

      const parentPath = parts.slice(0, -1).join(".");
      const parent = parentPath ? resolvePath(inst.data, parentPath) : inst.data;
      if (!Array.isArray(parent)) return null;

      const newIndex = direction === "up" ? index - 1 : index + 1;
      if (newIndex < 0 || newIndex >= parent.length) return null;

      const item = parent.splice(index, 1)[0];
      parent.splice(newIndex, 0, item);

      parts[parts.length - 1] = String(newIndex);
      inst.selectedPath = parts.join(".");

      await renderSubtree(inst, parentPath);

      const delta: TreeDelta = { path: parentPath, action: "move", from: index, to: newIndex };
      fireChange(inst, delta);
      return delta;
    });
  }

  /**
   * Selects a node by path, firing `on-select` steps with `$selectedPath` and `$selectedNode`.
   * Pass `path: null` to deselect. Returns the selected node data.
   * @example
   * { "tree-select": { "tree": "t", "path": "0.content.1" } }
   */
  ["tree-select"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["tree-select"], context, async r => {
      if (!this.isObject(r)) return null;
      const inst = TreeNode.instances.get(String(r.tree));
      if (!inst) return null;

      const oldPath = inst.selectedPath;
      inst.selectedPath = r.path != null ? String(r.path) : null;

      // Toggle CSS class without re-rendering
      if (oldPath) {
        const oldEl = findNode(inst, oldPath);
        if (oldEl) oldEl.classList.remove("selected");
      }
      if (inst.selectedPath) {
        const newEl = findNode(inst, inst.selectedPath);
        if (newEl) newEl.classList.add("selected");
      }

      await fireSelect(inst);
      return inst.selectedPath ? resolvePath(inst.data, inst.selectedPath) : null;
    });
  }

  /** Toggles the collapsed/expanded state of a node at the given `path`. Returns `true` if now expanded. */
  ["tree-toggle"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["tree-toggle"], context, async r => {
      if (!this.isObject(r)) return null;
      const inst = TreeNode.instances.get(String(r.tree));
      if (!inst) return null;

      const path = String(r.path);
      if (inst.collapsed.has(path)) {
        inst.collapsed.delete(path);
      } else {
        inst.collapsed.add(path);
      }

      await renderNodeEl(inst, path);
      return !inst.collapsed.has(path);
    });
  }

  /** Returns the current tree data as a pretty-printed JSON string. */
  ["tree-data"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["tree-data"], context, id => {
      const inst = TreeNode.instances.get(String(id));
      if (!inst) return null;
      return JSON.stringify(inst.data, null, 2);
    });
  }

  /** Returns the data object at the given `path`, or the currently selected node if `path` is omitted. */
  ["tree-node"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["tree-node"], context, r => {
      if (!this.isObject(r)) return null;
      const inst = TreeNode.instances.get(String(r.tree));
      if (!inst) return null;
      const path = r.path != null ? String(r.path) : inst.selectedPath;
      if (!path) return null;
      return resolvePath(inst.data, path);
    });
  }

  /**
   * Applies a `TreeDelta` mutation (`insert` / `remove` / `set` / `move`) to the tree.
   * Useful for replaying remote changes in collaborative editing scenarios.
   * @example
   * { "tree-apply": { "tree": "t", "delta": { "var": "$delta" } } }
   */
  ["tree-apply"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["tree-apply"], context, async r => {
      if (!this.isObject(r)) return null;
      const inst = TreeNode.instances.get(String(r.tree));
      if (!inst) return null;

      const delta = r.delta as TreeDelta;
      if (!delta || !delta.action) return null;

      switch (delta.action) {
        case "insert": {
          const arr = delta.path ? resolvePath(inst.data, delta.path) : inst.data;
          if (Array.isArray(arr)) {
            arr.push(JSON.parse(JSON.stringify(delta.value)));
            await renderSubtree(inst, delta.path);
          }
          break;
        }
        case "remove": {
          const parts = delta.path.split(".");
          const index = parseInt(parts[parts.length - 1]);
          const parentPath = parts.slice(0, -1).join(".");
          const parent = parentPath ? resolvePath(inst.data, parentPath) : inst.data;
          if (Array.isArray(parent) && !isNaN(index)) {
            parent.splice(index, 1);
            if (inst.selectedPath?.startsWith(delta.path)) inst.selectedPath = null;
            await renderSubtree(inst, parentPath);
          }
          break;
        }
        case "set": {
          const parts = delta.path.split(".");
          const key = parts.pop()!;
          const nodePath = parts.join(".");
          const node = nodePath ? resolvePath(inst.data, nodePath) : null;
          if (this.isObject(node)) {
            node[key] = delta.value;
            await renderNodeEl(inst, nodePath);
          }
          break;
        }
        case "move": {
          const arr = delta.path ? resolvePath(inst.data, delta.path) : inst.data;
          if (Array.isArray(arr) && delta.from !== undefined && delta.to !== undefined) {
            const item = arr.splice(delta.from, 1)[0];
            arr.splice(delta.to, 0, item);
            await renderSubtree(inst, delta.path);
          }
          break;
        }
      }

      return null;
    });
  }

  /**
   * Replaces the entire tree data and re-renders. Pass `data` as a JSON string or array. Clears the selection.
   * @example
   * { "tree-set-data": { "tree": "t", "data": { "var": "$json" } } }
   */
  ["tree-set-data"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["tree-set-data"], context, async r => {
      if (!this.isObject(r)) return null;
      const inst = TreeNode.instances.get(String(r.tree));
      if (!inst) return null;

      if (typeof r.data === "string") {
        try { inst.data = JSON.parse(r.data); } catch { return null; }
      } else if (Array.isArray(r.data)) {
        inst.data = r.data;
      } else {
        return null;
      }

      inst.selectedPath = null;
      await renderTree(inst);
      return null;
    });
  }

  /**
   * Sets a value at a specific path in the tree. Defaults to the currently selected node's path.
   * Fires `on-change` with the resulting delta.
   * @example
   * { "tree-set-value": { "tree": "t", "path": "0.tag", "value": "section" } }
   */
  ["tree-set-value"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["tree-set-value"], context, async r => {
      if (!this.isObject(r)) return null;
      const inst = TreeNode.instances.get(String(r.tree));
      if (!inst) return null;

      const path = r.path ? String(r.path) : inst.selectedPath;
      if (!path) return null;

      const parts = path.split(".");
      const lastKey = parts.pop()!;
      const parentPath = parts.join(".");

      const parent = parentPath ? resolvePath(inst.data, parentPath) : inst.data;
      if (Array.isArray(parent)) {
        const idx = parseInt(lastKey);
        if (!isNaN(idx)) parent[idx] = r.value;
      } else if (this.isObject(parent)) {
        parent[lastKey] = r.value;
      }

      await renderNodeEl(inst, path);

      const delta: TreeDelta = { path, action: "set", value: r.value };
      fireChange(inst, delta);
      return delta;
    });
  }
}

// ══════════════════════════════════════════════
//  Rendering — element-agnostic, uses resolver + JSON row template
// ══════════════════════════════════════════════

/** Full render of the entire tree */
async function renderTree(inst: TreeInstance): Promise<void> {
  inst.target.innerHTML = "";

  for (let i = 0; i < inst.data.length; i++) {
    const el = await buildNodeEl(inst, inst.data[i], String(i), 0);
    if (el) inst.target.appendChild(el);
  }

  if (initEventsFn) initEventsFn(inst.target);
}

/**
 * Build a DOM element for one tree node by resolving the row template.
 * Children are recursively rendered into data-children="key" containers.
 */
async function buildNodeEl(
  inst: TreeInstance, node: unknown, path: string, depth: number,
): Promise<HTMLElement | null> {
  const { type, summary, color } = describeNode(node);
  const groups = getChildGroups(node);
  const hasChildren = groups.some(g => g.items.length > 0);
  const expanded = !inst.collapsed.has(path);
  const selected = path === inst.selectedPath;
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
    ...inst.baseContext,
    treeNode: node,
    path, type, summary, color,
    depth, hasChildren, expanded, selected,
    childKeys: allChildKeys,
    editMode, isContainer, expandable, textContent,
    showHeader: !expanded || !expandable,
    isString,
  };

  const rowHtml = String(await resolve(inst.row, ctx) ?? "");

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
        const childEl = await buildNodeEl(inst, items[i], childPath, depth + 1);
        if (childEl) container.appendChild(childEl);
      }
    }
  }

  return el;
}

/** Re-render the children inside a parent's data-children container */
async function renderSubtree(inst: TreeInstance, parentPath: string): Promise<void> {
  if (!parentPath) {
    await renderTree(inst);
    return;
  }

  // parentPath is like "0.content" — split into nodePath + key
  const parts = parentPath.split(".");
  const key = parts.pop()!;
  const nodePath = parts.join(".");

  // Find the node element in the DOM
  const nodeEl = nodePath ? findNode(inst, nodePath) : inst.target;
  if (!nodeEl) {
    await renderTree(inst);
    return;
  }

  // Find the children container
  const container = key
    ? (nodeEl.querySelector(`[data-children="${key}"]`) as HTMLElement)
    : nodeEl;
  if (!container) return;

  container.innerHTML = "";

  // Get the data array at parentPath
  const dataArray = resolvePath(inst.data, parentPath);
  if (!Array.isArray(dataArray)) return;

  const depth = nodePath
    ? nodePath.split(".").filter(p => /^\d+$/.test(p)).length
    : 0;

  for (let i = 0; i < dataArray.length; i++) {
    const childPath = `${parentPath}.${i}`;
    const el = await buildNodeEl(inst, dataArray[i], childPath, depth);
    if (el) container.appendChild(el);
  }

  if (initEventsFn) initEventsFn(container);
}

/** Re-render a single node element (replace in-place) */
async function renderNodeEl(inst: TreeInstance, path: string): Promise<void> {
  const oldEl = findNode(inst, path);
  if (!oldEl) return;

  const node = resolvePath(inst.data, path);
  const depth = path.split(".").filter(p => /^\d+$/.test(p)).length - 1;

  const newEl = await buildNodeEl(inst, node, path, Math.max(0, depth));
  if (!newEl) return;

  oldEl.replaceWith(newEl);
  if (initEventsFn) initEventsFn(newEl);
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
function findNode(inst: TreeInstance, path: string): HTMLElement | null {
  const parts = path.split(".");
  let current: HTMLElement = inst.target;
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

function fireChange(inst: TreeInstance, delta: TreeDelta): void {
  if (!inst.onChangeSteps) return;
  Promise.resolve(runSteps(inst.onChangeSteps, {
    ...inst.baseContext,
    delta,
    editorData: JSON.stringify(inst.data, null, 2),
  })).catch(err => console.error("[TreeNode] onChange error:", err));
}

function fireSelect(inst: TreeInstance): unknown {
  if (!inst.onSelectSteps) return;
  const node = inst.selectedPath ? resolvePath(inst.data, inst.selectedPath) : null;
  return runSteps(inst.onSelectSteps, {
    ...inst.baseContext,
    selectedPath: inst.selectedPath,
    selectedNode: node,
    selectedEditMode: node ? getEditMode(node) : null,
  });
}

// ══════════════════════════════════════════════
//  Drag & Drop — event delegation on tree target
// ══════════════════════════════════════════════

function setupDrag(inst: TreeInstance): void {
  const target = inst.target;
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
      return { parentPath: "", index: inst.data.length, container: target, isInto: false, listOnly: false, textOnly: false };
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
    const nodeData = resolvePath(inst.data, wrapperPath);
    const editMode = getEditMode(nodeData);
    const isContainer = editMode === "children" || editMode === "list";
    const isTextContainer = editMode === "text" || editMode === "textarea";

    if ((isContainer || isTextContainer) && ratio > 0.25 && ratio < 0.75) {
      const childKey = nodeData && typeof nodeData === "object" && !Array.isArray(nodeData)
        ? getChildArrayKey(nodeData as Record<string, unknown>) ?? "content"
        : "content";
      const childContainer = wrapper.querySelector(`[data-children="${childKey}"]`) as HTMLElement;
      const arr = resolvePath(inst.data, wrapperPath + "." + childKey);
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
      const sourceNode = resolvePath(inst.data, sourcePath);
      const isLi = sourceNode && typeof sourceNode === "object" && !Array.isArray(sourceNode)
        && "tag" in (sourceNode as Record<string, unknown>)
        && String((sourceNode as Record<string, unknown>).tag).toLowerCase() === "li";
      if (!isLi) return;
    }

    // Text-only validation: text/textarea elements reject layout containers and lists
    if (info.textOnly) {
      const sourceNode = resolvePath(inst.data, sourcePath);
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
      const sourceNode = resolvePath(inst.data, fromPath);
      const isLi = sourceNode && typeof sourceNode === "object" && !Array.isArray(sourceNode)
        && "tag" in (sourceNode as Record<string, unknown>)
        && String((sourceNode as Record<string, unknown>).tag).toLowerCase() === "li";
      if (!isLi) return;
    }

    // Text-only validation on drop too
    if (info.textOnly) {
      const sourceNode = resolvePath(inst.data, fromPath);
      const sourceMode = getEditMode(sourceNode);
      if (sourceMode === "children" || sourceMode === "list") return;
    }

    await moveNodeTo(inst, fromPath, info.parentPath, info.index);
  });
}

/** Move a node from one location to another in the tree */
async function moveNodeTo(
  inst: TreeInstance, fromPath: string, toParentPath: string, toIndex: number,
): Promise<void> {
  const sourceNode = resolvePath(inst.data, fromPath);
  if (sourceNode === undefined) return;
  const copy = JSON.parse(JSON.stringify(sourceNode));

  // Parse source location
  const fromParts = fromPath.split(".");
  const fromIdx = parseInt(fromParts[fromParts.length - 1]);
  const fromParent = fromParts.slice(0, -1).join(".");
  if (isNaN(fromIdx)) return;

  const fromArr = (fromParent ? resolvePath(inst.data, fromParent) : inst.data) as unknown[];
  if (!Array.isArray(fromArr)) return;

  // Remove source
  fromArr.splice(fromIdx, 1);

  // Adjust target path after removal
  const adjParent = adjustPathAfterRemoval(toParentPath, fromPath);
  let adjIndex = toIndex;
  if (fromParent === adjParent && fromIdx < toIndex) adjIndex--;

  // Get or create target array
  let toArr = (adjParent ? resolvePath(inst.data, adjParent) : inst.data) as unknown[];
  if (!Array.isArray(toArr)) {
    const pp = adjParent.split(".");
    const key = pp.pop()!;
    const nodePath = pp.join(".");
    const node = nodePath ? resolvePath(inst.data, nodePath) : null;
    if (node && typeof node === "object" && !Array.isArray(node)) {
      (node as Record<string, unknown>)[key] = [];
      toArr = (node as Record<string, unknown>)[key] as unknown[];
    } else return;
  }

  adjIndex = Math.max(0, Math.min(adjIndex, toArr.length));
  toArr.splice(adjIndex, 0, copy);

  inst.selectedPath = adjParent ? `${adjParent}.${adjIndex}` : String(adjIndex);

  await renderTree(inst);

  const delta: TreeDelta = { path: inst.selectedPath, action: "move", value: copy };
  fireChange(inst, delta);
}

// Pure utility functions imported from ./treeUtils.ts
