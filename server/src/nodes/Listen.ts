import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Node, Context, NodeValue, resolveAll } from "@jexs/core";
import { Server } from "../Server.js";
import { defaultSwConfig } from "../sw.js";

/**
 * ListenNode - Starts the HTTP server from JSON.
 *
 * Usage:
 * { "listen": 3000, "do": [ ...per-request steps... ] }
 * { "listen": 3000, "client": true, "do": [...] }
 * { "listen": 3000, "client": "/assets/jexs", "do": [...] }
 *
 * When "client" is set, the server auto-serves the @jexs/client browser bundle
 * and ElementNode auto-injects the script tag into <head> elements.
 */
export class ListenNode extends Node {
  /**
   * Starts the HTTP server on the given port. Pass per-request steps in `"do"`.
   * Set `"client": true` (or a path string) to auto-serve the `@jexs/client` browser bundle
   * and inject the script tag into rendered `<head>` elements.
   * Set `"sw"` to an object to enable service worker registration.
   * @param {number} listen Port number to listen on (default `3000`).
   * @param {steps} do Per-request steps run for each incoming HTTP request.
   * @param {boolean} client Pass `true` to serve the browser bundle at `/jexs`, or a string path to use a custom route.
   * @param {number} maxBodySize Maximum request body size in bytes.
   * @param {object} sw Service worker config object. Pass `{}` to use the default config.
   * @example
   * { "listen": 3000, "client": true, "do": [{ "session": "load" }, { "routes": { "var": "$routes" } }] }
   */
  listen(def: Record<string, unknown>, context: Context): NodeValue {
    const steps = def.do;
    if (!Array.isArray(steps)) {
      console.error('[ListenNode] "do" must be an array of per-request steps');
      return null;
    }

    return resolveAll([def.listen, def.maxBodySize ?? null], context, ([portRaw, maxBodyRaw]) => {
      const port = Number(portRaw) || 3000;

      const server = context._server as Server;
      if (!server || typeof server.bind !== "function") {
        console.error("[ListenNode] No server instance found in context._server");
        return null;
      }

      if (def.maxBodySize && maxBodyRaw != null) {
        const maxBody = Number(maxBodyRaw);
        if (maxBody > 0) server.setMaxBodySize(maxBody);
      }

      // Client bundle auto-serving
      if (def.client) {
        const servePath = typeof def.client === "string" ? def.client : "/jexs";
        const browserDir = resolveClientBrowserDir();
        if (browserDir) {
          server.serveStaticDir(servePath, browserDir);
          context._clientScript = `${servePath}/client.js`;
        } else {
          console.warn("[ListenNode] @jexs/client not found — client bundle will not be served");
        }
      }

      // Service worker
      if (def.sw && typeof def.sw === "object" && !Array.isArray(def.sw)) {
        const servePath = typeof def.client === "string" ? def.client : "/jexs";
        const swConfig = Object.keys(def.sw as object).length > 0
          ? (def.sw as Record<string, unknown>)
          : defaultSwConfig(typeof context._clientScript === "string" ? context._clientScript : undefined);
        server.setSwConfig(`${servePath}/sw-config.json`, JSON.stringify(swConfig));
        context._swRegistration = `if('serviceWorker' in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('${servePath}/sw.js',{scope:'/',type:'module'}))}`;
      }

      server.bind(port, steps, context);

      // Log install URL if in installer mode
      if (context.installToken) {
        const installUrl = `${Server.getBaseUrl(port)}/install?token=${context.installToken}`;
        console.log(`\n[Install] No database configured.`);
        console.log(`[Install] Access the installer at: ${installUrl}\n`);
        fs.writeFileSync("install.txt", installUrl + "\n");
      }

      return { type: "listen", port };
    });
  }
}

function resolveClientBrowserDir(): string | null {
  try {
    const clientEntry = import.meta.resolve("@jexs/client");
    const clientDist = path.dirname(fileURLToPath(clientEntry));
    const browserDir = path.join(clientDist, "browser");
    if (fs.existsSync(browserDir)) return browserDir;
  } catch { /* not installed */ }
  return null;
}
