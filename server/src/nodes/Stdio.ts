import { Node, Context, NodeValue, resolve, runStepsDetached } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";
import { createInterface } from "node:readline";

let stdinAttached = false;

function encode(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
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
    "stdio-listen": {
      type: "boolean",
      output: "null",
      markdownDescription: "Starts a newline-delimited JSON (NDJSON) listener on stdin. Each line is parsed as JSON, set as `$message` in context, and `on-message` steps are run. `console.log` is redirected to stderr to keep stdout clean for protocol data. Use `stdio-write` inside the steps to send output.",
      examples: [
        "{ \"stdio-listen\": true, \"on-message\": [{ \"stdio-write\": { \"var\": \"$message\" } }] }",
      ],
      siblings: {
        "on-message": {
          steps: true,
          description: "Steps run per NDJSON line with `$message` in context.",
        },
        "on-close": {
          steps: true,
          description: "Optional steps run when stdin closes.",
        },
      },
    },
    "stdio-write": {
      output: "null",
      markdownDescription: "Writes a value to stdout followed by a newline. Strings pass through unchanged; everything else is JSON-encoded.",
      examples: [
        "{ \"stdio-write\": { \"ok\": true } }",
        "{ \"stdio-write\": \"hello\" }",
      ],
    },
    "stdio-prompt": {
      output: "string",
      markdownDescription: "Writes a prompt to stdout and reads one line from stdin, resolving to the entered text (trailing newline stripped). Lines are buffered so piped/redirected input works, and resolves to `\"\"` at end of input (EOF) — a non-interactive run never hangs. For interactive CLIs; mutually exclusive with `stdio-listen`. Call `stdio-close` after the last prompt so the process can exit.",
      examples: [
        "{ \"stdio-prompt\": \"Project name: \", \"as\": \"name\" }",
      ],
    },
    "stdio-close": {
      type: "boolean",
      output: "null",
      markdownDescription: "Closes the interactive stdin reader opened by `stdio-prompt`, releasing stdin so the process can exit. Call once, after the final `stdio-prompt`.",
      examples: [
        "{ \"stdio-close\": true }",
      ],
    },
  };

  ["stdio-listen"](def: Record<string, unknown>, context: Context): NodeValue {
    if (!Array.isArray(def["on-message"])) {
      console.error('[StdioNode] "on-message" must be an array of steps');
      return null;
    }

    if (stdinAttached || reader) {
      console.error("[StdioNode] stdin is already in use; ignoring stdio-listen");
      return null;
    }
    stdinAttached = true;

    const steps = def["on-message"] as unknown[];
    const closeSteps = Array.isArray(def["on-close"]) ? def["on-close"] as unknown[] : null;

    console.log = (...args: unknown[]) => {
      process.stderr.write(args.map(String).join(" ") + "\n");
    };

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
          process.stderr.write(`[StdioNode] Invalid JSON: ${line}\n`);
          continue;
        }

        const childContext: Context = { ...context, message };
        runStepsDetached(steps, childContext, def).catch((err: unknown) => {
          process.stderr.write(`[StdioNode] Error: ${err}\n`);
        });
      }
    });

    process.stdin.on("close", () => {
      if (closeSteps) {
        runStepsDetached(closeSteps, { ...context }, def).catch((err: unknown) => {
          process.stderr.write(`[StdioNode] on-close error: ${err}\n`);
        });
      }
    });

    process.stdin.resume();
    return null;
  }

  ["stdio-write"](def: Record<string, unknown>, context: Context): NodeValue {
    return resolve(def["stdio-write"], context, value => {
      process.stdout.write(encode(value) + "\n");
      return null;
    });
  }

  ["stdio-prompt"](def: Record<string, unknown>, context: Context): NodeValue {
    if (stdinAttached) {
      console.error("[StdioNode] stdin is owned by stdio-listen; stdio-prompt cannot read it");
      return null;
    }
    return resolve(def["stdio-prompt"], context, text => getReader().ask(String(text)));
  }

  ["stdio-close"](): NodeValue {
    if (reader) {
      reader.close();
      reader = null;
    }
    return null;
  }
}
