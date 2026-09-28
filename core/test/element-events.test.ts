import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

const resolve = createResolver(coreNodes());

/** The handlers an element hands the browser, from its `data-jexs-events` attribute. */
function eventsOf(html: string): Array<Record<string, unknown>> {
  const m = /data-jexs-events="([^"]*)"/.exec(html);
  assert.ok(m, "no data-jexs-events attribute");
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
}

test("an event handler's $catch reaches the browser with its steps", () => {
  const recover = [{ $setVars: { failed: { $var: "error.message" } } }];
  const html = resolve({ $tag: "button", events: { click: { do: [{ $error: 500 }], $catch: recover, preventDefault: true } } }, {});
  const [click] = eventsOf(String(html));
  assert.equal(click.type, "click");
  assert.equal(click.preventDefault, true);
  assert.deepEqual(click.$catch, recover);
});

test("a handler without $catch sends none", () => {
  const [click] = eventsOf(String(resolve({ $tag: "button", events: { click: { do: [] } } }, {})));
  assert.equal("$catch" in click, false);
});
