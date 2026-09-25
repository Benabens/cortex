import { ddl, getTable, type Dialect } from "./tables";

/**
 * FAÇADE DE REQUÊTES UNIQUE — remplace l'accès
 * direct au proxy better-sqlite3 `sqlite` dans les call sites applicatifs.
 *
 * Pourquoi async : better-sqlite3 est synchrone mais tout driver Postgres est
 * asynchrone → l'interface est async partout, le driver sqlite résout en
 * microtâche (l'ordre d'exécution d'une chaîne de requêtes est préservé).
 *
 * Dialecte : DB_DRIVER=sqlite (défaut, dev €0 — fichiers data/, comportement
 * historique) | postgres (produit, multi-user). Le SQL des call sites est écrit
 * dans le sous-ensemble PORTABLE (placeholders `?`, pas de datetime('now') —
 * horodatage calculé en JS via nowStr(), ON CONFLICT plutôt que OR REPLACE).
 *
 * Transactions : q.tx(fn) sérialise via un mutex par connexion (sqlite) — deux
 * chaînes async concurrentes ne peuvent plus interleaver un BEGIN ; en
 * postgres, transaction native sur connexion dédiée.
 */

export type RunResult = { changes: number; lastInsertRowid: number };
export type SqlParam = string | number | bigint | Buffer | null;

export interface QueryDriver {
  readonly dialect: Dialect;
  all<T>(sql: string, params: SqlParam[]): Promise<T[]>;
  get<T>(sql: string, params: SqlParam[]): Promise<T | undefined>;
  run(sql: string, params: SqlParam[]): Promise<RunResult>;
  /** INSERT avec récupération de l'id auto-généré (lastInsertRowid / RETURNING id). */
  insert(sql: string, params: SqlParam[]): Promise<number>;
  exec(sql: string): Promise<void>;
  tx<T>(fn: () => Promise<T>): Promise<T>;
  /** Colonnes existantes d'une table (PRAGMA table_info / information_schema). */
  columns(table: string): Promise<string[]>;
  addColumn(table: string, colDdl: string): Promise<void>;
}

export function dbDriverName(): Dialect {
  const raw = (process.env.DB_DRIVER ?? "sqlite").trim();
  if (raw === "sqlite" || raw === "postgres") return raw;
  throw new Error(`DB_DRIVER invalide : « ${raw} » (attendu : sqlite | postgres)`);
}

// Registre : le driver sqlite est enregistré par db/driver-sqlite (import côté
// client), postgres par db/driver-postgres. Résolution lazy à chaque appel →
// pas de dépendance circulaire, et les tests peuvent commuter par env.
const REGISTRY = new Map<Dialect, QueryDriver>();

export function registerDriver(d: QueryDriver): void {
  REGISTRY.set(d.dialect, d);
}

function driver(): QueryDriver {
  const name = dbDriverName();
  const d = REGISTRY.get(name);
  if (d) return d;
  // Chargement paresseux du module driver (require synchrone volontaire :
  // q.* est appelé partout, on ne veut pas d'await d'import).
  if (name === "sqlite") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("./driver-sqlite");
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("./driver-postgres");
  }
  const loaded = REGISTRY.get(name);
  if (!loaded) throw new Error(`Driver DB « ${name} » introuvable après chargement.`);
  return loaded;
}

/** Horodatage UTC au format historique de SQLite datetime('now') : 'YYYY-MM-DD HH:MM:SS'. */
export function nowStr(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace("T", " ");
}

/** nowStr décalé de n jours (remplace datetime('now', '+n days')). */
export function nowPlusDays(days: number): string {
  return nowStr(days * 86_400_000);
}

export const q = {
  get dialect(): Dialect {
    return driver().dialect;
  },

  all<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): Promise<T[]> {
    return driver().all<T>(sql, params);
  },

  get<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): Promise<T | undefined> {
    return driver().get<T>(sql, params);
  },

  run(sql: string, ...params: SqlParam[]): Promise<RunResult> {
    return driver().run(sql, params);
  },

  /** INSERT → id auto-généré (remplace .run(...).lastInsertRowid). */
  insert(sql: string, ...params: SqlParam[]): Promise<number> {
    return driver().insert(sql, params);
  },

  exec(sql: string): Promise<void> {
    return driver().exec(sql);
  },

  /** Colonnes existantes d'une table (lecture seule — ne mute jamais le schéma). */
  columns(table: string): Promise<string[]> {
    return driver().columns(table);
  },

  tx<T>(fn: () => Promise<T>): Promise<T> {
    return driver().tx(fn);
  },

  /** CREATE TABLE IF NOT EXISTS + index — remplace les ensures lazy historiques. */
  async ensureTable(name: string): Promise<void> {
    for (const stmt of ddl(name, driver().dialect)) await driver().exec(stmt);
  },

  /**
   * Rattrapage de colonnes (remplace les blocs PRAGMA table_info + ALTER).
   * Les colonnes demandées doivent exister dans db/tables.ts (source de vérité).
   */
  async ensureColumns(table: string, colNames: string[]): Promise<void> {
    const d = driver();
    const existing = new Set(await d.columns(table));
    const spec = getTable(table);
    for (const name of colNames) {
      if (existing.has(name)) continue;
      const col = spec.cols.find((c) => c.name === name);
      if (!col) throw new Error(`Colonne ${table}.${name} absente de db/tables.ts`);
      const type = col.type === "int" ? (d.dialect === "sqlite" ? "INTEGER" : "integer") : col.type === "real" ? (d.dialect === "sqlite" ? "REAL" : "double precision") : "TEXT";
      const nn = col.nn ? ` NOT NULL` : "";
      const def = col.def !== undefined && col.def !== "NOW" ? ` DEFAULT ${col.def}` : "";
      await d.addColumn(table, `${name} ${type}${nn}${def}`);
    }
  },
};
