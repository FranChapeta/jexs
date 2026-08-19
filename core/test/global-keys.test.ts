import { test } from "node:test";
import assert from "node:assert/strict";
import { GLOBAL_KEYS } from "../src/index.js";
import { GLOBAL_KEY_DOCS } from "../src/schema-gen.js";

// The same five keys are held twice: GLOBAL_KEYS is the runtime set the resolver
// dispatches on, GLOBAL_KEY_DOCS is the prose schema-gen emits for autocomplete.
// Two sources of truth for one concept, so pin them together -- adding a sixth
// key to one and not the other would either lose its documentation or, worse,
// let it be treated as a node op.
test("the runtime key set and its documentation cover exactly the same keys", () => {
  assert.deepEqual([...GLOBAL_KEYS].sort(), Object.keys(GLOBAL_KEY_DOCS).sort());
});

test("every global key has a description", () => {
  for (const key of GLOBAL_KEYS) {
    const doc = (GLOBAL_KEY_DOCS as Record<string, { markdownDescription?: string }>)[key];
    assert.ok(doc?.markdownDescription, `"${key}" has no markdownDescription`);
  }
});
