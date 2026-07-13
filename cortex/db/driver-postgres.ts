import { AsyncLocalStorage } from "node:async_hooks";
import { tenantSchema } from "./context";
import { registerDriver, type QueryDriver, type RunResult, type SqlParam } from "./q";
import { allDdl } from "./tables";

/**
 * Driver Postgres de la façade q (Phase B — voie « production », DB_DRIVER=postgres).
 *
 * MULTI-TENANT PAR SCHÉMA : chaque (utilisateur, cours) a son schéma PG
 * `t_<user>_<cours>` (cf. db/context.ts). L'isolation est structurelle : le
 * search_path de la connexion détermine seul les tables visibles — le SQL
 * applicatif (portable, placeholders `?`) est identique au mode SQLite.
 *
 * DEUX BACKENDS, choisis par DATABASE_URL :
 *  - postgres://…  → postgres.js, un POOL PAR TENANT (search_path fixé à la
 *    connexion — symétrique du cache « une connexion SQLite par cours »).
 *  - pglite://<dir> ou pglite://memory → PGlite (Postgres WASM in-process) :
 *    zéro Docker, pour les tests (isolation multi-tenant prouvable en CI) et
 *    la démo locale. Connexion unique sérialisée + SET search_path par tenant.
 */

type PgRows = Record<string, unknown>[];

interface TenantExec {
  /** Exécute une requête $1-paramétrée dans le schéma du tenant. */
  query(text: string, params: SqlParam[]): Promise<{ rows: PgRows; count: number }>;
  /** Exécute du DDL/multi-statements dans le schéma du tenant. */
  exec(text: string): Promise<void>;
  /** Transaction : tout callback exécuté sur la MÊME connexion, BEGIN/COMMIT géré. */
  begin<T>(fn: (tx: TenantExec) => Promise<T>): Promise<T>;
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DB_DRIVER=postgres exige DATABASE_URL (postgres://… ou pglite://<dossier>|pglite://memory)."
    );
  }
  return url;
}

/** Traduit les placeholders `?` en `$1…$n` (hors chaînes '…' et identifiants "…"). */
export function toDollarParams(sql: string): string {
  let out = "";
  let n = 0;
  let inS = false;
  let inD = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inS) {
      out += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") { out += "'"; i++; } else inS = false;
      }
    } else if (inD) {
      out += ch;
      if (ch === '"') inD = false;
    } else if (ch === "'") {
      inS = true; out += ch;
    } else if (ch === '"') {
      inD = true; out += ch;
    } else if (ch === "?") {
      out += `$${++n}`;
    } else {
      out += ch;
    }
  }
  return out;
}

// ─────────────────────────── backend postgres.js ───────────────────────────

type PostgresSql = import("postgres").Sql;

let _basePostgres: typeof import("postgres") | null = null;
function postgresLib(): typeof import("postgres") {
  if (!_basePostgres) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _basePostgres = require("postgres");
  }
  return _basePostgres!;
}

const pgPools = new Map<string, PostgresSql>();
const bootstrapped = new Set<string>();

function poolFor(schema: string): PostgresSql {
  let pool = pgPools.get(schema);
  if (!pool) {
    const postgres = postgresLib();
    pool = postgres(databaseUrl(), {
      max: Math.max(1, Number(process.env.PG_POOL_MAX) || 3),
      connection: { search_path: `"${schema}"` },
      onnotice: () => {},
    });
    pgPools.set(schema, pool);
  }
  return pool;
}

function postgresJsExec(schema: string): TenantExec {
  const pool = poolFor(schema);
  const wrap = (sql: PostgresSql): TenantExec => ({
    async query(text, params) {
      const r = await sql.unsafe(text, params as never[]);
      return { rows: r as unknown as PgRows, count: r.count ?? (Array.isArray(r) ? r.length : 0) };
    },
    async exec(text) {
      await sql.unsafe(text).simple();
    },
    async begin(fn) {
      return sql.begin(async (tsql) => fn(wrap(tsql as unknown as PostgresSql))) as Promise<never>;
    },
  });
  return wrap(pool);
}

// ─────────────────────────── backend PGlite ───────────────────────────

type PGliteInstance = {
  query(text: string, params?: unknown[]): Promise<{ rows: PgRows; affectedRows?: number }>;
  exec(text: string): Promise<unknown>;
  transaction<T>(fn: (tx: { query(text: string, params?: unknown[]): Promise<{ rows: PgRows; affectedRows?: number }> }) => Promise<T>): Promise<T>;
};

let _pglite: PGliteInstance | null = null;
let _pgliteChain: Promise<unknown> = Promise.resolve();
let _pgliteSchema: string | null = null;

