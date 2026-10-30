import { Node, Context, NodeValue, Html, childContext, loggerFor, resolve, runStepsDetached } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";
import { createInterface } from "node:readline";

// Module-level on purpose, not instance fields: there is exactly one process
// stdin. Two resolvers each attaching their own readline interface would compete
// for the same lines, so the attach guard and the reader stay shared however many
// resolvers exist.
let stdinAttached = false;

function encode(value: unknown): string {
  return typeof value === "string" || value instanceof Html ? String(value) : JSON.stringify(value);
}

interface LineReader {
  ask(question: string): Promise<string>;
  close(): void;
}

let reader: LineReader | null = null;

function getReader(): LineReader {
  if (reader) return reader;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lines: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  let closed = false;

  rl.on("line", line => {
    // Strip the UTF-8 BOM (U+FEFF) PowerShell prepends to piped string input,
    // which would otherwise corrupt the first answer (parseInt("﻿3") === NaN).
    const cleaned = line.charCodeAt(0) === 0xFEFF ? line.slice(1) : line;
    const waiter = waiters.shift();
    if (waiter) waiter(cleaned);
    else lines.push(cleaned);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()!("");
  });

  reader = {
    ask(question: string): Promise<string> {
      process.stdout.write(question);
      if (lines.length > 0) return Promise.resolve(lines.shift()!);
      if (closed) return Promise.resolve("");
      return new Promise<string>(res => waiters.push(res));
    },
    close(): void {
      rl.close();
    },
  };
  return reader;
}

export class StdioNode extends Node {
  static schema: JexsNodeSchema = {
    stdioListen: {
      type: "boolean",
      output: "null",
      markdownDescription: "Starts a newline-delimited JSON (NDJSON) listener on stdin. Each line is parsed as JSON, set as `message` in context, and `onMessage` steps are run. Use `stdioWrite` inside the steps to send output. Keep stdout for the protocol: the `jexs` CLI writes the nodes' own messages to stderr, and a resolver of your own needs a `logger` that does the same.",
      examples: [
        "{ \"$stdioListen\": true, \"onMessage\": [{ \"$stdioWrite\": { \"$var\": \"message\" } }] }",
      ],
      siblings: {
        onMessage: {
          steps: true,
          description: "Steps run per NDJSON line with `message` in context, in a scope of their own: `$bubble` writes to the scope `stdioListen` ran in.",
        },
        onClose: {
          steps: true,
          description: "Optional steps run when stdin closes, in a scope of their own like `onMessage`'s.",
        },
      },
    },
    stdioWrite: {
      output: "null",
      markdownDescription: "Writes a value to stdout followed by a newline. Strings pass through unchanged; everything else is JSON-encoded.",
      examples: [
        "{ \"$stdioWrite\": { \"ok\": true } }",
        "{ \"$stdioWrite\": \"hello\" }",
      ],
    },
    stdioPrompt: {
      output: "string",
      markdownDescription: "Writes a prompt to stdout and reads one line from stdin, resolving to the entered text (trailing newline stripped). Lines are buffered so piped/redirected input works, and resolves to `\"\"` at end of input (EOF), so a non-interactive run never hangs. For interactive CLIs; mutually exclusive with `stdioListen`. Call `stdioClose` after the last prompt so the process can exit.",
      examples: [
        "{ \"$stdioPrompt\": \"Project name: \", \"$as\": \"name\" }",
      ],
    },
    stdioClose: {
      type: "boolean",
      output: "null",
      markdownDescription: "Closes the interactive stdin reader opened by `stdioPrompt`, releasing stdin so the process can exit. Call once, after the final `stdioPrompt`.",
      examples: [
        "{ \"$stdioClose\": true }",
      ],
    },
  };

  stdioListen(def: Record<string, unknown>, context: Context): NodeValue {
    const log = loggerFor(context);
    if (def.onMessage === undefined) throw new Error('$stdioListen needs "onMessage" steps');
    if (stdinAttached || reader) {
      throw new Error("$stdioListen: stdin is already read by an earlier stdioListen or stdioPrompt");
    }
    stdinAttached = true;

    const steps = def.onMessage;
    const closeSteps = def.onClose ?? null;

    let buffer = "";

    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line) continue;

        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          log.error(`[stdio] Invalid JSON: ${line}`);
          continue;
        }

        void runStepsDetached(steps, childContext(context, { message }), { step: def, logAs: "[StdioNode] onMessage error:" });
      }
    });

    process.stdin.on("close", () => {
      if (closeSteps) void runStepsDetached(closeSteps, childContext(context), { step: def, logAs: "[StdioNode] onClose error:" });
    });

    process.stdin.resume();
    return null;
  }

  stdioWrite(def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def.$stdioWrite, context, value => {
      process.stdout.write(encode(value) + "\n");
      return null;
    });
  }

  stdioPrompt(def: Record<string, unknown>, context: Context): NodeValue {
    if (stdinAttached) throw new Error("$stdioPrompt: stdin is read by stdioListen, so it cannot prompt");
    return resolve(def.$stdioPrompt, context, text => getReader().ask(String(text)));
  }

  stdioClose(): NodeValue {
    if (reader) {
      reader.close();
      reader = null;
    }
    return null;
  }
}
