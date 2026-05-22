# @jexs/create

Scaffolder for new **Jexs** projects. Run it with `npm create` and answer a couple of prompts.

> Part of [Jexs](https://github.com/FranChapeta/jexs).

## Usage

```bash
npm create @jexs my-app
cd my-app
npm install
```

The CLI asks two questions:

1. **Environment** — Server (HTTP / DB / auth), Client (browser DOM / fetch / audio), or Both.
2. **Include `@jexs/physics` and `@jexs/gl`?** — for 3D / WebGL / physics work.

…and then writes:

```
my-app/
├── package.json              # with the right @jexs/* deps for your choices
├── .jexs-schema.json         # JSON-schema ref pointing at the combined schema
├── .gitignore
├── .vscode/
│   └── settings.json         # wires schema into src/**/*.json
└── src/
    └── app.json              # minimal starter template
```

## What you get out of the box

- **IDE autocomplete & validation** — `.vscode/settings.json` plus `.jexs-schema.json` give you in-editor docs, validation, and type-aware completion for every Jexs node available in your project.
- **No build step** — the starter app is pure JSON; `tsx` runs it directly (server) or the browser loads it (client).
- **Right deps from the start** — physics/gl are only added if you said yes, so you don't pay for what you don't use.

## License

[MIT](https://github.com/FranChapeta/jexs/blob/master/LICENSE)
