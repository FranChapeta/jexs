import { Node, Context, NodeValue, resolve, resolveAll, resolveObj } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";
import { fileURLToPath } from "node:url";
import { noWindowError, runInRenderer } from "../bridge.js";

/** Absolute path to the shipped CJS preload. Compiled to dist/nodes/Window.js,
 *  so preload.cjs sits two levels up at the package root. */
export function preloadPath(): string {
  return fileURLToPath(new URL("../../preload.cjs", import.meta.url));
}

// Window registry

const windows = new Map<string, Electron.BrowserWindow>();
// Keyed by object identity rather than by BrowserWindow, so callers holding the
// looser BaseWindow that Electron hands to menu clicks can look up too.
const nameOf = new WeakMap<object, string>();
let defaultWindowName: string | null = null;
/** Options the first window was opened with, replayed by `reopenPrimary`. */
let primaryOpts: Record<string, unknown> | null = null;

/** `pages/settings.json` -> `settings`. The zero-ceremony default name. */
export function baseName(page: string): string {
  const file = page.split(/[\\/]/).pop() ?? page;
  return file.replace(/\.json$/i, "") || "window";
}

/** First free name in the `base`, `base-2`, `base-3` sequence. */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Pick the next default after `closing` is removed. Deliberately diverges from
 * DatabaseNode, which nulls its default on close: windows close routinely, so
 * leaving the default empty would silently break every later handler. Promote
 * the first remaining window instead; null only when none remain.
 */
export function nextDefault(
  closing: string,
  current: string | null,
  remaining: Iterable<string>,
): string | null {
  if (current !== closing) return current;
  for (const name of remaining) return name;
  return null;
}

function unregisterWindow(name: string): void {
  windows.delete(name);
  defaultWindowName = nextDefault(name, defaultWindowName, windows.keys());
}

function registerWindow(name: string, win: Electron.BrowserWindow): string {
  windows.set(name, win);
  nameOf.set(win, name);
  if (!defaultWindowName) defaultWindowName = name; // cf. Database.ts:306
  win.on("closed", () => unregisterWindow(name));
  return name;
}

/** The registered name of a window, for seeding a main-process context. */
export function windowNameOf(win: Electron.BaseWindow | null | undefined): string | undefined {
  return win ? nameOf.get(win) : undefined;
}

/**
 * Resolve which window an op acts on: an explicit name, else the calling
 * renderer's own window, else the default.
 *
 * Note what is NOT here: `getFocusedWindow()`. Focus is null whenever the app is
 * in the background, so a tray or global-shortcut handler firing while another
 * app has focus would resolve to nothing. An insertion-ordered default is
 * deterministic.
 */
export function targetWindow(
  target: unknown,
  context: Context,
): Electron.BrowserWindow | null {
  const name =
    typeof target === "string" && target !== ""
      ? target
      : typeof context.windowName === "string"
        ? context.windowName
        : defaultWindowName;
  return name ? windows.get(name) ?? null : null;
}

/**
 * Reopen the app's primary window — the macOS `activate` case, where the app is
 * alive with no windows open and the dock icon was clicked. Replays whatever
 * options the first window used, so a custom page or size survives rather than
 * being replaced by a bare default.
 */
export async function reopenPrimary(fallback: Record<string, unknown> = {}): Promise<string> {
  return openWindow(primaryOpts ?? fallback);
}

/** Test seam: drop all registry state. */
export function resetWindows(): void {
  windows.clear();
  defaultWindowName = null;
  primaryOpts = null;
}

/** Test seam: the current default, or null. */
export function currentDefault(): string | null {
  return defaultWindowName;
}

// ---------------------------------------------------------------------------
// Option building
// ---------------------------------------------------------------------------

/** The page template a window should load, defaulting to the app entry. */
export function pageName(value: unknown): string {
  return typeof value === "string" && value !== "" ? value : "index.json";
}

