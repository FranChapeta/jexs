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

/** Markup whose `mount` handler marks `label` and bubbles it into the app's context as `who`. */
const mounting = (label: string) =>
  `data-jexs-events='${JSON.stringify([{ type: "mount", do: [{ $mark: label }, { $setVars: { who: label }, $bubble: true }] }])}'`;

test("importing the client starts nothing; boot() does, with the nodes it is given", async () => {
  // A `mount` handler that uses the app's op, on the page before it boots.
  window.document.body.innerHTML = `<div ${mounting("loaded")}></div>`;

  const { boot } = await import("../src/index.js");
  const g = window as unknown as Record<string, unknown>;
  assert.equal(g.jexs, undefined, "importing alone builds no resolver");

  const mark = new MarkNode();
  const app = boot({ nodes: [mark], serviceWorker: false });

  // The nodes were registered before hydrating, so the `mount` handler found its op,
  // and what it bubbled is the app's own state.
  assert.deepEqual(mark.seen, ["loaded"]);
  assert.equal(app.context.who, "loaded");

  // The page's handle is the app boot returned, with core's nodes and the app's.
  assert.equal(g.jexs, app);
  assert.equal(await app.resolver({ $concat: ["a", "b"] }, {}), "ab");
  await app.resolver({ $mark: "again" }, {});
  assert.deepEqual(mark.seen, ["loaded", "again"]);

  assert.throws(() => boot({ serviceWorker: false }), /already has a global app \(window\.jexs\): boot a second one with `global: false`/);
});

// Two apps on one page each hydrate their own part of it, into their own state.
test("a second app boots with global: false, on a root of its own", async () => {
  const { boot } = await import("../src/index.js");
  const widget = window.document.createElement("section");
  widget.innerHTML = `<div ${mounting("widget")}></div>`;
  window.document.body.append(widget);

  const mark = new MarkNode();
  const second = boot({ nodes: [mark], root: widget as unknown as Element, global: false, serviceWorker: false });
  assert.deepEqual(mark.seen, ["widget"], "only its own root hydrated");
  assert.equal(second.context.who, "widget");

  const first = (window as unknown as { jexs: { context: Record<string, unknown> } }).jexs;
  assert.equal(first.context.who, "loaded", "the page's app keeps its own state");
  assert.notEqual(second.context, first.context);
});
