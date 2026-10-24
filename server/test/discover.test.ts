import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadNodePackages } from "../src/discover.js";

const dirs: string[] = [];
after(async () => {
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
});

/** A project depending on one node package, `fake-nodes`, whose `nodes` entry is `source`. */
async function projectWith(source: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jexs-discover-"));
  dirs.push(dir);
  const pkg = path.join(dir, "node_modules", "fake-nodes");
  await fs.mkdir(pkg, { recursive: true });
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: { "fake-nodes": "*" } }));
  await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({ name: "fake-nodes", type: "module", jexs: { nodes: "nodes.js", env: "node" } }));
  await fs.writeFile(path.join(pkg, "nodes.js"), source);
  return dir;
}

// A package that cannot load stops the load, naming it, rather than leaving its
// ops to fail later as unknown ones.
test("a node package that fails to load stops the load, naming it", async () => {
  const throws = await projectWith('throw new Error("boom");');
  await assert.rejects(loadNodePackages(throws, { root: ".", env: "node" }), /could not load nodes from "fake-nodes": boom/);

  const notNodes = await projectWith("export default 5;");
  await assert.rejects(loadNodePackages(notNodes, { root: ".", env: "node" }), /could not load nodes from "fake-nodes": nodes\.js's default export gives number, not an array of nodes/);

  const loads = await projectWith("export default () => [];");
  assert.deepEqual(await loadNodePackages(loads, { root: ".", env: "node" }), []);
});
