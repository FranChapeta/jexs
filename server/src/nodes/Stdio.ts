import { Node, Context, NodeValue, runSteps } from "@jexs/core";

/**
 * StdioNode - Reads newline-delimited JSON from stdin, runs steps, writes results to stdout.
 *
 * Usage:
 * { "stdio": { "on-message": [ ...steps... ], "on-close": [ ...steps... ] } }
 *
 * Each line from stdin is parsed as JSON and set as $message on a child context.
 * The result of the last step (if not null/undefined) is written as JSON + newline to stdout.
 *
 * This is a long-running listener (like ListenNode). Console.log is redirected to stderr
 * to keep stdout clean for protocol data.
 */
export class StdioNode extends Node {
  async stdio(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    const config = def.stdio;
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      console.error('[StdioNode] "stdio" must be a config object with "on-message" steps');
      return null;
    }

    const handler = config as Record<string, unknown>;
    if (!Array.isArray(handler["on-message"])) {
      console.error('[StdioNode] "on-message" must be an array of steps');
      return null;
    }

    // Redirect console.log to stderr so stdout stays clean for protocol data
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      process.stderr.write(args.map(String).join(" ") + "\n");
    };

    const steps = handler["on-message"] as unknown[];
    const closeSteps = Array.isArray(handler["on-close"]) ? handler["on-close"] as unknown[] : null;

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
        runSteps(steps, childContext).then((result) => {
          if (result !== null && result !== undefined) {
            const output = typeof result === "string" ? result : JSON.stringify(result);
            process.stdout.write(output + "\n");
          }
        }).catch((err) => {
          process.stderr.write(`[StdioNode] Error: ${err}\n`);
        });
      }
    });

    process.stdin.on("close", () => {
      if (closeSteps) {
        runSteps(closeSteps, { ...context }).catch((err) => {
          process.stderr.write(`[StdioNode] on-close error: ${err}\n`);
        });
      }
    });

    process.stdin.resume();

    return { type: "stdio" };
  }
}
