import { Node, coreNodes } from "@jexs/core";
import { CryptoNode } from "./nodes/Crypto.js";
import { FileNode } from "./nodes/File.js";
import { RouterNode } from "./nodes/Router.js";
import { SessionNode } from "./nodes/Session.js";
import { DatabaseNode } from "./nodes/Database.js";
import { QueryNode } from "./nodes/Query.js";
import { CacheNode } from "./nodes/Cache.js";
import { TailwindNode } from "./nodes/Tailwind.js";
import { OAuthNode } from "./nodes/OAuth.js";
import { EmailNode } from "./nodes/Email.js";
import { ListenNode } from "./nodes/Listen.js";
import { SchemaNode } from "./nodes/Schema.js";
import { TranslationNode } from "./nodes/Translation.js";
import { WebSocketNode } from "./nodes/WebSocket.js";
import { DeferNode } from "./nodes/Defer.js";
import { StdioNode } from "./nodes/Stdio.js";

/** Server nodes — core nodes plus I/O, DB, crypto, etc. */
export const serverNodes: Node[] = [
  ...coreNodes,
  new CryptoNode(),
  new FileNode(),
  new DeferNode(),
  new RouterNode(),
  new SessionNode(),
  new DatabaseNode(),
  new QueryNode(),
  new CacheNode(),
  new TailwindNode(),
  new OAuthNode(),
  new EmailNode(),
  new ListenNode(),
  new TranslationNode(),
  new SchemaNode(),
  new WebSocketNode(),
  new StdioNode(),
];

export { Server } from "./Server.js";
export { DatabaseNode } from "./nodes/Database.js";
export { QueryNode } from "./nodes/Query.js";
export { SchemaNode } from "./nodes/Schema.js";
export { TranslationNode } from "./nodes/Translation.js";
export { WebSocketNode } from "./nodes/WebSocket.js";
export { SessionNode } from "./nodes/Session.js";
export { CryptoNode } from "./nodes/Crypto.js";
export { FileNode } from "./nodes/File.js";
export { RouterNode } from "./nodes/Router.js";
export { OAuthNode } from "./nodes/OAuth.js";
export { EmailNode } from "./nodes/Email.js";
export { ListenNode } from "./nodes/Listen.js";
export { TailwindNode } from "./nodes/Tailwind.js";
export { DeferNode } from "./nodes/Defer.js";
export { CacheNode } from "./nodes/Cache.js";
export { StdioNode } from "./nodes/Stdio.js";
export { Cache } from "./cache/Cache.js";
