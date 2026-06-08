import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import path from "node:path";
import * as schema from "./schema";

// Base locale unique, à la racine de l'app. Jamais commitée (cf. .gitignore).
const dbPath = path.join(process.cwd(), "data", "cortex.db");

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

/** Table virtuelle FTS5 pour la recherche globale cross-sites. Créée à la main (hors Drizzle). */
export function ensureFts() {
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS fts_items USING fts5(
      title, text, lecture_id UNINDEXED, item_id UNINDEXED, source_id UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
}

export { sqlite };
