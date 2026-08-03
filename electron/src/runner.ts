#!/usr/bin/env node
// jexs-electron

import { app, protocol, net, ipcMain } from "electron";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
import { createResolver } from "@jexs/core";
import { loadNodePackages, entryContext } from "@jexs/server";
import { openWindow } from "./nodes/Window.js";

const projectDir = process.cwd();

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

async function main(): Promise<void> {
  await app.whenReady();

  const browserDir = path.join(projectDir, "dist", "browser");
  protocol.handle("app", (req) => {
    let rel = decodeURIComponent(new URL(req.url).pathname);
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = path.join(browserDir, rel);
    return net.fetch(pathToFileURL(file).toString());
  });

  const nodes = await loadNodePackages(projectDir, { root: ".", env: "node" });
  const resolve = createResolver(nodes);

  const templatesDir = path.join(projectDir, "src");
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
