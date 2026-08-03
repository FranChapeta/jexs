import { Node, Context, NodeValue } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";
import { fileURLToPath } from "node:url";

/** Absolute path to the shipped CJS preload. Compiled to dist/nodes/Window.js,
 *  so preload.cjs sits two levels up at the package root. */
export function preloadPath(): string {
  return fileURLToPath(new URL("../../preload.cjs", import.meta.url));
}

/**
 * Open a BrowserWindow loading the app's bundle over `app://`. Shared by the
 * runner (the initial window — boilerplate every app needs) and WindowNode
 * (renderer-requested windows). Options: width, height, fullscreen, title, page.
 */
export async function openWindow(opts: Record<string, unknown> = {}): Promise<void> {
  const { BrowserWindow } = await import("electron");
  const win = new BrowserWindow({
    width: typeof opts.width === "number" ? opts.width : 1280,
    height: typeof opts.height === "number" ? opts.height : 720,
    fullscreen: !!opts.fullscreen,
    title: typeof opts.title === "string" ? opts.title : undefined,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      sandbox: true,
    },
  });
  const page = typeof opts.page === "string" ? opts.page : "index.html";
  await win.loadURL(`app://local/${page}`);
}

/** Open a secondary BrowserWindow — `{ "window": "<page.html>", ...opts }`. */
export class WindowNode extends Node {
  static schema: JexsNodeSchema = {
    window: {
      type: "string",
      output: "null",
      markdownDescription:
        "Open a BrowserWindow showing a built page over `app://` — the value is the page (a `dist/browser/*.html`, default `index.html`; author extra pages as `src/*.json`). Size and title are siblings. The runner opens the first window automatically; use this for secondary windows.",
      examples: ["{ \"window\": \"settings.html\", \"width\": 480, \"height\": 320 }"],
      siblings: {
        width: { type: "number", description: "Window width in pixels." },
        height: { type: "number", description: "Window height in pixels." },
        fullscreen: { type: "boolean", description: "Open the window fullscreen." },
        title: { type: "string", description: "Window title." },
      },
    },
  };

  async window(def: Record<string, unknown>, _context: Context): Promise<NodeValue> {
    await openWindow({
      page: def.window,
      width: def.width,
      height: def.height,
      fullscreen: def.fullscreen,
      title: def.title,
    });
    return null;
  }
}
