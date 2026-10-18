import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes, Node } from "../src/index.js";

/** `$later` gives back its value a tick later, for the async path. */
class LaterNode extends Node {
  get handlerKeys() { return ["later"]; }
  resolve(def: Record<string, unknown>) {
    return new Promise(r => setTimeout(() => r(def.$later), 1));
  }
}
const resolve = createResolver([new LaterNode(), ...coreNodes()]);

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

test("a handler's options resolve when the element renders, and its steps stay steps", () => {
  const steps = [{ $setVars: { picked: { $var: "target" } } }];
  const handlers = { dragover: { target: { $var: "rows" }, preventDefault: { $var: "droppable" }, stopPropagation: { $var: "nested" }, do: steps } };
  const ctx = { rows: "li", droppable: true, nested: "false" };
  const [dragover] = eventsOf(String(resolve({ $tag: "ul", events: handlers }, ctx)));
  assert.equal(dragover.target, "li");
  assert.equal(dragover.preventDefault, true);
  assert.equal("stopPropagation" in dragover, false, "the string \"false\" is false, as everywhere");
  assert.deepEqual(dragover.do, steps);

  const [plain] = eventsOf(String(resolve({ $tag: "ul", events: handlers }, { droppable: false })));
  assert.equal("target" in plain, false, "a target that resolves to nothing is the element itself");
  assert.equal("preventDefault" in plain, false);
});

test("a map a step produced is data, its options read as they are", () => {
  const handlers = { click: { target: "li", preventDefault: true, do: [{ $var: "index" }] } };
  const [click] = eventsOf(String(resolve({ $tag: "ul", events: { $var: "handlers" } }, { handlers })));
  assert.equal(click.target, "li");
  assert.equal(click.preventDefault, true);
  assert.deepEqual(click.do, [{ $var: "index" }]);
});

test("attributes, handler options and content that arrive later all land in place", async () => {
  const html = await resolve({
    $tag: "ul",
    id: { $later: "rows" },
    events: { click: { target: { $later: "li" }, preventDefault: { $later: true }, do: [{ $var: "index" }] } },
    content: [{ $tag: "li", content: [{ $later: "a" }] }, { $tag: "input", value: { $later: "b" } }],
  }, {});
  const text = String(html);
  assert.match(text, /^<ul id="rows" data-jexs-events="[^"]*"><li>a<\/li><input value="b"><\/ul>$/);
  const [click] = eventsOf(text);
  assert.equal(click.target, "li");
  assert.equal(click.preventDefault, true);
  assert.deepEqual(click.do, [{ $var: "index" }]);

  const fromStep = await resolve({ $tag: "ul", events: { $later: { click: { target: "li", do: [] } } } }, {});
  assert.equal(eventsOf(String(fromStep))[0].target, "li", "a map a step gives later is read as data");
});

test("a target that is not a selector is an error", () => {
  assert.throws(() => resolve({ $tag: "ul", events: { click: { target: { $var: "n" }, do: [] } } }, { n: 3 }),
    /\$tag: the "click" handler's target must be a CSS selector, got 3/);
});
