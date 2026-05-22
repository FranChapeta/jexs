# @jexs/mcp

[Model Context Protocol](https://modelcontextprotocol.io) server that lets Claude Code, Claude Desktop, and other MCP-aware tools introspect and evaluate **Jexs** templates as you author them.

The server dynamically discovers whichever `@jexs/*` packages are installed in the project it's run from, so you only get tools for the nodes you actually have.

> Part of [Jexs](https://github.com/FranChapeta/jexs).

## Install

You usually don't install this manually — wire it into your MCP-aware editor and it runs via `npx`. If you do want it as a project dev dep:

```bash
npm install -D @jexs/mcp
```

## Use with Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "jexs-dev": {
      "command": "npx",
      "args": ["-y", "jexs-mcp"]
    }
  }
}
```

Claude Code will spawn the server in your project's working directory and discover its installed `@jexs/*` packages.

## Use with Claude Desktop

Add to `claude_desktop_config.json` (path varies per OS — see Claude Desktop docs):

```json
{
  "mcpServers": {
    "jexs-dev": {
      "command": "npx",
      "args": ["-y", "jexs-mcp"],
      "cwd": "/absolute/path/to/your/jexs/project"
    }
  }
}
```

## Exposed tools

- `list_nodes` — list every node (and its handler keys) from the installed `@jexs/*` packages.
- `inspect_file` — load a `.json` template from the project and parse-check it.
- `resolve_expression` — evaluate a JSON expression against a context and return the result. Useful for verifying behavior without spinning up a full server.

## License

[MIT](https://github.com/FranChapeta/jexs/blob/master/LICENSE)
