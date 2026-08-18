import { Node, Context, NodeValue, childContext, resolve, resolveObj, runSteps } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";
import { targetWindow, windowNameOf } from "./Window.js";

/**
 * Roles Electron implements natively. A role item needs no `do` — the OS wires
 * it to the focused webContents, which is why Edit > Copy works on a text field
 * without any handler.
 */
const ROLES = [
  "undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "delete", "selectAll",
  "reload", "forceReload", "toggleDevTools", "resetZoom", "zoomIn", "zoomOut",
  "togglefullscreen", "minimize", "close", "quit", "about", "hide", "hideOthers", "unhide",
  "front", "appMenu", "fileMenu", "editMenu", "viewMenu", "windowMenu",
] as const;

const ITEM_TYPES = ["normal", "separator", "submenu", "checkbox", "radio"] as const;

/** Fields resolved per item. `do` and `submenu` are deliberately absent. */
const SCALAR_FIELDS = ["label", "accelerator", "role", "type", "checked", "enabled", "visible", "id"];

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Per-window menus, so macOS can swap the app menu as focus moves. */
const menuByWindow = new Map<string, Electron.Menu>();
let focusHookInstalled = false;

/** Test seam. */
export function resetMenus(): void {
  menuByWindow.clear();
}

/**
 * Turn a JSON item tree into an Electron menu template.
 *
 * `do` and `submenu` are pulled out BEFORE resolving and never passed through
 * the resolver: resolving `do` in main would turn `{"setText": ...}` into a
 * plain object, since main has no DOM handler for it, and the steps would be
 * silently destroyed rather than dispatched. Only the scalar fields resolve, so
 * a label or an enabled flag can still be an expression.
 */
export async function buildMenuTemplate(
  items: unknown,
  context: Context,
  onClick: (steps: unknown[], item: Electron.MenuItem, win?: Electron.BaseWindow) => void,
): Promise<Electron.MenuItemConstructorOptions[]> {
  // The tree itself may come from an expression — `{"var": "$menu"}`, or a
  // `{"file": "menu.json", "data": true}` — so resolve the CONTAINER before
  // walking it. Only the container: resolving the items would destroy their
  // `do` steps, which is the whole reason this function exists. Note the file
  // case needs `data: true`, or FileNode resolves the tree as an expression and
  // mangles the handlers before they ever arrive.
  const list = Array.isArray(items) ? items : await resolve(items, context);
  if (!Array.isArray(list)) return [];
  const out: Electron.MenuItemConstructorOptions[] = [];

  for (const raw of list) {
    if (!isObject(raw)) continue;

    const steps = Array.isArray(raw.do) ? raw.do : null;
    const submenu = raw.submenu;

    const scalars: Record<string, unknown> = {};
    for (const key of SCALAR_FIELDS) if (key in raw) scalars[key] = raw[key];
    const r = await resolveObj(scalars, context, (resolved) => resolved);

    const item: Electron.MenuItemConstructorOptions = {};
    if (typeof r.label === "string") item.label = r.label;
    if (typeof r.accelerator === "string") item.accelerator = r.accelerator;
    if (typeof r.id === "string") item.id = r.id;
    if (typeof r.checked === "boolean") item.checked = r.checked;
    if (typeof r.enabled === "boolean") item.enabled = r.enabled;
    if (typeof r.visible === "boolean") item.visible = r.visible;
    if (ROLES.includes(r.role as (typeof ROLES)[number])) {
      item.role = r.role as Electron.MenuItemConstructorOptions["role"];
    }
    if (ITEM_TYPES.includes(r.type as (typeof ITEM_TYPES)[number])) {
      item.type = r.type as Electron.MenuItemConstructorOptions["type"];
    }

    if (submenu !== undefined) {
      item.submenu = await buildMenuTemplate(submenu, context, onClick);
    }
    if (steps) {
      item.click = (menuItem, win) => onClick(steps, menuItem, win);
    }

    out.push(item);
  }
  return out;
}

/**
 * Native application and window menus.
 *
 * A menu is a native JSON config rather than HTML because macOS puts the
 * application menu in the system menu bar, outside the window, where HTML cannot
 * reach. Defining menus in HTML as well would mean authoring every menu twice.
 */