const TITLE_BAR_STYLES = ["default", "hidden", "hiddenInset", "customButtonsOnHover"] as const;
type TitleBarStyle = (typeof TITLE_BAR_STYLES)[number];

/**
 * Build BrowserWindow constructor options from resolved siblings. Pure and
 * electron-free so it can be unit tested without a runtime.
 */
export function browserWindowOptions(
  opts: Record<string, unknown>,
): Electron.BrowserWindowConstructorOptions {
  const out: Electron.BrowserWindowConstructorOptions = {
    width: typeof opts.width === "number" ? opts.width : 1280,
    height: typeof opts.height === "number" ? opts.height : 720,
    fullscreen: !!opts.fullscreen,
    title: typeof opts.title === "string" ? opts.title : undefined,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      sandbox: true,
    },
  };
  if (opts.frame === false) out.frame = false;
  if (TITLE_BAR_STYLES.includes(opts.titleBarStyle as TitleBarStyle)) {
    out.titleBarStyle = opts.titleBarStyle as TitleBarStyle;
  }
  return out;
}

/** Build a partial bounds rect from a resolved object, dropping non-numbers. */
export function boundsOptions(value: unknown): Partial<Electron.Rectangle> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const src = value as Record<string, unknown>;
  const out: Partial<Electron.Rectangle> = {};
  for (const key of ["x", "y", "width", "height"] as const) {
    if (typeof src[key] === "number") out[key] = src[key];
  }
  return out;
}

/**
 * Open a BrowserWindow showing a JSON page template over `app://`. Shared by the
 * runner (the initial window — boilerplate every app needs) and WindowNode
 * (renderer-requested windows). Resolves to the name it registered under.
 *
 * `page` is a JSON template name (from `src/`, default `index.json`). The runner's
 * `app://` handler returns a generated shell for it that mounts the template at
 * runtime — there is no HTML file.
 */
export async function openWindow(opts: Record<string, unknown> = {}): Promise<string> {
  const { BrowserWindow, shell } = await import("electron");
  const win = new BrowserWindow(browserWindowOptions(opts));

  if (!primaryOpts) primaryOpts = { ...opts };
  const page = pageName(opts.page);
  const requested = typeof opts.name === "string" && opts.name !== "" ? opts.name : baseName(page);
  const name = registerWindow(uniqueName(requested, new Set(windows.keys())), win);

  // Only `app://` content may ever load here: this window's preload exposes the
  // main-process resolver over IPC, so foreign content must never reach it.
  // External links open in the user's browser instead of an in-app window.
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("app://")) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  // Load the template over app:// with `?wrap`, which tells the runner to return
  // the shell wrapping this page (rather than serving the path as a raw file).
  await win.loadURL(`app://local/${encodeURIComponent(page)}?wrap`);
  return name;
}

export function shellTemplate(): unknown {
  return {
    tag: "html",
    content: [
      {
        tag: "head",
        content: [
          { tag: "meta", charset: "utf-8" },
          { tag: "meta", name: "viewport", content: "width=device-width, initial-scale=1" },
          { tag: "title", content: { var: "$title" } },
        ],
      },
      { tag: "body", content: [{ file: { var: "$page" } }] },
    ],
  };
}

const WINDOW_SIBLING = {
  type: "string",
  description: "Name of the window to act on. Defaults to the calling window, then to the default window.",
} as const;

