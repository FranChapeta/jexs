import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Node, Context, NodeValue, resolve } from "@jexs/core";
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
  async listen(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const port = Number(await resolve(def.listen, context)) || 3000;
    const steps = def.do;

    if (!Array.isArray(steps)) {
      console.error('[ListenNode] "do" must be an array of per-request steps');
      return null;
    }

    const server = context._server as Server;
    if (!server || typeof server.bind !== "function") {
      console.error("[ListenNode] No server instance found in context._server");
      return null;
    }

    if (def.maxBodySize) {
      const maxBody = Number(await resolve(def.maxBodySize, context));
      if (maxBody > 0) server.setMaxBodySize(maxBody);
    }

    // Client bundle auto-serving
    if (def.client) {
      const servePath = typeof def.client === "string" ? def.client : "/jexs";
      const browserDir = this.resolveClientBrowserDir();
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
  }

  private resolveClientBrowserDir(): string | null {
    try {
      // import.meta.resolve gives us the path to @jexs/client's entry
      const clientEntry = import.meta.resolve("@jexs/client");
      const clientDist = path.dirname(fileURLToPath(clientEntry));
      const browserDir = path.join(clientDist, "browser");
      if (fs.existsSync(browserDir)) return browserDir;
    } catch { /* not installed */ }
    return null;
  }
}