export class MenuNode extends Node {
  static schemaDefs = {
    _menuItem: {
      type: "object",
      properties: {
        label: { type: "string", markdownDescription: "Text shown in the menu." },
        accelerator: { type: "string", markdownDescription: "Keyboard shortcut, e.g. `CmdOrCtrl+O`." },
        role: {
          type: "string",
          enum: [...ROLES],
          markdownDescription: "Native behavior handled by the OS. A role item needs no `do` — `copy` and `paste` reach the focused field on their own.",
        },
        type: { type: "string", enum: [...ITEM_TYPES], markdownDescription: "Item kind. Use `separator` for a divider." },
        checked: { type: "boolean", markdownDescription: "Tick state for a `checkbox` or `radio` item." },
        enabled: { type: "boolean", markdownDescription: "Set `false` to grey the item out." },
        visible: { type: "boolean", markdownDescription: "Set `false` to hide the item." },
        id: { type: "string", markdownDescription: "Identifier, readable in the handler as `$menuId`." },
        submenu: { type: "array", items: { $ref: "#/$defs/_menuItem" }, markdownDescription: "Nested items." },
        do: { $ref: "#/$defs/steps", markdownDescription: "Steps run in the main process when the item is clicked." },
      },
      additionalProperties: false,
    },
  };

  static schema: JexsNodeSchema = {
    menu: {
      type: "array",
      items: { $ref: "#/$defs/_menuItem" },
      output: "null",
      markdownDescription:
        "Set the native menu from a JSON item tree. Calling it again replaces the current menu, which is how you grey out an item or toggle a checkbox — there is no separate update op.\nWithout `window` this is the application menu. With it, the menu attaches to that window alone (on macOS, where the menu bar belongs to the app, the focused window's menu becomes the application menu).\n`do` steps run in the **main** process with `$menuLabel`, `$menuId` and `$menuChecked` bound; DOM ops inside them are forwarded to the window automatically.\nThe tree may be an expression instead of a literal — `{ \"var\": \"$menu\" }`, or a file. Load a file with `\"data\": true`, otherwise it is resolved as an expression and the `do` handlers are destroyed before they arrive.",
      examples: [
        "{ \"menu\": [{ \"label\": \"File\", \"submenu\": [{ \"label\": \"Quit\", \"role\": \"quit\" }] }] }",
        "{ \"menu\": { \"file\": \"menu.json\", \"data\": true } }",
      ],
      siblings: {
        window: {
          type: "string",
          description: "Attach to this window instead of setting the application menu.",
        },
      },
    },
  };

  // NOT a blanket resolveObj: `do` and `submenu` must reach buildMenuTemplate
  // raw. Only the target window resolves here; item scalars resolve per item.
  menu(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.window ?? null, context, async (target) => {
      const { Menu, app } = await import("electron");

      const template = await buildMenuTemplate(def.menu, context, (steps, item, win) => {
        // Electron hands the click the window whose menu it was, so a nested DOM
        // op targets the right renderer with no author effort.
        const extra: Record<string, unknown> = {
          menuLabel: item.label,
          menuId: item.id,
          menuChecked: item.checked,
        };
        const name = windowNameOf(win ?? null);
        if (name) extra.windowName = name;
        Promise.resolve(runSteps(steps, childContext(context, extra))).catch((err: unknown) => {
          console.error(`[MenuNode] "${String(item.label ?? item.id ?? "item")}" failed:`, err);
        });
      });

      const menu = Menu.buildFromTemplate(template);
      const name = typeof target === "string" && target !== "" ? target : null;

      if (!name) {
        Menu.setApplicationMenu(menu);
        return null;
      }

      menuByWindow.set(name, menu);
      const win = targetWindow(name, context);

      if (process.platform === "darwin") {
        // The menu bar belongs to the app, not the window, so a per-window menu
        // can only mean "swap it in while that window is focused".
        if (win?.isFocused()) Menu.setApplicationMenu(menu);
        if (!focusHookInstalled) {
          focusHookInstalled = true;
          app.on("browser-window-focus", (_event, focused) => {
            const focusedName = windowNameOf(focused);
            const forWindow = focusedName ? menuByWindow.get(focusedName) : undefined;
            if (forWindow) Menu.setApplicationMenu(forWindow);
          });
        }
      } else {
        win?.setMenu(menu);
      }
      return null;
    });
  }
}
