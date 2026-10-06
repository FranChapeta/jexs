import { Node, Context, NodeValue, resolve, resolveFields } from "@jexs/core";
import { DatabaseNode } from "./Database.js";
import { cacheFor, optionalName } from "./Cache.js";
import { sha256 } from "./Crypto.js";
import type { JexsNodeSchema } from "@jexs/core";

export class TranslationNode extends Node {
  static schema: JexsNodeSchema = {
    translate: {
      type: "string",
      output: "null",
      markdownDescription: "Configures automatic string translation for the current request.\nSets `context._translate` so the resolver auto-translates strings via a DB lookup table.",
      outputDescription: "Always `null`. It configures translation as a side-effect (via `context._translate`) for the rest of the request.",
      examples: [
        "{ \"$translate\": { \"$var\": \"session.lang\" }, \"table\": \"translations\" }",
      ],
      siblings: {
        table: {
          type: "string",
          description: "DB table name for translations (default `\"translations\"`).",
        },
        cache: {
          type: "string",
          description: "Named cache that holds looked-up translations (default cache if omitted).",
        },
        database: {
          type: "string",
          description: "Named database connection holding the table (default if omitted).",
        },
      },
    },
  };

  translate(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveFields(def, context, r => {
      (context as Record<string, unknown>)._translate = {
        to: r.$translate ? String(r.$translate) : undefined,
        table: r.table ? String(r.table) : "translations",
        cache: optionalName(r.cache),
        database: optionalName(r.database),
      };
      return null;
    });
  }

  static async translateText(text: string, context: Context): Promise<string> {
    const config = (context as Record<string, unknown>)._translate as
      | { to?: string; table?: string; cache?: string; database?: string }
      | undefined;

    if (!config?.to) return text;

    const { to, table = "translations" } = config;
    const hash = sha256(text);
    const cacheKey = `t:${to}:${hash}`;

    // Check cache first
    const cache = cacheFor(context, config.cache);
    const cached = await cache.get(cacheKey);
    if (cached !== undefined && cached !== null) {
      return cached === text ? text : String(cached);
    }

    // Cache miss — query DB
    try {
      const knex = DatabaseNode.getKnex(context, config.database);
      const row = await knex(table)
        .select("translated_text")
        .where({ text_hash: hash, language_code: to })
        .first();

      if (row?.translated_text) {
        await cache.set(cacheKey, row.translated_text);
        return String(row.translated_text);
      }

      // Cache the miss so we don't query again
      await cache.set(cacheKey, text);
      return text;
    } catch {
      return text;
    }
  }

}
