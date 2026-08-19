#!/usr/bin/env node
// jexs-electron

import { app, protocol, net, BrowserWindow, globalShortcut } from "electron";
import { pathToFileURL } from "node:url";
import { existsSync, statSync, watch } from "node:fs";
import path from "node:path";
import { createResolver } from "@jexs/core";
import type { Context } from "@jexs/core";
import { loadNodePackages, entryContext, safeRelative } from "@jexs/server";
import {
  allowedKeysFor, openWindow, reopenPrimary, shellTemplate, targetWindow, windowNameOf,
  wrapPage,
} from "./nodes/Window.js";
import { hasTray } from "./nodes/Tray.js";
import { installBridge, rejectAll } from "./bridge.js";

const projectDir = process.cwd();
/** `jexs-electron --dev`: devtools on every window, and reload on template edits. */
const devMode = process.argv.includes("--dev");

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

async function main(): Promise<void> {
  // A second launch must not run a second copy: the discovered node set can
  // include a SQLite connection, a tray icon, and a listener, none of which
  // tolerate two owners. The first instance focuses instead.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  await app.whenReady();

  const nodes = await loadNodePackages(projectDir, { root: ".", env: "node" });
  const resolver = createResolver(nodes);
  const templatesDir = path.join(projectDir, "src");
  const browserDir = path.join(projectDir, "dist", "browser");

  function mainContext(win?: BrowserWindow | null, dir: string = templatesDir): Context {
    const ctx = entryContext(dir);
    if (win) {
      const name = windowNameOf(win);
      if (name) ctx.windowName = name;
      ctx.windowId = win.id;
    }
    return ctx;
  }

  protocol.handle("app", async (req) => {
    const url = new URL(req.url);
    // `?wrap=<token>` asks for the shell wrapping a page, which RESOLVES that
    // template in main. Two independent checks, because this branch executes
    // rather than serves: the token proves openWindow issued the URL (page
    // script can build one, but cannot guess a token), and safeRelative still
    // guards the name, since a page may have supplied it via `window-open` and
    // FileNode resolves with path.resolve, which honors `../`.
    const wrap = url.searchParams.get("wrap");
    if (wrap !== null) {
      const expected = wrapPage(wrap);
      const rel = safeRelative(templatesDir, url.pathname);
      if (expected === undefined || rel === null || rel !== expected) {
        return new Response("Not found", { status: 404 });
      }
      const ctx = mainContext();
      ctx._clientScript = "/client.js";
      ctx.page = rel;
      ctx.title = app.getName();
      const html = await Promise.resolve(resolver(shellTemplate(), ctx));
      return new Response(String(html), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    // Without the guard `..%2f..%2f..%2fetc/passwd` reads an arbitrary file —
    // and the scheme is registered supportFetchAPI + corsEnabled, so page script
    // could simply fetch it.
    const asset = safeRelative(browserDir, url.pathname);
    const file = asset === null ? null : path.join(browserDir, asset);
    if (file && existsSync(file) && statSync(file).isFile()) {
      return net.fetch(pathToFileURL(file).toString());
    }
    return new Response("Not found", { status: 404 });
  });

  // Everything that crosses the process boundary, in both directions.
  await installBridge({
    resolver,
    contextFor: (win) => mainContext(win),
    windowFor: (context) => targetWindow(undefined, context),
    allowedFor: (win) => allowedKeysFor(win),
  });

  if (devMode) enableDevMode(templatesDir);

  // Who survives the last window closing:
  //  - macOS always does, since its menu bar belongs to the app, not a window
  //  - a tray app always does, on every platform: minimize-to-tray is the point,
  //    and quitting here would make the tray icon unreachable the moment it
  //    became useful
  // Everything else ends with its last window.
  app.on("window-all-closed", () => {
    // A call in flight to a window that just vanished would never settle, and
    // the step sequence that issued it would hang forever.
    rejectAll("the window closed before the call completed");
    if (process.platform !== "darwin" && !hasTray()) app.quit();
  });

  // Dock click on macOS: the app is running but unreachable without a window.
  // Replays the primary window's options so a custom page or size comes back,
  // rather than a bare default.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void reopenPrimary({ title: app.getName() });
  });

  // Global shortcuts are an OS-level registration; release them explicitly.
  app.on("will-quit", () => { globalShortcut.unregisterAll(); });

  // `app/main.json` resolves against the project root (FileNode falls back to the
  // resolver root without FILE_DIR, then rebases to <proj>/app for its includes).
  if (existsSync(path.join(projectDir, "app", "main.json"))) {
    await Promise.resolve(resolver({ file: "app/main.json" }, mainContext(null, projectDir)));
  } else {
    await openWindow({ title: app.getName() });
  }
}

/** Devtools on every window, plus reload when a template changes. */
function enableDevMode(templatesDir: string): void {
  app.on("browser-window-created", (_event, win) => {
    win.webContents.openDevTools();
  });
  for (const win of BrowserWindow.getAllWindows()) win.webContents.openDevTools();

  if (!existsSync(templatesDir)) return;
  // Coalesce: an editor save often emits several events for one write, and each
  // would otherwise be its own reload.
  let pending: ReturnType<typeof setTimeout> | null = null;
  try {
    watch(templatesDir, { recursive: true }, (_type, filename) => {
      if (filename && !filename.endsWith(".json")) return;
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        for (const win of BrowserWindow.getAllWindows()) win.webContents.reload();
      }, 80);
    });
    console.log(`[jexs-electron] dev mode: watching ${templatesDir}`);
  } catch (err) {
    // Recursive watch is unsupported on some Linux setups; devtools still work.
    console.warn(`[jexs-electron] dev mode: template watching unavailable: ${String(err)}`);
  }
}

main().catch((err) => {
  console.error(err);
  app.quit();
  process.exitCode = 1;
});
