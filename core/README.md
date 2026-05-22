# @jexs/core

The resolver engine and pure-logic nodes for **Jexs** — a JSON expression system where every UI, route, or value is just JSON, interpreted at runtime by typed `Node` classes.

This package is environment-agnostic (no DOM, no Node.js APIs) and is the foundation every other `@jexs/*` package builds on.

> Part of [Jexs](https://github.com/FranChapeta/jexs).

## Install

```bash
npm install @jexs/core
```

## What's inside

**Resolver** — `createResolver(nodes)` returns a `resolve(value, context)` function that walks JSON, dispatches on object keys, and threads a per-call context. Sync-first: no `Promise` is created unless an async node actually appears in the tree.

**Core nodes** (`coreNodes`):

| Node | Keys | Purpose |
|---|---|---|
| `VariablesNode` | `var`, `setVars` | Read/write context by dot-path |
| `LogicNode` | `if`, `switch`, `foreach`, `and`, `or`, `not`, `eq`, `lt`, `gt`, ... | Branching, iteration, comparisons |
| `ElementNode` | `tag` | Render an HTML element tree to a string |
| `StringNode` | `concat`, `replace`, `split`, `trim`, ... | String ops |
| `ArrayNode` | `map`, `filter`, `length`, `join`, `sort`, ... | Array ops |
| `MathNode` | `sum`, `avg`, `min`, `max`, `clamp`, `random`, ... | Numeric ops |
| `DateNode` | `now`, `date-format`, `date-add`, ... | Dates |
| `TimerNode` | `setTimeout`, `setInterval`, `clearTimer` | Timing |
| `ErrorNode` | `error` | Throw `{ status, message }` HTTP errors |

## Quick example

```ts
import { createResolver, coreNodes } from "@jexs/core";

const resolve = createResolver(coreNodes);

const ctx = { user: { name: "Ada" } };

resolve({ concat: ["Hello, ", { var: "$user.name" }, "!"] }, ctx);
// → "Hello, Ada!"

resolve({
  if: { var: "$user.name" },
  then: { concat: ["Welcome back, ", { var: "$user.name" }] },
  else: "Sign in"
}, ctx);
// → "Welcome back, Ada"
```

## Extending — write your own node

```ts
import { Node, type Context, createResolver, coreNodes } from "@jexs/core";

class UpperNode extends Node {
  upper(def: Record<string, unknown>, _ctx: Context) {
    return String(def.upper).toUpperCase();
  }
}

const resolve = createResolver([...coreNodes, new UpperNode()]);
resolve({ upper: "hello" }, {}); // → "HELLO"
```

The method name `upper` becomes the dispatch key — any JSON object with an `upper` field will route to that handler.

## License

[MIT](https://github.com/FranChapeta/jexs/blob/master/LICENSE)
