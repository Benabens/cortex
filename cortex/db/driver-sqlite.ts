import type Database from "better-sqlite3";
import { AsyncLocalStorage } from "node:async_hooks";
import { rawDb, currentCourse } from "./client";
import { registerDriver, type QueryDriver, type RunResult, type SqlParam } from "./q";

/**
 * Driver SQLite de la façade q — délègue à la connexion better-sqlite3 du cours
 * courant (contexte AsyncLocalStorage, cf. db/client.ts). Comportement dev €0
 * historique inchangé : mêmes fichiers data/, mêmes pragmas.
 *
 * - Statements mis en cache PAR CONNEXION (les boucles `prepare une fois,
 *   run N fois` historiques gardent leur coût).
 * - Mutex par connexion : les transactions détiennent le verrou pour toute leur
 *   durée, et chaque statement isolé le prend brièvement → deux chaînes async
 *   concurrentes ne peuvent pas interleaver dans un BEGIN ouvert (équivalent
 *   de l'atomicité qu'offrait sqlite.transaction() synchrone). La chaîne
 *   PROPRIÉTAIRE de la tx est identifiée par AsyncLocalStorage.
 */

const stmtCaches = new WeakMap<Database.Database, Map<string, Database.Statement>>();

function stmt(d: Database.Database, sql: string): Database.Statement {
  let cache = stmtCaches.get(d);
  if (!cache) {
    cache = new Map();
    stmtCaches.set(d, cache);
  }
  let s = cache.get(sql);
  if (!s) {
    s = d.prepare(sql);
    cache.set(sql, s);
    if (cache.size > 500) cache.clear(); // borne mémoire (SQL dynamiques…)
  }
  return s;
}

/** File d'attente promise-chain par cours (mutex FIFO). */
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.then(() => undefined, () => undefined));
  return next as Promise<T>;
}

/** true ⇔ la chaîne async courante est DANS q.tx() (elle détient déjà le verrou). */
const txCtx = new AsyncLocalStorage<boolean>();

function exec1<T>(fn: () => T): Promise<T> {
  if (txCtx.getStore()) return Promise.resolve(fn());
  return withLock(currentCourse(), fn);
}

const sqliteDriver: QueryDriver = {
  dialect: "sqlite",

  all<T>(sql: string, params: SqlParam[]): Promise<T[]> {
    return exec1(() => stmt(rawDb(), sql).all(...params) as T[]);
  },

  get<T>(sql: string, params: SqlParam[]): Promise<T | undefined> {
    return exec1(() => stmt(rawDb(), sql).get(...params) as T | undefined);
  },

  run(sql: string, params: SqlParam[]): Promise<RunResult> {
    return exec1(() => {
      const r = stmt(rawDb(), sql).run(...params);
      return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
    });
  },

  async insert(sql: string, params: SqlParam[]): Promise<number> {
    return (await this.run(sql, params)).lastInsertRowid;
  },

  exec(sql: string): Promise<void> {
    return exec1(() => {
      rawDb().exec(sql);
    });
  },

  tx<T>(fn: () => Promise<T>): Promise<T> {
    if (txCtx.getStore()) return fn(); // tx imbriquée → aplatie (sémantique des tx() sync historiques)
    return withLock(currentCourse(), () =>
      txCtx.run(true, async () => {
        const d = rawDb();
        // BEGIN **IMMEDIATE** : nos transactions sont des lire-puis-écrire. Avec un
        // BEGIN différé, SQLite prend le verrou d'écriture seulement à l'UPDATE, et
        // si un AUTRE process a écrit entre-temps il renvoie SQLITE_BUSY *sans*
        // appliquer busy_timeout (promouvoir une transaction en lecture pourrait
        // interbloquer). C'est ce qui tuait le worker d'ingestion : le parent
        // journalise pendant que le process enfant réindexe la même base.
        d.exec("BEGIN IMMEDIATE");
        try {
          const out = await fn();
          d.exec("COMMIT");
          return out;
        } catch (e) {
          try {
            d.exec("ROLLBACK");
          } catch {
            /* déjà rollback (SQLITE_BUSY…) */
          }
          throw e;
        }
      })
    );
  },

  async columns(table: string): Promise<string[]> {
    const rows = rawDb().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return rows.map((r) => r.name);
  },

  async addColumn(table: string, colDdl: string): Promise<void> {
    rawDb().exec(`ALTER TABLE ${table} ADD COLUMN ${colDdl}`);
  },
};

registerDriver(sqliteDriver);

export { sqliteDriver };