export class WindowNode extends Node {
  static schema: JexsNodeSchema = {
    "window-open": {
      type: "string",
      output: "string",
      markdownDescription:
        "Open a BrowserWindow showing a JSON page template over `app://` — the value is the template file from `src/` (e.g. `settings.json`, default `index.json`). A generated shell mounts it at runtime; there is no HTML file.\nThe window is registered under `name`, or under the template's basename (`settings.json` becomes `settings`, deduped `settings-2`). The first window opened becomes the default target for every other `window-*` op.",
      outputDescription: "The name the window was registered under — pass it to `window-close` and friends.",
      examples: ["{ \"window-open\": \"settings.json\", \"width\": 480, \"height\": 320 }"],
      siblings: {
        name: { type: "string", description: "Register the window under this name instead of the template basename." },
        width: { type: "number", description: "Window width in pixels." },
        height: { type: "number", description: "Window height in pixels." },
        fullscreen: { type: "boolean", description: "Open the window fullscreen." },
        title: { type: "string", description: "Window title." },
        frame: { type: "boolean", description: "Set `false` for a frameless window, so the page can draw its own title bar." },
        titleBarStyle: {
          type: "string",
          enum: [...TITLE_BAR_STYLES],
          description: "Native title bar treatment. `hidden` keeps the traffic lights on macOS while freeing the bar for custom chrome.",
        },
      },
    },

    // No-arg ops carry the target in the primary slot, since they have no other
    // argument. Valued ops below take their value there and target via `window`.
    "window-close": {
      type: ["string", "boolean"],
      output: "null",
      markdownDescription: "Close a window. The value names it; `true` closes the calling window, falling back to the default.",
      examples: ["{ \"window-close\": true }", "{ \"window-close\": \"settings\" }"],
    },
    "window-focus": {
      type: ["string", "boolean"],
      output: "null",
      markdownDescription: "Bring a window to the front, restoring it first if minimized.",
      examples: ["{ \"window-focus\": \"main\" }"],
    },
    "window-min": {
      type: ["string", "boolean"],
      output: "null",
      markdownDescription: "Minimize a window.",
      examples: ["{ \"window-min\": true }"],
    },
    "window-max": {
      type: ["string", "boolean"],
      output: "null",
      markdownDescription: "Maximize a window, or unmaximize it if already maximized.",
      examples: ["{ \"window-max\": true }"],
    },
    "window-restore": {
      type: ["string", "boolean"],
      output: "null",
      markdownDescription: "Restore a minimized or maximized window to its normal size.",
      examples: ["{ \"window-restore\": true }"],
    },
    "window-reload": {
      type: ["string", "boolean"],
      output: "null",
      markdownDescription: "Reload a window's page template.",
      examples: ["{ \"window-reload\": true }"],
    },
    "window-devtools": {
      type: ["string", "boolean"],
      output: "null",
      markdownDescription: "Toggle the developer tools for a window.",
      examples: ["{ \"window-devtools\": true }"],
    },

    "window-title": {
      type: "string",
      output: "null",
      markdownDescription: "Set a window's title.",
      examples: ["{ \"window-title\": \"Untitled - Editor\" }"],
      siblings: { window: WINDOW_SIBLING },
    },
    "window-bounds": {
      type: "object",
      output: "null",
      markdownDescription: "Move and/or resize a window. Any of `x`, `y`, `width`, `height` may be omitted to leave that axis alone.",
      examples: ["{ \"window-bounds\": { \"width\": 900, \"height\": 600 } }"],
      siblings: { window: WINDOW_SIBLING },
      properties: {
        x: { type: "number", description: "Left edge in screen pixels." },
        y: { type: "number", description: "Top edge in screen pixels." },
        width: { type: "number", description: "Width in pixels." },
        height: { type: "number", description: "Height in pixels." },
      },
    },

    "window-list": {
      output: "array",
      markdownDescription: "List every open window with its name, id, title, state and bounds.",
      outputDescription: "An array of `{ name, id, title, visible, minimized, maximized, focused, bounds }` objects, in the order the windows were opened.",
      examples: ["{ \"window-list\": true }"],
    },

    "window-run": {
      steps: true,
      output: "any",
      markdownDescription:
        "Run steps inside a window's page, where the DOM lives.\nMost of the time this is unnecessary — a DOM op written in a main-process handler is forwarded to the default window automatically. Reach for this when you need a *specific* window, since a per-op `window` sibling is impossible: DOM ops are declared by `@jexs/client`, and one package cannot add a sibling to another package's op.\nSteps are sent unresolved and run in the target renderer against the page context, so they see the same state the page's own event handlers do.",
      outputDescription: "Whatever the last step evaluates to, brought back across the bridge.",
      examples: ["{ \"window-run\": [{ \"setText\": [\"#status\", \"Saved\"] }], \"window\": \"editor\" }"],
      siblings: {
        window: WINDOW_SIBLING,
        params: { map: true, description: "Values merged into the steps' scope, resolved in the main process before they cross." },
      },
    },
  };

