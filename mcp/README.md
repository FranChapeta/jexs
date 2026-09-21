# @jexs/mcp

[Model Context Protocol](https://modelcontextprotocol.io) server that lets Claude Code, Claude Desktop, and other MCP-aware tools introspect, check, and evaluate **Jexs** templates as you author them.

> Part of [Jexs](https://github.com/FranChapeta/jexs).

## Run it

Install it alongside the CLI and point `.mcp.json` at the installed copy:

```bash
npm i -D @jexs/mcp @jexs/server
```

```json
{ "mcpServers": { "jexs-dev": {
  "command": "node", "args": ["node_modules/@jexs/server/dist/cli.js", "run", "@jexs/mcp"] } } }
```

Projects scaffolded by `@jexs/create` get this already. The package has no `bin`, so the `jexs`
CLI launches it by resolving its `package.json` `"jexs"` entry.

Prefer the installed copy over `npx -y -p @jexs/server -p @jexs/mcp jexs run @jexs/mcp`. The npx
form still works, but it fetches the latest release on every editor launch (so it needs the network)
and pairs that runtime with whatever `.jexs/` schemas your *pinned* `@jexs/server` generated. When
those drift far enough apart the server says so and tells you to rerun `jexs schema`.

From a checkout of this repo (after `npm run build`):

```bash
node server/dist/cli.js run @jexs/mcp      # or: run mcp/src/index.json - speaks MCP over stdio
node mcp/test-driver.mjs                   # drives a full session and prints each response
npm test                                   # mcp/test/mcp.test.mjs asserts on that session
```

## Tools

| Tool | What it answers |
|---|---|
| `search_ops` | "Which op does X?" Name/description search over every op, with its package, Node class and return type. The entry point. |
| `describe_op` | "How do I write this op?" Owning class and package, description, return type, siblings (required ones marked, variant-specific ones scoped), variant operations, examples. Also covers the global step keys. |
| `list_nodes` | The whole surface, grouped by Node class, optionally filtered to one package. |
| `describe_def` | A shared `#/$defs/` shape, e.g. `_routeNode`. |
| `validate_file` | "Is this template valid?" Validates against the project's generated schema, the same one the editor uses. |
| `inspect_file` | Which op keys a file uses, keys that look like typos, and advisory lint for dispatch foot-guns. |
| `resolve_expression` | Runs a JSON expression against the live resolver. Takes optional `vars` to seed context. |

`resolve_expression` evaluates against a real server resolver with full node access, so it can read
files, make network calls and touch the database exactly as the app would.

## How it works

There is no launcher. `jexs run @jexs/mcp` reads this package's `package.json` `"jexs":
"src/index.json"` and runs that entry through a `[...coreNodes, ...serverNodes({ root })]` resolver
rooted at the cwd. `FileNode` resolves a relative `{ file }` against the loading file's own
directory, so the template's siblings are just `"tools.json"`, `"walk.json"`, wherever the package is
installed; a `/`-prefixed path anchors at `root`, which is how it reads the target project's files.

At startup it loads both artifacts `jexs schema` writes into the project's `.jexs/`:

- **`schema.json`** is the flat catalog: `byKey` (every op with its prose, examples and return type),
  `byNode`, `extraDefs`, `keyPackage` / `nodePackage` / `keyNode` for attribution, and `siblingDocs`,
  the flattened sibling list (own + per-variant + the Node's `commonSiblings`) that `describe_op`
  renders. It is generated from each Node class's authored `static schema`, so it is documentation
  rather than validation.
- **`combined.schema.json`** is the JSON Schema document the editor validates against. The server
  uses it for two things: `validate_file` hands it to Ajv, and the global step keys (`as`, `return`,
  `catch`, `then`, `bubble`) are read from its `$defs.exprFlat.properties`, which is where the
  generator already publishes them.

If neither loads, every tool says so and tells you to run `jexs schema`.

The rest of `src/`:

- `index.json` is the whole server: startup, the `stdio-listen` NDJSON loop (which redirects
  `console.log` to stderr to keep stdout clean for protocol data), and a `switch` on
  `$message.method` for `initialize`, `tools/list`, `tools/call`, `ping`, notifications, and a
  JSON-RPC error for anything else.
- `tools.json` is the tool list returned by `tools/list`.
- `walk.json` collects every key in a target file; `walk-unknown.json` finds keys that are not an op,
  a global key, or a sibling of their step's op but are one character-shuffle from one;
  `walk-lint.json` flags the two dispatch foot-guns (multiple handler keys in one object; a data
  object whose first key isn't a handler but a later key is). `suggest.json` is the shared
  did-you-mean matcher. Each is preloaded once with `data: true` and recurses by `exec`-ing its own
  var, so none is re-read per node.

Errors are caught at two levels, because in a request/response protocol a dropped reply is worse
than an error: the client waits on it forever. A failing tool is caught on its own step and answered
as `{ content, isError: true }`, which is the shape an MCP client renders. Anything else that throws
is caught on the dispatch `switch` itself and answered with a JSON-RPC `-32603` for that id, which
covers `initialize`, `tools/list`, `ping` and the unknown-method branch as well.

## Jexs gotchas this shook out (notes for the curious)

Building a non-trivial program in the JSON surfaced a few sharp edges worth knowing:

- A step whose **value contains a `return` key** halts the surrounding `runSteps` (that is how the
  `return` step works). So binding any foreign data that might carry one, a file the user asked
  about, or `exprFlat.properties` (which literally has a `return` key, since `return` is a global
  step key), ends the sequence instead. Bind it wrapped: `{ "fromEntries": [["node", ...]] }`, then
  read `$box.node`.
- A **bare `[]` is not a valid step.** `runSteps` requires every step to be an expression object, so
  a walker whose fallthrough branch was a literal `[]` threw on the first scalar leaf of any file.
- An object with an **`error` key** dispatches to `ErrorNode` (which throws), so a JSON-RPC error
  reply must be built with `fromEntries` to keep `error` a data key.
- `map`'s `do` as an **array** resolves in parallel (a data array), it is *not* a step sequence. Use
  a single expression, and inline lookups instead of `as`.
- `exec`'s **`params` keys are literal names**, resolved per entry: you cannot spread a map that was
  computed at runtime through it. To seed context from dynamic data, build the step array instead and
  put a `setVars` step in front of the expression.
- `params` **re-resolves** its values, so to walk a Jexs template as data you must load it with
  `data: true` and pass it via a `var` (raw), never inline.

## License

[MIT](https://github.com/FranChapeta/jexs/blob/master/LICENSE)
