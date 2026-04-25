import { Node, Context, NodeValue, runSteps } from "@jexs/core";

/**
 * StdioNode - Reads newline-delimited JSON from stdin, runs steps, writes results to stdout.
 *
 * Usage:
 * { "stdio": true, "on-message": [ ...steps... ], "on-close": [ ...steps... ] }
 *
 * Each line from stdin is parsed as JSON and set as $message on a child context.
 * The result of the last step (if not null/undefined) is written as JSON + newline to stdout.
 *
 * This is a long-running listener (like ListenNode). Console.log is redirected to stderr
 * to keep stdout clean for protocol data.
 */
export class StdioNode extends Node {
  /**
   * Starts a newline-delimited JSON (NDJSON) listener on stdin. Each line is parsed as JSON,
   * set as `$message` in context, and `on-message` steps are run. Non-null results are written to stdout.
   * `console.log` is redirected to stderr to keep stdout clean for protocol data.
   *
   * @param {boolean} stdio Set to `true` to start the listener.
   * @param {steps} on-message Steps run per NDJSON line with `$message` in context.
   * @param {steps} on-close Optional steps run when stdin closes.
   * @example
   * { "stdio": true, "on-message": [{ "var": "$message" }], "on-close": [] }
   */
  async stdio(def: Record<string, unknown>, context: Context): Promise<NodeValue> {
    if (!Array.isArray(def["on-message"])) {
      console.error('[StdioNode] "on-message" must be an array of steps');
      return null;
    }

    const steps = def["on-message"] as unknown[];
    const closeSteps = Array.isArray(def["on-close"]) ? def["on-close"] as unknown[] : null;

    // Redirect console.log to stderr so stdout stays clean for protocol data
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
        Promise.resolve(runSteps(steps, childContext)).then((result) => {
          if (result !== null && result !== undefined) {
            const output = typeof result === "string" ? result : JSON.stringify(result);
            process.stdout.write(output + "\n");
          }
        }).catch((err: unknown) => {
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

    return { type: "stdio" };
  }
}
