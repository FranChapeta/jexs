import { Node, Context, NodeValue, TRANSLATE, isObject, resolveFields } from "@jexs/core";
import { DatabaseNode } from "./Database.js";
import { CacheNode, optionalName } from "./Cache.js";
import { sha256 } from "./Crypto.js";
import type { JexsNodeSchema } from "@jexs/core";

/** Where a translation is looked up: the language, and the table that holds it. */
interface TranslationConfig {
  to: string;
  table: string;
  columns: { hash: string; language: string; translation: string };
  cache?: string;
  database?: string;
}

const COLUMNS = { hash: "text_hash", language: "language_code", translation: "translated_text" };

export class TranslationNode extends Node {
  static schema: JexsNodeSchema = {
    translate: {
      type: "string",
      output: "null",
      markdownDescription: "Translates the text elements render, from here on in the request, into the given language. The text in an element's content is looked up by its SHA-256 in a table, kept in a cache once found, and rendered as the translation, or as written when there is none. A content array is one sentence: its text is looked up with `{0}`, `{1}`... standing for its other items in order (steps, elements), so `[\"You have \", { \"$var\": \"n\" }, \" items\"]` is looked up as `\"You have {0} items\"`, and each item goes where the translation puts its `{n}`, which may reorder them. What a step returns is not translated (an element it returns has its own text translated), nor is the text of an element with `translate: \"no\"`. Text is looked up when it has a letter (in any script), a currency sign or a `%`. Give `null` or `\"\"` to stop translating.",
      outputDescription: "Always `null`: it sets how the rest of the request's content renders.",
      examples: [
        "{ \"$translate\": { \"$var\": \"session.lang\" }, \"table\": \"translations\" }",
      ],
      siblings: {
        table: {
          type: "string",
          description: "Table holding the translations (default `\"translations\"`).",
        },
        columns: {
          type: "object",
          description: "The table's column names, where they differ from the defaults.",
          properties: {
            hash: { type: "string", description: "The source text's SHA-256, hex (default `\"text_hash\"`)." },
            language: { type: "string", description: "The language code (default `\"language_code\"`)." },
            translation: { type: "string", description: "The translated text (default `\"translated_text\"`)." },
          },
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
      if (r.$translate == null || r.$translate === "") {
        // Set, not deleted, so a translator an enclosing scope set is hidden too.
        context[TRANSLATE] = undefined;
        return null;
      }
      const columns = isObject(r.columns) ? r.columns : {};
      const config: TranslationConfig = {
        to: String(r.$translate),
        table: r.table ? String(r.table) : "translations",
        columns: {
          hash: typeof columns.hash === "string" ? columns.hash : COLUMNS.hash,
          language: typeof columns.language === "string" ? columns.language : COLUMNS.language,
          translation: typeof columns.translation === "string" ? columns.translation : COLUMNS.translation,
        },
        cache: optionalName(r.cache),
        database: optionalName(r.database),
      };
      context[TRANSLATE] = text => translateText(text, config, context);
      return null;
    });
  }
}

/**
 * `text` in the configured language: from the cache, else the table, whose
 * answer (or the text itself, when it has none) the cache then keeps. A cache
 * or database that fails throws, so the page shows the failure rather than an
 * untranslated page that looks fine.
 */
async function translateText(text: string, config: TranslationConfig, context: Context): Promise<string> {
  const { to, table, columns } = config;
  const hash = sha256(text);
  const cacheKey = `t:${to}:${hash}`;

  const cache = CacheNode.cacheFor(context, config.cache);
  const cached = await cache.get(cacheKey);
  if (cached !== undefined && cached !== null) return String(cached);

  const knex = DatabaseNode.getKnex(context, config.database);
  const row = await knex(table)
    .select(columns.translation)
    .where({ [columns.hash]: hash, [columns.language]: to })
    .first();
  const translated = row?.[columns.translation] ? String(row[columns.translation]) : text;
  // A miss is kept too, so the table is asked once per text.
  await cache.set(cacheKey, translated);
  return translated;
}
