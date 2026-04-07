import { registerNode, registerLazy } from "@jexs/core";
import { Client } from "./Client.js";

export { Client, clientNodes } from "./Client.js";

// Browser: expose globally and auto-init on DOMContentLoaded
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).Jexs = Client;
  const client = new Client();
  (window as unknown as Record<string, unknown>).jexs = client;

  registerLazy(
    ["tree-init", "tree-insert", "tree-remove", "tree-update", "tree-move"],
    () => import("./TreeNode.js").then(({ TreeNode, setInitEvents }) => {
      setInitEvents((root) => client.initEvents(root));
      registerNode(new TreeNode());
    }),
  );

  registerLazy(
    ["list-add", "list-remove", "list-move-up", "list-move-down", "list-init", "list-sortable", "list-serialize"],
    () => import("./ListNode.js").then(({ ListNode, setInitEvents }) => {
      setInitEvents((root) => client.initEvents(root));
      registerNode(new ListNode());
    }),
  );

  registerLazy(
    ["ws-connect", "ws-send", "ws-close"],
    () => import("./WsNode.js").then(({ WsNode }) => {
      registerNode(new WsNode());
    }),
  );

  registerLazy(
    ["rtc"],
    () => import("./WebRTCNode.js").then(({ WebRTCNode }) => {
      registerNode(new WebRTCNode());
    }),
  );

  registerLazy(
    ["gl-init", "gl-destroy", "gl-hit", "gl-camera", "gl-texture", "gl-animate",
     "gl-text", "gl-shader", "gl-blur", "gl-transition", "gl-tween", "gl-ssao"],
    () => import("@jexs/gl").then(({ GlNode }) => {
      registerNode(new GlNode());
    }),
  );

  registerLazy(
    ["entity-init", "entity-add", "entity-remove", "entity-move", "entity-update",
     "entity-clear", "entity-list", "entity-nearest", "entity-get",
     "v-distance", "v-lerp", "v-toward", "v-normalize", "v-scale",
     "v-add", "v-sub", "v-direction", "v-cross", "v-dot",
     "physics-init", "physics-pause", "physics-resume", "physics-destroy", "physics-apply", "physics-step",
     "collision-on", "collision-off",
     "joint-add", "joint-remove"],
    () => import("@jexs/physics").then(({ EntityNode, VectorNode, PhysicsNode, CollisionNode, JointNode }) => {
      registerNode(new EntityNode());
      registerNode(new VectorNode());
      registerNode(new PhysicsNode());
      registerNode(new CollisionNode());
      registerNode(new JointNode());
    }),
  );

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => client.initEvents());
  } else {
    client.initEvents();
  }
}
