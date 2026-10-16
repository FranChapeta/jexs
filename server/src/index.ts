import { Node, WorkerNode } from "@jexs/core";
import { makeThreadWorker } from "./makeWorker.js";
import { CryptoNode } from "./nodes/Crypto.js";
import { FileNode } from "./nodes/File.js";
import { RouterNode } from "./nodes/Router.js";
import { SessionNode } from "./nodes/Session.js";
import { DatabaseNode } from "./nodes/Database.js";
import { DatabaseQueryNode } from "./nodes/DatabaseQuery.js";
import { DatabaseTableNode } from "./nodes/DatabaseTable.js";
import { CacheNode } from "./nodes/Cache.js";
import { TailwindNode } from "./nodes/Tailwind.js";
import { OAuthNode } from "./nodes/OAuth.js";
import { EmailNode } from "./nodes/Email.js";
import { WebPushNode } from "./nodes/WebPush.js";
import { ServerNode } from "./nodes/Server.js";
import { SchemaNode } from "./nodes/Schema.js";
import { TranslationNode } from "./nodes/Translation.js";
import { WebSocketNode } from "./nodes/WebSocket.js";
import { DeferNode } from "./nodes/Defer.js";
import { StdioNode } from "./nodes/Stdio.js";

/** Options for the {@link serverNodes} factory. */
export interface ServerNodesOptions {
  /**
   * Base directory the file-reading nodes resolve against: FileNode's templates,
   * SchemaNode's schema directories, and CryptoNode's `secret.key` fallback.
   * Defaults to `"src"`, where a Jexs project's templates live, since they are
   * its source. Pass `"."` to root at the cwd, e.g. a build script authored in
   * JSON that needs to reach `node_modules` or `package.json`.
   */
  root?: string;
}

/**
 * Server-specific nodes, built fresh per call so each set can target its own
 * `root`. Combine with coreNodes for a full resolver:
 * `[...coreNodes(), ...serverNodes()]`. Individual node classes are exported below
 * for custom wiring.
 */
export function serverNodes({ root = "src" }: ServerNodesOptions = {}): Node[] {
  return [
    new CryptoNode(root),
    new FileNode(root),
    new DeferNode(),
    new RouterNode(),
    new SessionNode(),
    new DatabaseNode(),
    new DatabaseQueryNode(),
    new DatabaseTableNode(),
    new CacheNode(),
    new TailwindNode(),
    new OAuthNode(),
    new EmailNode(),
    new WebPushNode(),
    new ServerNode(),
    new TranslationNode(),
    new SchemaNode(root),
    new WebSocketNode(),
    new StdioNode(),
    // `thread` node — runs `do` steps on a worker_threads resolver. The worker
    // re-enters resolverWorker.js (no-op on the main thread); spawned lazily on
    // the first `thread` step. `root` crosses via workerData so file ops in a
    // thread resolve against the same base as the main thread.
    new WorkerNode(makeThreadWorker(new URL("./resolverWorker.js", import.meta.url), { root })),
  ];
}

/** For node discovery: the `"jexs".nodes` manifest entry points at this module,
 *  and discovery invokes its default export with `{ root }`, since it's a factory. */
export default serverNodes;

export { makePhysicsWorker } from "./physicsWorker.js";
export { DatabaseNode } from "./nodes/Database.js";
export { DatabaseQueryNode } from "./nodes/DatabaseQuery.js";
export { DatabaseTableNode } from "./nodes/DatabaseTable.js";
export { SchemaNode } from "./nodes/Schema.js";
export { TranslationNode } from "./nodes/Translation.js";
export { WebSocketNode } from "./nodes/WebSocket.js";
export { SessionNode } from "./nodes/Session.js";
export { CryptoNode } from "./nodes/Crypto.js";
export { FileNode } from "./nodes/File.js";
export { RouterNode } from "./nodes/Router.js";
export { OAuthNode } from "./nodes/OAuth.js";
export { EmailNode } from "./nodes/Email.js";
export { WebPushNode } from "./nodes/WebPush.js";
export { ServerNode } from "./nodes/Server.js";
export { TailwindNode } from "./nodes/Tailwind.js";
export { DeferNode } from "./nodes/Defer.js";
export { CacheNode } from "./nodes/Cache.js";
export { StdioNode } from "./nodes/Stdio.js";

// What a host running an entry needs beside the nodes: FileNode's entry context
// and path check, and the nodes of every installed Jexs package, which the CLI
// and the electron runner build their resolvers from. Package discovery's other
// parts and the schema build are the CLI's own.
export { entryContext, safeRelative } from "./nodes/File.js";
export { loadNodePackages } from "./discover.js";
