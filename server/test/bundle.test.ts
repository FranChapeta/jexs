import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundleClient } from "../src/bundle.js";

// Inside the repo (under the gitignored scratch/), so the bundle resolves
// @jexs/client from the workspace's node_modules as a project resolves its own.
const repo = fileURLToPath(new URL("../../", import.meta.url));
await fs.mkdir(path.join(repo, "scratch"), { recursive: true });
const project = await fs.mkdtemp(path.join(repo, "scratch", "bundle-"));

after(async () => {
  await fs.rm(project, { recursive: true, force: true });
});

test("jexs bundle boots the page with every third-party browser package's nodes", async () => {
  const pkg = path.join(project, "node_modules", "fake-nodes");
  await fs.mkdir(pkg, { recursive: true });
  await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({
    name: "fake-nodes", type: "module", jexs: { nodes: "nodes.js", env: "browser" },
  }));
  await fs.writeFile(path.join(pkg, "nodes.js"), 'export default () => { console.info("fake-nodes-loaded"); return []; };\n');
  await fs.writeFile(path.join(project, "package.json"), JSON.stringify({
    name: "app", type: "module", dependencies: { "fake-nodes": "*" },
  }));

  await bundleClient(project);

  // The page and the workers it references, found through @jexs/client's subpath exports.
  const out = path.join(project, "dist", "browser");
  for (const file of ["client.js", "sw-runtime.js", "resolverWorker.js"]) {
    assert.ok(existsSync(path.join(out, file)), file);
  }

  // The page's entry, built in memory, took the package's nodes module's default
  // export, as discovery does, so its code is in what the page loads.
  const page = await fs.readFile(path.join(out, "client.js"), "utf8");
  const chunks = [...page.matchAll(/from"\.\/(chunks\/[A-Z0-9]+\.js)"/g)].map(m => m[1]);
  const loaded = [page, ...await Promise.all(chunks.map(c => fs.readFile(path.join(out, c), "utf8")))].join("");
  assert.match(loaded, /fake-nodes-loaded/);
  assert.equal(existsSync(path.join(project, ".jexs")), false, "nothing is written beside the project's sources");
});
