import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, Node } from "../src/index.js";

/** `$pick` reads its value as one of a list whose spellings mix capitals. */
class PickNode extends Node {
  static schema = { pick: { type: "string" as const, output: "string" as const } };
  pick(def: Record<string, unknown>): unknown {
    return this.getOption(def.$pick, ["listen", "closeAll", "GET"], "pick");
  }
}

// An option is spelled exactly as listed, as the schema's `enum` checks it.
test("getOption takes an option spelled as listed, and refuses any other spelling", () => {
  const resolve = createResolver([new PickNode()]);
  assert.equal(resolve({ $pick: "closeAll" }, {}), "closeAll");
  assert.equal(resolve({ $pick: "GET" }, {}), "GET");
  assert.equal(resolve({ $pick: null }, {}), undefined);
  for (const wrong of ["closeall", "get", "close-all", ""]) {
    assert.throws(() => resolve({ $pick: wrong }, {}), new RegExp(`Invalid pick "${wrong}": expected listen, closeAll, GET`));
  }
});
