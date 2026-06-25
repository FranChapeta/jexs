import type { WorkerLike } from "@jexs/core";
import { makeModuleWorker } from "./makeWorker.js";

/** Returns an env worker constructor bound to the physicsWorker bundle `url`.
 *  Thin wrapper over the shared `makeModuleWorker` (the physics node wants a
 *  `WorkerLike`; the browser `Worker` satisfies it). */
export function makePhysicsWorker(url: URL | string): () => WorkerLike {
  return makeModuleWorker(url);
}
