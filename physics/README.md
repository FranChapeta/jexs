# @jexs/physics

Entity store, physics simulation, collision detection, raycasting, vectors, and GLB/GLTF mesh loading for **Jexs**.

Environment-agnostic — runs in browser or Node.js. Used by [@jexs/gl](https://github.com/FranChapeta/jexs/tree/master/gl) for rendering and by [@jexs/client](https://github.com/FranChapeta/jexs/tree/master/client) for in-browser physics.

> Part of [Jexs](https://github.com/FranChapeta/jexs).

## Install

```bash
npm install @jexs/physics @jexs/core
```

## What's inside

**EntityStore** — TypedArray-backed contiguous TRS layout (translation / rotation as quaternion / scale, plus velocity, mass, friction, color, UV, flags). Cache-friendly, GC-free for the hot loop.

**Nodes**:

| Node | Keys | Purpose |
|---|---|---|
| `EntityNode` | `entity-init`, `entity-add`, `entity-remove`, `entity-move`, `entity-update`, `entity-list`, `entity-nearest`, `entity-get`, `entity-clear` | Manage entities |
| `PhysicsNode` | `physics-init`, `physics-step`, `physics-pause`, `physics-resume`, `physics-apply`, `physics-destroy` | Fixed-timestep simulation |
| `CollisionNode` | `collision-on`, `collision-off` | Register collision handlers |
| `JointNode` | `joint-add`, `joint-remove` | Constraints between entities |
| `VectorNode` | `v-distance`, `v-lerp`, `v-toward`, `v-normalize`, `v-scale`, `v-add`, `v-sub`, `v-direction`, `v-cross`, `v-dot` | Vector math |
| `MeshNode` | `parseGLB`, `parseGLTF`, `register-mesh` | Load 3D meshes; auto-builds a BVH |

**Utilities** — `physicsStep`, `applyImpulse`, `wakeBody`, `raycastStore`, `rayAABB`, `buildBvh`, `queryAabb`, `raycastBvh`, `rayTriangle`, `computeBounds`.

## Quick example

```json
[
  { "entity-init": { "capacity": 1000 } },
  { "physics-init": { "gravity": [0, -9.8, 0] } },

  { "entity-add": { "id": "ball",  "position": [0, 10, 0], "mass": 1, "restitution": 0.8 } },
  { "entity-add": { "id": "floor", "position": [0, 0, 0], "mass": 0, "fixed": true } },

  { "collision-on": "ball", "do": [
    { "console-log": "Bounce!" }
  ] },

  { "physics-step": { "dt": 0.016 } }
]
```

## Using directly from TypeScript

```ts
import { EntityStore, physicsStep, F_TY } from "@jexs/physics";

const store = new EntityStore(1000);
const id = store.add({ position: [0, 10, 0], mass: 1 });

physicsStep(store, 0.016, { gravity: [0, -9.8, 0] });

console.log(store.data[id * store.stride + F_TY]); // current Y
```

## License

[MIT](https://github.com/FranChapeta/jexs/blob/master/LICENSE)
