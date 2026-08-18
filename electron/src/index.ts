import { Node } from "@jexs/core";
import { WindowNode } from "./nodes/Window.js";
import { DialogNode } from "./nodes/Dialog.js";
import { AppNode } from "./nodes/App.js";
import { MenuNode } from "./nodes/Menu.js";
import { TrayNode } from "./nodes/Tray.js";
import { ShortcutNode } from "./nodes/Shortcut.js";
import { ShellNode } from "./nodes/Shell.js";
import { NotificationNode } from "./nodes/Notification.js";

export { WindowNode, preloadPath, openWindow, shellTemplate } from "./nodes/Window.js";
export { DialogNode } from "./nodes/Dialog.js";
export { AppNode } from "./nodes/App.js";
export { MenuNode } from "./nodes/Menu.js";
export { TrayNode } from "./nodes/Tray.js";
export { ShortcutNode } from "./nodes/Shortcut.js";
export { ShellNode } from "./nodes/Shell.js";
export { NotificationNode } from "./nodes/Notification.js";

export function electronNodes(_opts: { root: string } = { root: "." }): Node[] {
  return [
    new WindowNode(),
    new DialogNode(),
    new AppNode(),
    new MenuNode(),
    new TrayNode(),
    new ShortcutNode(),
    new ShellNode(),
    new NotificationNode(),
  ];
}

export const nodes = electronNodes;
