import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "@jexs/core";
import { TailwindNode } from "../src/nodes/Tailwind.js";

const resolver = createResolver([...coreNodes(), new TailwindNode()]);
const page = { $tag: "div", class: "flex p-4", content: [{ $tag: "span", class: "text-sm" }] };

// The registry ops are side effects; `extract` and `classes` return the names.
test("extract returns the classes, and add, clear return nothing", async () => {
  assert.deepEqual(new Set(await resolver({ $tailwind: "extract", data: page }, {}) as string[]), new Set(["flex", "p-4", "text-sm"]));
  assert.deepEqual(await resolver({ $tailwind: "classes" }, {}), [], "extract registers nothing");

  assert.equal(await resolver({ $tailwind: "add", data: page, classes: ["grid"] }, {}), null);
  assert.deepEqual(new Set(await resolver({ $tailwind: "classes" }, {}) as string[]), new Set(["flex", "p-4", "text-sm", "grid"]));

  assert.equal(await resolver({ $tailwind: "clear" }, {}), null);
  assert.deepEqual(await resolver({ $tailwind: "classes" }, {}), []);
});
