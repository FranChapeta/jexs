import { Node, Context, NodeValue, resolve, resolveObj } from "@jexs/core";
import { DatabaseNode } from "./Database.js";
import { Cache } from "../cache/Cache.js";
import { sha256 } from "./Crypto.js";

/**
 * TranslationNode - Configures automatic string translation per request.
 *
 * { "translate": { "to": "es", "table": "translations" } }
 *
 * Sets context._translate so the resolver auto-translates strings.
 */
export class TranslationNode extends Node {
  /**
   * Configures automatic string translation for the current request.
   * Sets `context._translate` so the resolver auto-translates strings via a DB lookup table.
   *
   * @param {expr} translate Target language code (e.g. `"es"`, `"fr"`).
   * @param {string} table DB table name for translations (default `"translations"`).
   * @example
   * { "translate": { "var": "$session.lang" }, "table": "translations" }
   */
  translate(def: Record<string, unknown>, context: Context): NodeValue {
    return resolveObj(def, context, r => {
      (context as Record<string, unknown>)._translate = {
        to: r.translate ? String(r.translate) : undefined,
        table: r.table ? String(r.table) : "translations",
      };
      return null;
    });
  }

  static async translateText(text: string, context: Context): Promise<string> {
    const config = (context as Record<string, unknown>)._translate as
      | { to?: string; table?: string }
      | undefined;

    if (!config?.to) return text;

    const { to, table = "translations" } = config;
    const hash = sha256(text);
    const cacheKey = `t:${to}:${hash}`;

    // Check cache first
    const cache = Cache.getInstance();
    const cached = await cache.get(cacheKey);
    if (cached !== undefined && cached !== null) {
      return cached === text ? text : String(cached);
    }

    // Cache miss — query DB
    try {
      const knex = DatabaseNode.getKnex();
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
