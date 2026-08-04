#!/usr/bin/env node
// jexs-electron

import { app, protocol, net, ipcMain } from "electron";
import { pathToFileURL } from "node:url";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { createResolver } from "@jexs/core";
import { loadNodePackages, entryContext } from "@jexs/server";
import { openWindow, shellTemplate } from "./nodes/Window.js";

const projectDir = process.cwd();

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

async function main(): Promise<void> {
  await app.whenReady();

  const nodes = await loadNodePackages(projectDir, { root: ".", env: "node" });
  const resolve = createResolver(nodes);
  const templatesDir = path.join(projectDir, "src");
  const browserDir = path.join(projectDir, "dist", "browser");

  protocol.handle("app", async (req) => {
    const url = new URL(req.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    // `?wrap` (added only by openWindow) asks for the shell wrapping a page
    if (url.searchParams.has("wrap")) {
      const ctx = entryContext(templatesDir);
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

  ipcMain.handle("jexs:invoke", (_event, call: unknown) =>
    Promise.resolve(resolve(call, entryContext(templatesDir))));

  const mainKeys = [...new Set(nodes.flatMap((n) => n.handlerKeys ?? []))];
  ipcMain.on("jexs:keys", (event) => { event.returnValue = mainKeys; });

  if (existsSync(path.join(projectDir, "app", "main.json"))) {
    await Promise.resolve(resolve({ file: "app/main.json" }, {}));
  } else {
    await openWindow({ title: app.getName() });
  }
}

main().catch((err) => {
  console.error(err);
  app.quit();
  process.exitCode = 1;
});
