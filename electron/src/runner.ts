#!/usr/bin/env node
// jexs-electron

import { app, protocol, net, ipcMain, BrowserWindow, globalShortcut } from "electron";
import { pathToFileURL } from "node:url";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { createResolver } from "@jexs/core";
import type { Context } from "@jexs/core";
import { loadNodePackages, entryContext } from "@jexs/server";
import { openWindow, reopenPrimary, shellTemplate, windowNameOf } from "./nodes/Window.js";

const projectDir = process.cwd();

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
  const resolve = createResolver(nodes);
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
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    // `?wrap` (added only by openWindow) asks for the shell wrapping a page
    if (url.searchParams.has("wrap")) {
      const ctx = mainContext();
      ctx._clientScript = "/client.js";
      ctx.page = rel || "index.json";
      ctx.title = app.getName();
      const html = await Promise.resolve(resolve(shellTemplate(), ctx));
      return new Response(String(html), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    const file = path.join(browserDir, rel);
    if (existsSync(file) && statSync(file).isFile()) {
      return net.fetch(pathToFileURL(file).toString());
    }
    return new Response("Not found", { status: 404 });
  });

  // The sender's window becomes the implicit target, so a page can say
  // { "window-close": true } and mean its own window.
  ipcMain.handle("jexs:invoke", (event, call: unknown) =>
    Promise.resolve(resolve(call, mainContext(BrowserWindow.fromWebContents(event.sender)))));

  const mainKeys = [...new Set(nodes.flatMap((n) => n.handlerKeys ?? []))];
  ipcMain.on("jexs:keys", (event) => { event.returnValue = mainKeys; });

  // macOS keeps the app (and its menu bar) alive with no windows open; every
  // other platform expects the last window to end the process. Phase 3 makes
  // this conditional on an active tray, which must outlive its windows.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
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
    await Promise.resolve(resolve({ file: "app/main.json" }, mainContext(null, projectDir)));
  } else {
    await openWindow({ title: app.getName() });
  }
}

main().catch((err) => {
  console.error(err);
  app.quit();
  process.exitCode = 1;
});
