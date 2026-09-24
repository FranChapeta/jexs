# @jexs/gl

WebGL renderer for **Jexs** — lighting, shadows, SSAO, particles, post-processing, text, tweening, camera control.

Pairs with [@jexs/physics](https://github.com/FranChapeta/jexs/tree/master/physics) for entity-driven 3D scenes and is lazy-loaded by [@jexs/client](https://github.com/FranChapeta/jexs/tree/master/client) the first time a `gl-*` key appears in your JSON.

> Part of [Jexs](https://github.com/FranChapeta/jexs).

## Install

```bash
npm install @jexs/gl @jexs/physics @jexs/core
```

## What's inside

A single `GlNode` exposes the full renderer through JSON keys:

| Key | Purpose |
|---|---|
| `gl-init` | Set up the WebGL2 context on a canvas selector, with a clear color, depth test and an `on-frame` loop |
| `gl-destroy` | Tear down the context |
| `gl-camera` | Move / orient / look-at the camera, follow an entity, shake |
| `gl-register-mesh` | Upload an imported mesh (typically from `parseGLB`) to the GPU for instanced rendering |
| `gl-texture` `gl-atlas` `gl-font` | Load textures, sprite atlases and bitmap fonts |
| `gl-frame` | Set a static atlas frame on an entity |
| `gl-text` | Render bitmap text |
| `gl-shader` | Bind a custom shader |
| `gl-animate` `gl-tween` | Drive a per-entity animation, or tween a value with an easing function |
| `gl-tilemap` `gl-tilemap-set` | Build and edit a tilemap layer |
| `gl-trail` `gl-trail-remove` | Attach a motion trail to an entity |
| `gl-particle` | Emit a particle burst |
| `gl-transition` | Cross-fade post-process effects |
| `gl-blur` | Apply a separable Gaussian blur |
| `gl-ssao` | Toggle screen-space ambient occlusion |
| `gl-hit` `gl-raycast` | Pick an entity under the cursor, or cast a ray into the scene |

Rendering reads directly from `@jexs/physics`'s `EntityStore` — there's no scene graph to maintain; whatever's in the store is what gets drawn.

## Quick example

```json
[
  { "entity-init": "world", "width": 800, "height": 600 },
  { "gl-init": "#scene", "width": 800, "height": 600, "depth": true, "clear": [0.05, 0.06, 0.08, 1] },

  { "fetch": "/models/robot.glb", "as": "buf" },
  { "parseGLB": { "var": "$buf" }, "name": "robot", "as": "scene" },

  { "foreach": { "values": { "var": "$scene.meshes" } }, "item": "m", "do": {
    "gl-register-mesh": { "var": "$m.id" },
    "bounds":    { "var": "$m.bounds" },
    "positions": { "var": "$m.positions" },
    "normals":   { "var": "$m.normals" },
    "uvs":       { "var": "$m.uvs" },
    "indices":   { "var": "$m.indices" },
    "material":  { "var": "$m.material" }
  } },

  { "first": { "keys": { "var": "$scene.meshes" } }, "as": "meshId" },
  { "entity-add": "robot-1", "type": "mesh", "mesh": { "var": "$meshId" }, "translation": [0, 0, -5] },

  { "gl-camera": true, "z": 5, "lookAt": [0, 0, 0] }
]
```

## License

[MIT](https://github.com/FranChapeta/jexs/blob/master/LICENSE)
