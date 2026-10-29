# @jexs/core

The resolver engine and pure-logic nodes for **Jexs** — a JSON expression system where every UI, route, or value is just JSON, interpreted at runtime by typed `Node` classes.

This package is environment-agnostic (no DOM, no Node.js APIs) and is the foundation every other `@jexs/*` package builds on.

> Part of [Jexs](https://github.com/FranChapeta/jexs).

## Install

```bash
npm install @jexs/core
```

## What's inside

**Resolver** — `createResolver(nodes)` returns a function that runs a template in a context, the way a template file is read: an array is a sequence of steps (the last step's value is the result), anything else one expression. Each step dispatches on its `$` key. Sync-first: no `Promise` is created unless an async node actually appears in the tree.

**Core nodes** (`coreNodes`):

| Node | Keys | Purpose |
|---|---|---|
| `VariablesNode` | `var`, `setVars`, `runVar` | Read/write context by dot-path, and run steps held in a variable |
| `LogicNode` | `if`, `switch`, `foreach`, `and`, `or`, `not`, `eq`, `lt`, `gt`, ... | Branching, iteration, comparisons |
| `ElementNode` | `tag`, `html` | Render an HTML element tree, escaping its text; trust a string as markup |
| `StringNode` | `concat`, `replace`, `split`, `trim`, `length`, `match`, `randomString`, ... | String ops |
| `ArrayNode` | `map`, `filter`, `reduce`, `sort`, `count`, `join`, `range`, ... | Array ops |
| `ObjectNode` | `keys`, `values`, `entries`, `pick`, `omit`, `merge`, `groupBy`, `fromEntries`, ... | Object ops |
| `MathNode` | `add`, `avg`, `min`, `max`, `clamp`, `randomNumber`, `parseInt`, ... | Numeric ops |
| `ColorNode` | `toRgb`, `toHex`, `lighten`, `darken`, `mix`, `contrast`, ... | Color ops |
| `DateNode` | `dateNow`, `dateFormat`, `dateAdd`, `dateDiff`, ... | Dates |
| `TimerNode` | `interval`, `sleep` | Timing |
| `FetchNode` | `fetch` | HTTP requests |
| `ErrorNode` | `error` | Throw `{ status, message }` HTTP errors |

`WorkerNode` (`thread`, steps run off the main thread) is not in `coreNodes`: it needs the environment's worker, so `@jexs/client` and `@jexs/server` add it built with theirs.

## Quick example

```ts
import { createResolver, coreNodes } from "@jexs/core";

const resolve = createResolver(coreNodes());

const ctx = { user: { name: "Ada" } };

resolve({ $concat: ["Hello, ", { $var: "user.name" }, "!"] }, ctx);
// → "Hello, Ada!"

resolve({
  $if: { $var: "user.name" },
  then: { $concat: ["Welcome back, ", { $var: "user.name" }] },
  else: "Sign in"
}, ctx);
// → "Welcome back, Ada"
```

## Extending — write your own node

```ts
import { Node, type Context, type JexsNodeSchema, createResolver, coreNodes, resolveAll } from "@jexs/core";

class ShoutNode extends Node {
  static schema: JexsNodeSchema = {
    shout: {
      output: "string",
      markdownDescription: "Upper-cases a string and adds `times` exclamation marks.",
      siblings: { times: { type: "number", description: "How many marks (default 1)." } },
    },
  };

  shout(def: Record<string, unknown>, ctx: Context) {
    return resolveAll([def.$shout, def.times], ctx, ([text, times]) =>
      String(text).toUpperCase() + "!".repeat(typeof times === "number" ? times : 1));
  }
}

const resolve = createResolver([...coreNodes(), new ShoutNode()]);
resolve({ $shout: { $var: "name" }, times: 2 }, { name: "ada" }); // → "ADA!!"
```

The method name `shout` becomes the op: a step with a `$shout` key routes to that handler, and the step's other keys are its siblings. The static `schema` documents the op for the editor and the MCP server.

A handler reads its inputs with `resolve(value, ctx, then)`, one value (an array resolves to an array), or `resolveAll([a, b], ctx, ([a, b]) => ...)`, several at once. The steps it is handed to run (a `do`, a branch, a handler) go through `runSteps(steps, ctx)`, where an array is a sequence whose last value is the result.

## License

[MIT](https://github.com/FranChapeta/jexs/blob/master/LICENSE)
