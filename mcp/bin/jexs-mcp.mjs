#!/usr/bin/env node
// Hands src/index.json to the jexs CLI's `run`; the server itself is the JSON under src/.
import { fileURLToPath } from "node:url";

process.argv.splice(2, 0, "run", fileURLToPath(new URL("../src/index.json", import.meta.url)));
await import("@jexs/server/cli");
