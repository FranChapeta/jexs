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
import { createResolver, coreNodes, collectTransferables } from "@jexs/core";
import { registerComputeLazy } from "./registerNodes.js";

const resolver = createResolver(coreNodes());
registerComputeLazy(resolver);

interface ThreadRequest { rid: number; steps: unknown; params: Record<string, unknown> }

self.onmessage = (e: MessageEvent) => {
  const { rid, steps, params } = e.data as ThreadRequest;
  // `params` IS the worker's context; the steps resolve against it. Going through
  // the resolver rather than the free `runSteps` is what adopts this context —
  // `params` arrives over postMessage, and structured clone drops the symbol that
  // carries the resolver. `.then(() => ...)` so a SYNC throw is caught too.
  Promise.resolve()
    .then(() => resolver.runSteps(steps as unknown[], params))
    .then((result) => self.postMessage({ rid, result }, { transfer: collectTransferables(result) }))
    .catch((err: unknown) => self.postMessage({ rid, error: err instanceof Error ? err.message : String(err) }));
};