  // Siblings arrive unresolved (the resolver only routes on the matched key), so
  // everything goes through resolveObj/resolve first. Safe to blanket-resolve in
  // this node because it has no step-array siblings — Menu/Tray/Shortcut must NOT
  // do this, since their `do` and `submenu` have to reach the handler raw.
  ["window-open"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveObj(def, context, async (r) => {
      return openWindow({
        page: r["window-open"],
        name: r.name,
        width: r.width,
        height: r.height,
        fullscreen: r.fullscreen,
        title: r.title,
        frame: r.frame,
        titleBarStyle: r.titleBarStyle,
      });
    });
  }

  ["window-close"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["window-close"], context, (t) => {
      targetWindow(t, context)?.close();
      return null;
    });
  }

  ["window-focus"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["window-focus"], context, (t) => {
      const win = targetWindow(t, context);
      if (!win) return null;
      if (win.isMinimized()) win.restore();
      win.focus();
      return null;
    });
  }

  ["window-min"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["window-min"], context, (t) => {
      targetWindow(t, context)?.minimize();
      return null;
    });
  }

  ["window-max"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["window-max"], context, (t) => {
      const win = targetWindow(t, context);
      if (!win) return null;
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      return null;
    });
  }

  ["window-restore"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["window-restore"], context, (t) => {
      const win = targetWindow(t, context);
      if (!win) return null;
      if (win.isMinimized()) win.restore();
      if (win.isMaximized()) win.unmaximize();
      return null;
    });
  }

  ["window-reload"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["window-reload"], context, (t) => {
      targetWindow(t, context)?.reload();
      return null;
    });
  }

  ["window-devtools"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["window-devtools"], context, (t) => {
      targetWindow(t, context)?.webContents.toggleDevTools();
      return null;
    });
  }

  ["window-title"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveObj(def, context, (r) => {
      const win = targetWindow(r.window, context);
      if (win) win.setTitle(this.toString(r["window-title"]));
      return null;
    });
  }

  ["window-bounds"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveObj(def, context, (r) => {
      const win = targetWindow(r.window, context);
      const bounds = boundsOptions(r["window-bounds"]);
      if (win && Object.keys(bounds).length > 0) win.setBounds(bounds);
      return null;
    });
  }

  /**
   * Ship a step array to a window and run it there.
   *
   * The steps are read RAW and never resolved here: resolving in main would turn
   * `{"setText": ...}` into a plain object, because main has no DOM handler for
   * it. Only `window` and `params` resolve, so main-side values can cross.
   *
   * The result comes back over the same correlation-id transport as any other
   * proxied call.
   */
  ["window-run"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolveAll([def.window ?? null, def.params ?? null], context, ([target, params]) => {
      const win = targetWindow(target, context);
      if (!win) throw noWindowError("window-run");
      return runInRenderer(win, def["window-run"], params);
    });
  }

  ["window-list"](_def: Record<string, unknown>, _context: Context): NodeValue {
    const out: Record<string, unknown>[] = [];
    for (const [name, win] of windows) {
      out.push({
        name,
        id: win.id,
        title: win.getTitle(),
        visible: win.isVisible(),
        minimized: win.isMinimized(),
        maximized: win.isMaximized(),
        focused: win.isFocused(),
        bounds: win.getBounds(),
      });
    }
    return out;
  }
}
