# @jexs/mcp

[Model Context Protocol](https://modelcontextprotocol.io) server that lets Claude Code, Claude Desktop, and other MCP-aware tools introspect and evaluate **Jexs** templates as you author them.

> Part of [Jexs](https://github.com/FranChapeta/jexs).

## Run it

As a real MCP server in Claude Code (`.mcp.json`) — `cwd` is your project, so it introspects that project's `node_modules/@jexs`. Since the package has no bin, the `jexs` CLI launches it and resolves its `package.json` `"jexs"` entry:

```json
{ "mcpServers": { "jexs-dev": { "command": "npx",
  "args": ["-y", "-p", "@jexs/server", "-p", "@jexs/mcp", "jexs", "run", "@jexs/mcp"] } } }
```

From a checkout of this repo (after `npm run build`):

```bash
node server/dist/cli.js run @jexs/mcp      # or: run mcp/src/index.json — speaks MCP over stdio
node mcp/test-driver.mjs                    # drives a full session and prints each response
```

## How it works

- No launcher: `jexs run @jexs/mcp` reads this package's `package.json` `"jexs":
  "src/index.json"` and runs that entry through a `[...coreNodes, ...serverNodes({ root })]`
  resolver, rooted at the cwd. FileNode resolves relative `{ file }` loads against
  the loading file's own directory, so the template's siblings are just
  `"globals.json"`, `"walk.json"`, … wherever the package is installed; a
  `/`-prefixed path anchors at `root` (the cwd), so `"/node_modules/@jexs/…"` reads
  the target project's schemas.
- `src/index.json` — the whole server:
  - **startup**: `{ directory: "/node_modules/@jexs", subdirectories: true }`
    discovers installed packages, then loads and `deepMerge`s each package's
    `dist/schema.json` (`byNode`, `byKey`, `extraDefs`). That JSON is the build's
    frozen form of each node's `static schema`, so reading it is equivalent to the
    reflection the old TypeScript version did — no package importing.
  - **transport**: `stdio-listen` runs the NDJSON loop (and redirects
    `console.log` to stderr to keep stdout clean for protocol data).
  - **dispatch**: `switch` on `$message.method` → `initialize`, `tools/list`,
    `tools/call`, `ping`, notifications, and a JSON-RPC error for anything else.
- `src/tools.json` — the tool list returned by `tools/list`.
- `src/globals.json` — docs for the global step keys (`as` / `return` / `catch`),
  which live in the resolver, not in any node schema.
- `src/walk.json` — a recursive tree-walker used by `inspect_file` to collect
  every key in a target file. It is loaded once at startup (as `$walk`, via
  `data: true`) and recurses by `exec`-ing that var, so it is read from disk once,
  not per node.
- `src/walk-lint.json` — a second, path-tracking recursive walker (`$walkLint`,
  same preload + `exec` recursion) that flags the two dispatch foot-guns (multiple
  handler keys in one object; a data object whose first key isn't a handler but a
  later key is).

## Tools

| Tool | Implemented with |
|---|---|
| `resolve_expression` | `exec` — evaluates the passed JSON expression against the live resolver |
| `list_nodes` | merged `byNode`, with variant ops pulled from `byKey[op].variantDocs` |
| `describe_op` | `byKey[op]` — description, return type, siblings, variant ops, examples (falls back to global step keys) |
| `describe_def` | `extraDefs[name]` — the `#/$defs/<name>` shape (e.g. `_routeNode`) |
| `inspect_file` | `walk.json` collects used op keys; `walk-lint.json` (path-tracking) flags dispatch foot-guns |

## Notes / differences from the old TypeScript version

- **`describe_op` renders the digested sections** — description, return type,
  siblings, variant ops (backticked, with a "Tip"), and examples — which is what
  an AI needs to write the op. It deliberately omits the old version's full
  "Raw schema" JSON dump: that was `$ref`-heavy and redundant with the rendered
  sections, and shipping the raw schema as data cost ~160KB across the packages
  for little gain. `list_nodes` also orders nodes alphabetically (by discovery)
  rather than the old registration order.
- **`resolve_expression` takes JSON, not a string.** Pass the expression as an
  actual JSON value (`{ "concat": ["a", "b"] }`); `exec` evaluates it directly, so
  there is no `JSON.parse` step.
- **`inspect_file`'s advisory lint** flags both dispatch foot-guns with a dotted
  path. Array positions show as `[]` rather than `[i]` because `map` doesn't expose
  a loop index — the warning still names the offending keys, which is the
  actionable part.
- **Discovery reads `node_modules/@jexs` under the root** (one level). The old
  version walked up ancestor directories, so hoisted/pnpm layouts it found may need
  the root pointed at the dir that actually holds `node_modules/@jexs`.
- Packages without a `dist/schema.json` (e.g. `create`, `mcp`) log a benign
  `ENOENT` to stderr at startup as discovery probes them; they are filtered out.

## Jexs gotchas this shook out (notes for the curious)

Building a non-trivial program in the JSON surfaced a few sharp edges worth
knowing:

- A step whose **value contains a `return` key** halts the surrounding `runSteps`
  (that's how the `return` step works) — so a *data* file with a top-level
  `return` key (like the global-keys doc) ends startup early. Fixed by nesting it
  under `keys`.
- An object with an **`error` key** dispatches to `ErrorNode` (which throws), so a
  JSON-RPC error reply must be built with `fromEntries` to keep `error` a data key.
- `map`'s `do` as an **array** resolves in parallel (a data array), it is *not* a
  step sequence — use a single expression, and inline lookups instead of `as`.
- `params` **re-resolves** its values, so to walk a Jexs template as data you must
  load it with `data: true` and pass it via a `var` (raw), never inline.

## License

[MIT](https://github.com/FranChapeta/jexs/blob/master/LICENSE)
