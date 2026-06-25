/**
 * Browser resolver Web Worker entry (leaf bundle) for the `thread` node. Builds a
 * resolver from `coreNodes` plus the worker-safe lazy registrations (the SAME
 * `registerComputeLazy` the page uses — NOT the DOM/GL groups, which can't run
 * off the main thread), then runs each request's `do` steps against its `params`
 * as context and posts the result back, transferring any `ArrayBuffer` zero-copy.
 *
 * esbuild tree-shakes from here, so the bundle is core's resolver + whatever the
 * compute-lazy keys reach — no DOM, no GL. Fetched lazily, only when the first
 * `thread` step runs (see makeModuleWorker in index.ts).
 */
import { createResolver, coreNodes, runSteps, collectTransferables } from "@jexs/core";
import { registerComputeLazy } from "./registerNodes.js";

createResolver([...coreNodes]);
registerComputeLazy();

interface ThreadRequest { rid: number; steps: unknown; params: Record<string, unknown> }

self.onmessage = (e: MessageEvent) => {
  const { rid, steps, params } = e.data as ThreadRequest;
  // `params` IS the worker's context; the steps resolve against it. `.then(() =>
  // runSteps(...))` so a SYNC throw from runSteps is caught too.
  Promise.resolve()
    .then(() => runSteps(steps as unknown[], params))
    .then((result) => self.postMessage({ rid, result }, { transfer: collectTransferables(result) }))
    .catch((err: unknown) => self.postMessage({ rid, error: err instanceof Error ? err.message : String(err) }));
};
