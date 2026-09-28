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

/**
 * COMPTEUR DE REQUÊTES (tests et mesures de budget) : le nombre d'aller-retours
 * SQL d'un chemin de lecture est une propriété qu'on veut pouvoir affirmer —
 * cf. tests/query-budget.test.ts. Coût en production : une incrémentation.
 */
let _queries = 0;
export function queryCountForTests(): number { return _queries; }
export function resetQueryCountForTests(): void { _queries = 0; }

/**
 * MÉMO DU SCHÉMA, par tenant et par process. `ensureTable`/`ensureColumns`
 * rejouaient la DDL et une lecture du catalogue à CHAQUE appel de fonction de
 * bibliothèque : des dizaines d'aller-retours par requête HTTP, alors que le
 * schéma du tenant est créé une fois pour toutes (ensureTenant côté Postgres,
 * amorçage du fichier côté sqlite). La clé est l'identité du tenant — pas le nom
 * de schéma, qui peut différer (registre) — et elle est purgée quand un cours
 * est supprimé (`forgetSchemaMemo`).
 */
const _ensured = new Set<string>();
function tenantKey(): string {
  // require paresseux : même raison que pour les drivers (aucun cycle statique).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { currentUser } = require("./context") as typeof import("./context");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { currentCourse } = require("./client") as typeof import("./client");
  return `${dbDriverName()}|${currentUser()}|${currentCourse()}`;
}
/** Oublie le schéma mémoïsé d'un tenant (cours supprimé, base recréée). */
export function forgetSchemaMemo(userId?: string, courseId?: string): void {
  if (!userId || !courseId) { _ensured.clear(); return; }
  const prefix = `${dbDriverName()}|${userId}|${courseId}|`;
  for (const k of [..._ensured]) if (k.startsWith(prefix)) _ensured.delete(k);
}

export const q = {
  get dialect(): Dialect {
    return driver().dialect;
  },

  all<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): Promise<T[]> {
    _queries++;
    return driver().all<T>(sql, params);
  },

  get<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): Promise<T | undefined> {
    _queries++;
    return driver().get<T>(sql, params);
  },

  run(sql: string, ...params: SqlParam[]): Promise<RunResult> {
    _queries++;
    return driver().run(sql, params);
  },

  /** INSERT → id auto-généré (remplace .run(...).lastInsertRowid). */
  insert(sql: string, ...params: SqlParam[]): Promise<number> {
    _queries++;
    return driver().insert(sql, params);
  },

  exec(sql: string): Promise<void> {
    _queries++;
    return driver().exec(sql);
  },

  /** Colonnes existantes d'une table (lecture seule — ne mute jamais le schéma). */
  columns(table: string): Promise<string[]> {
    _queries++;
    return driver().columns(table);
  },

  tx<T>(fn: () => Promise<T>): Promise<T> {
    return driver().tx(fn);
  },

  /** CREATE TABLE IF NOT EXISTS + index — remplace les ensures lazy historiques.
   *  Mémoïsé par tenant et par process (la DDL est idempotente, la rejouer à
   *  chaque requête ne coûte que des aller-retours). */
  async ensureTable(name: string): Promise<void> {
    const key = `${tenantKey()}|t:${name}`;
    if (_ensured.has(key)) return;
    for (const stmt of ddl(name, driver().dialect)) await this.exec(stmt);
    _ensured.add(key);
  },

  /**
   * Rattrapage de colonnes (remplace les blocs PRAGMA table_info + ALTER).
   * Les colonnes demandées doivent exister dans db/tables.ts (source de vérité).
   */
  async ensureColumns(table: string, colNames: string[]): Promise<void> {
    const key = `${tenantKey()}|c:${table}:${[...colNames].sort().join(",")}`;
    if (_ensured.has(key)) return;
    const d = driver();
    const existing = new Set(await this.columns(table));
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
    _ensured.add(key);
  },
};
