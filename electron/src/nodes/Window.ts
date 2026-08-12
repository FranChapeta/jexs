import { Node, Context, NodeValue, resolveObj } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";
import { fileURLToPath } from "node:url";

/** Absolute path to the shipped CJS preload. Compiled to dist/nodes/Window.js,
 *  so preload.cjs sits two levels up at the package root. */
export function preloadPath(): string {
  return fileURLToPath(new URL("../../preload.cjs", import.meta.url));
}

/** The page template a window should load, defaulting to the app entry. */
export function pageName(value: unknown): string {
  return typeof value === "string" && value !== "" ? value : "index.json";
}

/**
 * Build BrowserWindow constructor options from resolved siblings. Pure and
 * electron-free so it can be unit tested without a runtime.
 */
export function browserWindowOptions(
  opts: Record<string, unknown>,
): Electron.BrowserWindowConstructorOptions {
  return {
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
}

/**
 * Open a BrowserWindow showing a JSON page template over `app://`. Shared by the
 * runner (the initial window — boilerplate every app needs) and WindowNode
 * (renderer-requested windows). Options: width, height, fullscreen, title, page.
 *
 * `page` is a JSON template name (from `src/`, default `index.json`). The runner's
 * `app://` handler returns a generated shell for it that mounts the template at
 * runtime — there is no HTML file.
 */
export async function openWindow(opts: Record<string, unknown> = {}): Promise<void> {
  const { BrowserWindow, shell } = await import("electron");
  const win = new BrowserWindow(browserWindowOptions(opts));

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
  await win.loadURL(`app://local/${encodeURIComponent(pageName(opts.page))}?wrap`);
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

/** Open a secondary BrowserWindow — `{ "window": "<page.json>", ...opts }`. */
export class WindowNode extends Node {
  static schema: JexsNodeSchema = {
    window: {
      type: "string",
      output: "null",
      markdownDescription:
        "Open a BrowserWindow showing a JSON page template over `app://` — the value is the template file from `src/` (e.g. `settings.json`, default `index.json`). A generated shell mounts it at runtime; there is no HTML file. Size and title are siblings. The runner opens the first window automatically; use this for secondary windows.",
      examples: ["{ \"window\": \"settings.json\", \"width\": 480, \"height\": 320 }"],
      siblings: {
        width: { type: "number", description: "Window width in pixels." },
        height: { type: "number", description: "Window height in pixels." },
        fullscreen: { type: "boolean", description: "Open the window fullscreen." },
        title: { type: "string", description: "Window title." },
      },
    },
  };

  // Siblings arrive unresolved (the resolver only routes on the matched key), so
  // everything goes through resolveObj first. Safe to blanket-resolve here because
  // this node has no step-array siblings — Menu/Tray/Shortcut must NOT do this,
  // since their `do` and `submenu` have to reach the handler raw.
  window(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveObj(def, context, async (r) => {
      await openWindow({
        page: r.window,
        width: r.width,
        height: r.height,
        fullscreen: r.fullscreen,
        title: r.title,
      });
      return null;
    });
  }
}
