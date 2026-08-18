// ── Node system ──
export { Node, childContext, type Context, type NodeValue } from "./nodes/Node.js";

// ── Schema types ──
export type {
  JexsType, JexsOutput, JexsPropertySchema, JexsMethodSchema, JexsNodeSchema,
} from "./schema.js";

export {
  buildPackageSchema, mergePackageSchemas,
  type PackageSchema, type CombinedSchema, type EmittedSchema,
  type EmittedMethodSchema, type EmittedNodeSchema, type SchemaBuildOptions,
} from "./schema-gen.js";

// ── Resolver ──
export {
  createResolver, resolve, resolveAll, resolveObj, registerNode, registerLazy,
  runSteps, resolveSteps, handleErr, runStepsDetached,
  type ResolverFn, type Resolver, type ResolverKeys,
} from "./Resolver.js";

// ── Error utilities ──
export { createHttpError, isHttpError } from "./errors.js";

// ── Core nodes ──
export { TimerNode } from "./nodes/Timer.js";
export { FetchNode } from "./nodes/FetchNode.js";

// Dynamic forwarder — construct with (keys, forwardFn) and registerNode() it to
// proxy those keys to a remote resolver (e.g. Electron main over IPC). Not a
// default coreNode; instantiated on-demand by the host.
export { ProxyNode } from "./nodes/Proxy.js";

import { Node } from "./nodes/Node.js";
import { VariablesNode } from "./nodes/Variables.js";
import { ElementNode } from "./nodes/Element.js";
import { LogicNode } from "./nodes/Logic.js";
import { StringNode } from "./nodes/Strings.js";
import { ArrayNode } from "./nodes/Arrays.js";
import { ObjectNode } from "./nodes/Object.js";
import { MathNode } from "./nodes/Math.js";
import { ColorNode } from "./nodes/Color.js";
import { TimerNode } from "./nodes/Timer.js";
import { DateNode } from "./nodes/Date.js";

import { ErrorNode } from "./nodes/Error.js";
import { FetchNode } from "./nodes/FetchNode.js";

/** Core nodes — pure logic plus global-fetch HTTP; no DOM or Node.js APIs. Safe for browser, server, and workers. */
export const coreNodes: Node[] = [
  new VariablesNode(),
  new ElementNode(),
  new LogicNode(),
  new StringNode(),
  new ArrayNode(),
  new ObjectNode(),
  new MathNode(),
  new ColorNode(),
  new TimerNode(),
  new DateNode(),
  new ErrorNode(),
  new FetchNode(),
];

/** Discovery alias: the `"jexs".nodes` manifest entry points at this module, and
 *  node discovery consumes `mod.default ?? mod.nodes`. Same instances as {@link coreNodes}. */
export const nodes = coreNodes;

// ── Step runner ──
// (runSteps and resolveSteps are already exported above via Resolver.js)

// ── Helpers ──
export { randomString, collectTransferables } from "./helpers.js";

// ── Generic worker offload (run units over SABs; one worker, many units) ──
// The SAB/Atomics control-block handshake is private to this module; only the
// high-level offload API is public.
export {
  runOnWorker, runWorkerRuntime,
  type WorkerLike, type WorkerStepper, type WorkerSetup, type WorkerMsg, type Subscribe,
} from "./workerRuntime.js";

// ── Worker pool + the `thread` node (run resolver steps on another thread) ──
// The pool itself (lazy-per-key + idle reaping) is internal: runOnWorker and
// WorkerNode ride on it, and nothing outside core drives it directly. Only the
// worker shape a host must supply is public — the env worker constructor is
// passed to `new WorkerNode(makeWorker)` in the client/server entry.
export { type TaskWorkerLike } from "./workerPool.js";
export { WorkerNode } from "./nodes/Worker.js";
