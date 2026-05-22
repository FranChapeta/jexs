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
| `gl-init` | Set up the WebGL2 context, attach to a canvas, configure shadows/SSAO/post |
| `gl-destroy` | Tear down the context |
| `gl-camera` | Move / orient / look-at the camera |
| `gl-register-mesh` | Register a mesh (typically from `parseGLB`) for instanced rendering |
| `gl-texture` | Load and bind a texture |
| `gl-text` | Render bitmap text in 3D space |
| `gl-shader` | Bind a custom shader |
| `gl-animate` | Drive a per-entity animation |
| `gl-tween` | Tween a value with an easing function |
| `gl-transition` | Cross-fade post-process effects |
| `gl-blur` | Apply a separable Gaussian blur |
| `gl-ssao` | Toggle screen-space ambient occlusion |
| `gl-hit` | Pick an entity under the cursor (mouse/touch raycast) |

Rendering reads directly from `@jexs/physics`'s `EntityStore` — there's no scene graph to maintain; whatever's in the store is what gets drawn.

## Quick example

```json
[
  { "entity-init": { "capacity": 5000 } },
  { "gl-init": {
    "canvas": "#scene",
    "shadows": true,
    "ssao": true,
    "fog": { "color": [0.5, 0.6, 0.7], "density": 0.02 }
  } },

  { "parseGLB": "/models/robot.glb", "as": "robot" },
  { "gl-register-mesh": { "var": "$robot" } },

  { "entity-add": { "mesh": "robot", "position": [0, 0, -5] } },

  { "gl-camera": { "position": [0, 2, 5], "lookAt": [0, 0, 0] } }
]
```

## License

[MIT](https://github.com/FranChapeta/jexs/blob/master/LICENSE)
