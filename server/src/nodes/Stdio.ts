import { Node, Context, NodeValue, resolve, runSteps } from "@jexs/core";
import type { JexsNodeSchema } from "@jexs/core";

let stdinAttached = false;

function encode(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
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
  };

  ["stdio-listen"](def: Record<string, unknown>, context: Context): NodeValue {
    if (!Array.isArray(def["on-message"])) {
      console.error('[StdioNode] "on-message" must be an array of steps');
      return null;
    }

    if (stdinAttached) {
      console.error("[StdioNode] stdio-listen already attached; ignoring duplicate call");
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
        Promise.resolve(runSteps(steps, childContext)).catch((err: unknown) => {
          process.stderr.write(`[StdioNode] Error: ${err}\n`);
        });
      }
    });

    process.stdin.on("close", () => {
      if (closeSteps) {
        Promise.resolve(runSteps(closeSteps, { ...context })).catch((err: unknown) => {
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
}
