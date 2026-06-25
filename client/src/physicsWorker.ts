/**
 * Browser physics Web Worker entry (leaf bundle). Wires `self.onmessage` into
 * core's `runWorkerRuntime` and runs the physics `physicsSetup`. esbuild
 * tree-shakes from here, so the bundle is just core's worker runtime + what
 * `physicsStep` reaches — NO DOM, NO GL, NO client code. Fetched lazily, only
 * when a shared world registers (see physicsClient.ts).
 */
import { runWorkerRuntime } from "@jexs/core";
import { physicsSetup } from "@jexs/physics";

runWorkerRuntime(physicsSetup, (h) => { self.onmessage = (e) => h(e.data); });
