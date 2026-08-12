import { Node } from "@jexs/core";
import { WindowNode } from "./nodes/Window.js";
import { DialogNode } from "./nodes/Dialog.js";
import { AppNode } from "./nodes/App.js";

export { WindowNode, preloadPath, openWindow, shellTemplate } from "./nodes/Window.js";
export { DialogNode } from "./nodes/Dialog.js";
export { AppNode } from "./nodes/App.js";

export function electronNodes(_opts: { root: string } = { root: "." }): Node[] {
  return [new WindowNode(), new DialogNode(), new AppNode()];
}

export const nodes = electronNodes;
