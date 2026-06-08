import { test } from "node:test";
import assert from "node:assert/strict";
import { createResolver, coreNodes } from "../src/index.js";

// Use the function returned by createResolver (the entry resolver an app calls),
// not the exported `resolve` wrapper — top-level catch must work here too.
const resolve = createResolver(coreNodes);

test("catch: handles a top-level thrown error and exposes $error as { status, message }", () => {
  const out = resolve(
    {
      if: true,
      then: { error: 403, message: "Permission denied" },
      catch: [{ concat: ["caught ", { var: "$error.status" }, ": ", { var: "$error.message" }] }],
    },
    {},
  );
  assert.equal(out, "caught 403: Permission denied");
});

test("catch: untriggered when nothing throws", () => {
  const out = resolve(
    { if: { eq: [1, 1] }, then: "ok", catch: [{ var: "$error.message" }] },
    {},
  );
  assert.equal(out, "ok");
});
