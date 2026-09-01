import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Node } from "../src/index.js";

/**
 * Every op a node dispatches on must be exactly the set its `static schema`
 * declares — no more, no less.
 *
 * `handlerKeys` discovers ops by scraping the class prototype, so any method
 * declared in a node's body becomes a live dispatch key. TypeScript's `private`
 * is erased and gives no protection: a private helper silently claims an op
 * name, and can shadow a real op owned by another node (`pause` belongs to
 * AudioNode, so a private `pause()` on any other node would fight it). That is
 * why node helpers live at module scope and take the instance as a parameter.
 *
 * This runs over `dist/nodes` rather than the sources because it is the built
 * output the resolver and `build:schema` actually load, and because it reaches
 * every package from one place.
 */

const REPO = path.resolve(import.meta.dirname, "..", "..");
const PACKAGES = ["core", "client", "server", "electron", "gl", "physics"];

interface NodeClass {
  new (): Node;
  schema?: Record<string, unknown>;
}

/** Node classes under a package's `dist/nodes`, by `<package>/<ClassName>`. */
async function nodeClasses(pkg: string): Promise<Map<string, NodeClass>> {
  const found = new Map<string, NodeClass>();
  const dir = path.join(REPO, pkg, "dist", "nodes");
  if (!existsSync(dir)) return found;

  for (const file of readdirSync(dir).filter(f => f.endsWith(".js"))) {
    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(path.join(dir, file)).href)) as Record<string, unknown>;
    } catch {
      // A node module whose optional peer is absent (electron, knex) cannot be
      // imported here. tsc already type-checks it; skip rather than fail.
      continue;
    }
    for (const [name, exported] of Object.entries(mod)) {
      // Own `schema` only: an abstract base would otherwise match via the
      // prototype chain and be checked once per subclass.
      if (typeof exported !== "function" || !exported.prototype) continue;
      if (!Object.prototype.hasOwnProperty.call(exported, "schema")) continue;
      found.set(`${pkg}/${name}`, exported as NodeClass);
    }
  }
  return found;
}

test("every node's handler keys are exactly its schema keys", async () => {
  const mismatches: string[] = [];
  let checked = 0;

  for (const pkg of PACKAGES) {
    for (const [id, Cls] of await nodeClasses(pkg)) {
      let node: Node;
      try {
        node = new Cls();
      } catch {
        continue; // needs constructor args; covered by its own package's tests
      }

      // A node that overrides `handlerKeys` owns its key set deliberately and is
      // not derived from the schema (ProxyNode's set is dynamic, built from a
      // remote peer's announcement).
      const proto = Object.getPrototypeOf(node) as object;
      if (Object.getOwnPropertyDescriptor(proto, "handlerKeys")) continue;

      checked++;
      const keys = new Set(node.handlerKeys ?? []);
      const declared = new Set(Object.keys(Cls.schema ?? {}));

      const extra = [...keys].filter(k => !declared.has(k)).sort();
      const missing = [...declared].filter(k => !keys.has(k)).sort();

      if (extra.length) {
        mismatches.push(
          `${id}: dispatches on ${extra.join(", ")} but does not declare ${extra.length > 1 ? "them" : "it"}. ` +
          `Move the helper to module scope, or add a schema entry if it is a real op.`,
        );
      }
      if (missing.length) {
        mismatches.push(
          `${id}: declares ${missing.join(", ")} but has no handler, so the op never dispatches.`,
        );
      }
    }
  }

  assert.equal(mismatches.join("\n"), "", `\n${mismatches.join("\n")}\n`);
  assert.ok(checked > 40, `expected to check the full node set, only reached ${checked} classes`);
});

test("dispose is not a dispatch key", () => {
  // `dispose?(): void` on Node is a bodiless declaration, so TypeScript emits
  // nothing and it is absent from Node.prototype — leaving every node that
  // implements it to register `dispose` as an op. nodeProtoKeys names it by hand.
  class Disposable extends Node {
    static schema = { widget: {} };
    widget() { return null; }
    dispose() { /* no-op */ }
  }
  assert.deepEqual([...(new Disposable().handlerKeys ?? [])], ["widget"]);
});