async function pgliteInstance(): Promise<PGliteInstance> {
  if (!_pglite) {
    const target = databaseUrl().replace(/^pglite:\/\//, "");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PGlite } = require("@electric-sql/pglite") as typeof import("@electric-sql/pglite");
    _pglite = new PGlite(target === "memory" ? undefined : target) as unknown as PGliteInstance;
  }
  return _pglite;
}

/** PGlite = une seule connexion → tout passe par une file FIFO + SET search_path. */
function pgliteSerial<T>(fn: () => Promise<T>): Promise<T> {
  const next = _pgliteChain.then(fn, fn);
  _pgliteChain = next.then(() => undefined, () => undefined);
  return next as Promise<T>;
}

function pgliteExec(schema: string): TenantExec {
  const setPath = async (db: PGliteInstance) => {
    if (_pgliteSchema !== schema) {
      await db.exec(`SET search_path TO "${schema}"`);
      _pgliteSchema = schema;
    }
  };
  return {
    query(text, params) {
      return pgliteSerial(async () => {
        const db = await pgliteInstance();
        await setPath(db);
        const r = await db.query(text, params as unknown[]);
        return { rows: r.rows, count: r.affectedRows ?? r.rows.length };
      });
    },
    exec(text) {
      return pgliteSerial(async () => {
        const db = await pgliteInstance();
        await setPath(db);
        await db.exec(text);
      });
    },
    begin<T>(fn: (tx: TenantExec) => Promise<T>): Promise<T> {
      return pgliteSerial(async () => {
        const db = await pgliteInstance();
        await setPath(db);
        return db.transaction(async (tx) => {
          const txExec: TenantExec = {
            async query(text, params) {
              const r = await tx.query(text, params as unknown[]);
              return { rows: r.rows, count: r.affectedRows ?? r.rows.length };
            },
            async exec(text) {
              await tx.query(text);
            },
            begin() {
              throw new Error("PGlite : transaction imbriquée non supportée");
            },
          };
          return fn(txExec);
        });
      });
    },
  };
}

// ─────────────────────────── bootstrap tenant + driver ───────────────────────────

function isPglite(): boolean {
  return databaseUrl().startsWith("pglite://");
}

function rawExec(schema: string): TenantExec {
  return isPglite() ? pgliteExec(schema) : postgresJsExec(schema);
}

/** CREATE SCHEMA + schéma applicatif complet, une fois par tenant et par process. */
async function ensureTenant(schema: string): Promise<TenantExec> {
  const ex = rawExec(schema);
  if (!bootstrapped.has(schema)) {
    await ex.exec(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    // PGlite : le SET search_path a pu précéder la création → re-force.
    if (isPglite()) _pgliteSchema = null;
    for (const stmt of allDdl("postgres")) await ex.exec(stmt);
    bootstrapped.add(schema);
  }
  return ex;
}

/** Transaction en cours de la chaîne async courante (routage des q.* internes). */
const txCtx = new AsyncLocalStorage<TenantExec>();

async function executor(): Promise<TenantExec> {
  const tx = txCtx.getStore();
  if (tx) return tx;
  return ensureTenant(tenantSchema());
}

const postgresDriver: QueryDriver = {
  dialect: "postgres",

  async all<T>(sql: string, params: SqlParam[]): Promise<T[]> {
    const ex = await executor();
    return (await ex.query(toDollarParams(sql), params)).rows as T[];
  },

  async get<T>(sql: string, params: SqlParam[]): Promise<T | undefined> {
    const ex = await executor();
    return (await ex.query(toDollarParams(sql), params)).rows[0] as T | undefined;
  },

  async run(sql: string, params: SqlParam[]): Promise<RunResult> {
    const ex = await executor();
    const r = await ex.query(toDollarParams(sql), params);
    return { changes: r.count, lastInsertRowid: Number((r.rows[0] as { id?: number })?.id ?? 0) };
  },

  async insert(sql: string, params: SqlParam[]): Promise<number> {
    const ex = await executor();
    const withReturning = /returning\s/i.test(sql) ? sql : `${sql.replace(/;\s*$/, "")} RETURNING id`;
    const r = await ex.query(toDollarParams(withReturning), params);
    const id = (r.rows[0] as { id?: number })?.id;
    if (typeof id !== "number") throw new Error("INSERT sans id retourné (table sans colonne id ?)");
    return id;
  },

  async exec(sql: string): Promise<void> {
    const ex = await executor();
    await ex.exec(sql);
  },

  async tx<T>(fn: () => Promise<T>): Promise<T> {
    if (txCtx.getStore()) return fn(); // tx imbriquée → aplatie (même sémantique que le driver sqlite)
    const ex = await executor();
    return ex.begin((tex) => txCtx.run(tex, fn));
  },

  async columns(table: string): Promise<string[]> {
    const ex = await executor();
    const r = await ex.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
      [tenantSchema(), table]
    );
    return r.rows.map((row) => String((row as { column_name: string }).column_name));
  },

  async addColumn(table: string, colDdl: string): Promise<void> {
    const ex = await executor();
    await ex.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${colDdl}`);
  },
};

registerDriver(postgresDriver);

export { postgresDriver };

/** Requête PGlite sur le schéma `public` (store d'auth) — sérialisée avec le reste. */
export async function pglitePublicQuery(text: string, params: SqlParam[]): Promise<PgRows> {
  return pgliteSerial(async () => {
    const db = await pgliteInstance();
    await db.exec(`SET search_path TO public`);
    _pgliteSchema = null; // le prochain appel tenant re-forcera son schéma
    const r = await db.query(text, params as unknown[]);
    return r.rows;
  });
}

/** Ferme les pools (tests / arrêt propre). */
export async function closePostgres(): Promise<void> {
  for (const pool of pgPools.values()) await pool.end({ timeout: 2 });
  pgPools.clear();
  bootstrapped.clear();
  if (_pglite && "close" in _pglite) await (_pglite as unknown as { close(): Promise<void> }).close();
  _pglite = null;
  _pgliteSchema = null;
}
