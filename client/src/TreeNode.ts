import { Node, Context, NodeValue } from "@jexs/core";
import { resolve } from "@jexs/core";
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

  async ["tree-init"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const rawInit = def["tree-init"];

    // Extract row before resolution to prevent ElementNode from rendering it to HTML.
    let rawRow: unknown = undefined;
    let configToResolve: unknown = rawInit;

    if (rawInit && typeof rawInit === "object" && !Array.isArray(rawInit)) {
      const obj = rawInit as Record<string, unknown>;
      if ("row" in obj) {
        rawRow = obj.row;
        const copy: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (k !== "row") copy[k] = v;
        }
        configToResolve = copy;
      }
    }

    const config = await resolve(configToResolve, context) as Record<string, unknown>;
    if (!config) return null;

    const id = String(config.id ?? "default");
    const target = document.querySelector(String(config.target)) as HTMLElement;
    if (!target) return null;

    let data: unknown[] = [];
    if (config.data) {
      if (typeof config.data === "string") {
        try { data = JSON.parse(config.data); } catch { data = []; }
      } else if (Array.isArray(config.data)) {
        data = config.data;
      } else {
        data = [config.data];
      }
    }

    const inst: TreeInstance = {
      data,
      target,
      row: rawRow !== undefined ? rawRow : config.row,
      selectedPath: null,
      collapsed: new Set(),
      onChangeSteps: Array.isArray(def["on-change"]) ? def["on-change"] as unknown[] : null,
      onSelectSteps: Array.isArray(def["on-select"]) ? def["on-select"] as unknown[] : null,
      baseContext: { ...context },
    };

    TreeNode.instances.set(id, inst);
    await renderTree(inst);
    setupDrag(inst);
    return null;
  }

  async ["tree-insert"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const rawInsert = def["tree-insert"];

    // Extract value before resolution to prevent ElementNode from rendering
    let rawValue: unknown = undefined;
    let configToResolve: unknown = rawInsert;

    if (rawInsert && typeof rawInsert === "object" && !Array.isArray(rawInsert)) {
      const obj = rawInsert as Record<string, unknown>;
      if ("value" in obj) {
        rawValue = obj.value;
        const copy: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (k !== "value") copy[k] = v;
        }
        configToResolve = copy;
      }
    }

    const config = await resolve(configToResolve, context) as Record<string, unknown>;
    if (!config) return null;

    const inst = TreeNode.instances.get(String(config.tree));
    if (!inst) return null;

    // Resolve value: if it's a var reference, resolve it; otherwise keep raw
    let value: unknown = rawValue;
    if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
      const rvObj = rawValue as Record<string, unknown>;
      if ("var" in rvObj) {
        value = await resolve(rawValue, context);
      }
    }

    // Handle stringified JSON values (e.g. from button value attributes)
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch { /* keep as string */ }
    }

    value = JSON.parse(JSON.stringify(value)); // deep clone
    const targetPath = config.path ? String(config.path) : null;
    const insertPath = targetPath ?? inst.selectedPath;

    let parentArrayPath: string;

    if (insertPath) {
      const parent = resolvePath(inst.data, insertPath);
      if (parent && typeof parent === "object" && !Array.isArray(parent)) {
        const childKey = getChildArrayKey(parent as Record<string, unknown>);
        if (childKey) {
          const obj = parent as Record<string, unknown>;
          if (!Array.isArray(obj[childKey])) obj[childKey] = obj[childKey] ? [obj[childKey]] : [];
          (obj[childKey] as unknown[]).push(value);
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
    return delta as unknown as NodeValue;
  }

  async ["tree-remove"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const id = String(await resolve(def["tree-remove"], context));
    const inst = TreeNode.instances.get(id);
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
    return delta as unknown as NodeValue;
  }

  async ["tree-update"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const config = await resolve(def["tree-update"], context) as Record<string, unknown>;
    if (!config) return null;

    const inst = TreeNode.instances.get(String(config.tree));
    if (!inst || !inst.selectedPath) return null;

    const node = resolvePath(inst.data, inst.selectedPath);
    if (!node || typeof node !== "object" || Array.isArray(node)) return null;

    const obj = node as Record<string, unknown>;
    const key = String(config.key);
    const value = config.value;

    if (value === null || value === undefined || value === "") {
      delete obj[key];
    } else {
      obj[key] = value;
    }

    await renderNodeEl(inst, inst.selectedPath);

    const delta: TreeDelta = { path: inst.selectedPath + "." + key, action: "set", value };
    fireChange(inst, delta);
    return delta as unknown as NodeValue;
  }

  async ["tree-move"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const config = await resolve(def["tree-move"], context) as Record<string, unknown>;
    if (!config) return null;

    const inst = TreeNode.instances.get(String(config.tree));
    if (!inst || !inst.selectedPath) return null;

    const direction = String(config.direction);
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
    return delta as unknown as NodeValue;
  }

  async ["tree-select"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const config = await resolve(def["tree-select"], context) as Record<string, unknown>;
    if (!config) return null;

    const inst = TreeNode.instances.get(String(config.tree));
    if (!inst) return null;

    const oldPath = inst.selectedPath;
    inst.selectedPath = config.path != null ? String(config.path) : null;

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
    return inst.selectedPath ? resolvePath(inst.data, inst.selectedPath) as NodeValue : null;
  }

  async ["tree-toggle"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const config = await resolve(def["tree-toggle"], context) as Record<string, unknown>;
    if (!config) return null;

    const inst = TreeNode.instances.get(String(config.tree));
    if (!inst) return null;

    const path = String(config.path);
    if (inst.collapsed.has(path)) {
      inst.collapsed.delete(path);
    } else {
      inst.collapsed.add(path);
    }

    await renderNodeEl(inst, path);

    return !inst.collapsed.has(path);
  }

  async ["tree-data"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const id = String(await resolve(def["tree-data"], context));
    const inst = TreeNode.instances.get(id);
    if (!inst) return null;
    return JSON.stringify(inst.data, null, 2);
  }

  async ["tree-node"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const config = await resolve(def["tree-node"], context) as Record<string, unknown>;
    if (!config) return null;

    const inst = TreeNode.instances.get(String(config.tree));
    if (!inst) return null;

    const path = config.path != null ? String(config.path) : inst.selectedPath;
    if (!path) return null;

    return resolvePath(inst.data, path) as NodeValue;
  }

  async ["tree-apply"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const config = await resolve(def["tree-apply"], context) as Record<string, unknown>;
    if (!config) return null;

    const inst = TreeNode.instances.get(String(config.tree));
    if (!inst) return null;

    const delta = config.delta as TreeDelta;
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
          if (inst.selectedPath?.startsWith(delta.path)) {
            inst.selectedPath = null;
          }
          await renderSubtree(inst, parentPath);
        }
        break;
      }
      case "set": {
        const parts = delta.path.split(".");
        const key = parts.pop()!;
        const nodePath = parts.join(".");
        const node = nodePath ? resolvePath(inst.data, nodePath) : null;
        if (node && typeof node === "object" && !Array.isArray(node)) {
          (node as Record<string, unknown>)[key] = delta.value;
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
  }

  async ["tree-set-data"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const config = await resolve(def["tree-set-data"], context) as Record<string, unknown>;
    if (!config) return null;

    const inst = TreeNode.instances.get(String(config.tree));
    if (!inst) return null;

    if (typeof config.data === "string") {
      try { inst.data = JSON.parse(config.data); } catch { return null; }
    } else if (Array.isArray(config.data)) {
      inst.data = config.data;
    } else {
      return null;
    }

    inst.selectedPath = null;
    await renderTree(inst);
    return null;
  }

  async ["tree-set-value"](def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const config = await resolve(def["tree-set-value"], context) as Record<string, unknown>;
    if (!config) return null;

    const inst = TreeNode.instances.get(String(config.tree));
    if (!inst) return null;

    const path = config.path ? String(config.path) : inst.selectedPath;
    if (!path) return null;

    const parts = path.split(".");
    const lastKey = parts.pop()!;
    const parentPath = parts.join(".");

    const parent = parentPath ? resolvePath(inst.data, parentPath) : inst.data;
    if (Array.isArray(parent)) {
      const idx = parseInt(lastKey);
      if (!isNaN(idx)) parent[idx] = config.value;
    } else if (parent && typeof parent === "object") {
      (parent as Record<string, unknown>)[lastKey] = config.value;
    }

    await renderNodeEl(inst, path);

    const delta: TreeDelta = { path, action: "set", value: config.value };
    fireChange(inst, delta);
    return delta as unknown as NodeValue;
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

async function fireChange(inst: TreeInstance, delta: TreeDelta): Promise<void> {
  if (!inst.onChangeSteps) return;
  try {
    const ctx: Context = {
      ...inst.baseContext,
      delta,
      editorData: JSON.stringify(inst.data, null, 2),
    };
    for (const step of inst.onChangeSteps) {
      const result = await resolve(step, ctx);
      if (step && typeof step === "object" && !Array.isArray(step) && "as" in step) {
        ctx[String((step as Record<string, unknown>).as).replace(/^\$/, "")] = result;
      }
    }
  } catch (err) {
    console.error("[TreeNode] onChange error:", err);
  }
}

async function fireSelect(inst: TreeInstance): Promise<void> {
  if (!inst.onSelectSteps) return;
  try {
    const node = inst.selectedPath ? resolvePath(inst.data, inst.selectedPath) : null;
    const editMode = node ? getEditMode(node) : null;
    const ctx: Context = {
      ...inst.baseContext,
      selectedPath: inst.selectedPath,
      selectedNode: node,
      selectedEditMode: editMode,
    };
    for (const step of inst.onSelectSteps) {
      const result = await resolve(step, ctx);
      if (step && typeof step === "object" && !Array.isArray(step) && "as" in step) {
        ctx[String((step as Record<string, unknown>).as).replace(/^\$/, "")] = result;
      }
    }
  } catch (err) {
    console.error("[TreeNode] onSelect error:", err);
  }
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
