import { test } from "node:test";
import assert from "node:assert/strict";
import { Node } from "@jexs/core";
import { installDom } from "./dom.js";

const window = installDom();

/** An app's own node, recording what its op is handed. */
class MarkNode extends Node {
  readonly seen: unknown[] = [];
  mark(def: Record<string, unknown>): null {
    this.seen.push(def.$mark);
    return null;
  }
}

test("importing the client starts nothing; boot() does, with the nodes it is given, once", async () => {
  // A `load` handler that uses the app's op, on the page before it boots.
  window.document.body.innerHTML =
    `<div data-jexs-events='${JSON.stringify([{ type: "load", do: [{ $mark: "loaded" }] }])}'></div>`;

  const { boot } = await import("../src/index.js");
  const g = window as unknown as Record<string, unknown>;
  assert.equal(g.jexs, undefined, "importing alone builds no resolver");
  assert.equal(window.document.querySelector("[data-jexs-events-bound]"), null, "and hydrates nothing");

  const mark = new MarkNode();
  const resolver = boot({ nodes: [mark] });

  // The nodes were registered before hydrating, so the `load` handler found its op.
  assert.deepEqual(mark.seen, ["loaded"]);
  assert.ok(window.document.querySelector("[data-jexs-events-bound]"));

  // The page's handle carries the same resolver boot returned, with core's nodes and the app's.
  const handle = g.jexs as { resolver: unknown };
  assert.equal(handle.resolver, resolver);
  assert.equal(await resolver({ $concat: ["a", "b"] }, {}), "ab");
  await resolver({ $mark: "again" }, {});
  assert.deepEqual(mark.seen, ["loaded", "again"]);

  assert.throws(() => boot(), /already booted: boot\(\) runs once/);
});
