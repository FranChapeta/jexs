import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Bundle files whose bytes version the worker: the page entry and the worker runtime. */
const VERSIONED_FILES = ["client.js", "sw-runtime.js"];

/**
 * The service worker script for a listener's `sw` config. It starts the runtime
 * shipped beside it in the browser bundle, with the config inline, so a changed
 * config or a rebuilt bundle changes these bytes, which is what makes browsers
 * install the new worker. The same hash names the worker's cache.
 */
export async function serviceWorkerScript(configJson: string, browserDir: string): Promise<string> {
  const hash = createHash("sha256").update(configJson);
  for (const name of VERSIONED_FILES) {
    try {
      hash.update(await fs.promises.readFile(path.join(browserDir, name)));
    } catch {
      // Not in this bundle: nothing to version it by.
    }
  }
  const version = hash.digest("hex").slice(0, 12);
  return `import{startServiceWorker}from"./sw-runtime.js";\nstartServiceWorker(${configJson},${JSON.stringify({ version })});\n`;
}
