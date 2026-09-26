import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { dbDriverName, type SqlParam } from "./q";
import { toDollarParams } from "./driver-postgres";
import type { AuthPgQuery } from "./driver-postgres-auth";
import { dataRoot } from "../lib/courses";

/**
 * STORE D'AUTH global — utilisateurs, comptes OAuth, jetons magic-link.
 * SÉPARÉ des données de cours (qui vivent par tenant) :
 *  - DB_DRIVER=sqlite → data/auth.db (fichier dédié, gitignoré — e-mails = données perso) ;
 *  - DB_DRIVER=postgres → schéma `public` de DATABASE_URL (postgres.js ou PGlite).
 * Sessions : stratégie JWT (aucune table session nécessaire).
 * Y vit aussi la table `courses` : un cours appartient à un UTILISATEUR,
 * pas à un schéma de cours — il ne peut donc pas vivre dans un tenant.
 */

const AUTH_DDL: Record<"sqlite" | "postgres", string[]> = {
  sqlite: [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      name TEXT,
      image TEXT,
      email_verified TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS accounts (
      provider TEXT NOT NULL,
      provider_account_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      access_token TEXT, refresh_token TEXT, expires_at INTEGER,
      token_type TEXT, scope TEXT, id_token TEXT,
      PRIMARY KEY (provider, provider_account_id)
    )`,
    `CREATE TABLE IF NOT EXISTS verification_tokens (
      identifier TEXT NOT NULL,
      token TEXT NOT NULL,
      expires TEXT NOT NULL,
      PRIMARY KEY (identifier, token)
    )`,
    `CREATE TABLE IF NOT EXISTS tenants (
      user_id TEXT NOT NULL,
      course TEXT NOT NULL,
      schema_name TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      PRIMARY KEY (user_id, course)
    )`,
    `CREATE TABLE IF NOT EXISTS llm_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      course TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      tokens_in INTEGER,
      tokens_out INTEGER,
      cache_read INTEGER,
      cache_write INTEGER,
      cost_usd REAL NOT NULL DEFAULT 0,
      rate_in_per_m REAL,
      rate_out_per_m REAL,
      estimated INTEGER NOT NULL DEFAULT 0,
      job_id TEXT,
      call_site TEXT,
      attempt INTEGER,
      latency_ms INTEGER,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS llm_usage_user_idx ON llm_usage (user_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS llm_usage_user_day_idx ON llm_usage (user_id, created_at, cost_usd)`,
    `CREATE TABLE IF NOT EXISTS gen_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      bucket TEXT NOT NULL,
      kind TEXT NOT NULL,
      course TEXT NOT NULL,
      day TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS gen_events_quota_idx ON gen_events (user_id, bucket, day)`,
    `CREATE TABLE IF NOT EXISTS credit_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      ref TEXT UNIQUE,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS credit_tx_user_idx ON credit_transactions (user_id)`,
    `CREATE TABLE IF NOT EXISTS courses (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      short TEXT NOT NULL,
      code TEXT,
      exam_name TEXT,
      exam_kind TEXT,
      university TEXT,
      university_lines TEXT,
      faculty TEXT,
      teachers TEXT,
      language TEXT NOT NULL DEFAULT 'fr',
      profile_id TEXT,
      duration_min INTEGER,
      exam_date TEXT,
      db_file TEXT,
      refs_rel TEXT,
      exams_rel TEXT,
      uploads_rel TEXT,
      content_rel TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS courses_owner_idx ON courses (owner_user_id)`,
    `CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS active_jobs (
      user_id TEXT NOT NULL,
      course TEXT NOT NULL,
      job_ref TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, job_ref)
    )`,
    `CREATE TABLE IF NOT EXISTS stripe_purchases (
      session_id TEXT PRIMARY KEY,
      payment_intent TEXT,
      user_id TEXT NOT NULL,
      credits_centi INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS stripe_purchases_pi_idx ON stripe_purchases (payment_intent)`,
  ],
  postgres: [
    `CREATE TABLE IF NOT EXISTS public.users (
      id text PRIMARY KEY,
      email text UNIQUE,
      name text,
      image text,
      email_verified text
    )`,
    `CREATE TABLE IF NOT EXISTS public.accounts (
      provider text NOT NULL,
      provider_account_id text NOT NULL,
      user_id text NOT NULL,
      type text NOT NULL,
      access_token text, refresh_token text, expires_at integer,
      token_type text, scope text, id_token text,
      PRIMARY KEY (provider, provider_account_id)
    )`,
    `CREATE TABLE IF NOT EXISTS public.tenants (
      user_id text NOT NULL,
      course text NOT NULL,
      schema_name text NOT NULL,
      last_seen text NOT NULL,
      PRIMARY KEY (user_id, course)
    )`,
    `CREATE TABLE IF NOT EXISTS public.llm_usage (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      user_id text NOT NULL,
      course text NOT NULL,
      provider text NOT NULL,
      model text NOT NULL,
      tokens_in integer,
      tokens_out integer,
      cache_read integer,
      cache_write integer,
      cost_usd double precision NOT NULL DEFAULT 0,
      rate_in_per_m double precision,
      rate_out_per_m double precision,
      estimated integer NOT NULL DEFAULT 0,
      job_id text,
      call_site text,
      attempt integer,
      latency_ms integer,
      created_at text NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS llm_usage_user_idx ON public.llm_usage (user_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS llm_usage_user_day_idx ON public.llm_usage (user_id, created_at, cost_usd)`,
    `CREATE TABLE IF NOT EXISTS public.gen_events (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      user_id text NOT NULL,
      bucket text NOT NULL,
      kind text NOT NULL,
      course text NOT NULL,
      day text NOT NULL,
      created_at text NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS gen_events_quota_idx ON public.gen_events (user_id, bucket, day)`,
    `CREATE TABLE IF NOT EXISTS public.credit_transactions (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      user_id text NOT NULL,
      delta integer NOT NULL,
      reason text NOT NULL,
      ref text UNIQUE,
      created_at text NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS credit_tx_user_idx ON public.credit_transactions (user_id)`,
    `CREATE TABLE IF NOT EXISTS public.verification_tokens (
      identifier text NOT NULL,
      token text NOT NULL,
      expires text NOT NULL,
      PRIMARY KEY (identifier, token)
    )`,
    `CREATE TABLE IF NOT EXISTS public.courses (
      id text PRIMARY KEY,
      owner_user_id text NOT NULL,
      name text NOT NULL,
      short text NOT NULL,
      code text,
      exam_name text,
      exam_kind text,
      university text,
      university_lines text,
      faculty text,
      teachers text,
      language text NOT NULL DEFAULT 'fr',
      profile_id text,
      duration_min integer,
      exam_date text,
      db_file text,
      refs_rel text,
      exams_rel text,
      uploads_rel text,
      content_rel text,
      created_at text NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS courses_owner_idx ON public.courses (owner_user_id)`,
    `CREATE TABLE IF NOT EXISTS public.app_meta (
      key text PRIMARY KEY,
      value text NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS public.active_jobs (
      user_id text NOT NULL,
      course text NOT NULL,
      job_ref text NOT NULL,
      created_at text NOT NULL,
      PRIMARY KEY (user_id, job_ref)
    )`,
    `CREATE TABLE IF NOT EXISTS public.stripe_purchases (
      session_id text PRIMARY KEY,
      payment_intent text,
      user_id text NOT NULL,
      credits_centi integer NOT NULL,
      created_at text NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS stripe_purchases_pi_idx ON public.stripe_purchases (payment_intent)`,
  ],
};

/**
 * Colonnes AJOUTÉES à `llm_usage` ultérieurement (instrumentation des coûts).
 * `CREATE TABLE IF NOT EXISTS` ne les ajoute PAS à une table
 * existante : on les applique par ALTER idempotent. Toutes additives et
 * nullable (sauf `estimated` avec DEFAULT) → sûres sur une table vivante.
 */
const LLM_USAGE_ADDED: Array<{ name: string; sqlite: string; pg: string }> = [
  { name: "cache_read", sqlite: "INTEGER", pg: "integer" },
  { name: "cache_write", sqlite: "INTEGER", pg: "integer" },
  { name: "rate_in_per_m", sqlite: "REAL", pg: "double precision" },
  { name: "rate_out_per_m", sqlite: "REAL", pg: "double precision" },
  { name: "estimated", sqlite: "INTEGER NOT NULL DEFAULT 0", pg: "integer NOT NULL DEFAULT 0" },
  { name: "job_id", sqlite: "TEXT", pg: "text" },
  { name: "call_site", sqlite: "TEXT", pg: "text" },
  { name: "attempt", sqlite: "INTEGER", pg: "integer" },
  { name: "latency_ms", sqlite: "INTEGER", pg: "integer" },
];

// ---------------- backend sqlite (fichier dédié) ----------------

let _sqliteAuth: Database.Database | null = null;

function sqliteAuth(): Database.Database {
  if (!_sqliteAuth) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BetterSqlite3 = require("better-sqlite3") as typeof import("better-sqlite3");
    const file = path.join(dataRoot(), "auth.db");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    _sqliteAuth = new BetterSqlite3(file);
    _sqliteAuth.pragma("journal_mode = WAL");
    // Plusieurs process écrivent ce fichier (serveur, worker de jobs, workers du
    // build Next) : sans attente, le second perdant prend « database is locked ».
    _sqliteAuth.pragma("busy_timeout = 8000");
    for (const ddl of AUTH_DDL.sqlite) _sqliteAuth.exec(ddl);
    // Migration additive des bases existantes (SQLite n'a pas ADD COLUMN IF NOT EXISTS).
    const have = new Set(
      (_sqliteAuth.prepare("PRAGMA table_info(llm_usage)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const c of LLM_USAGE_ADDED) {
      if (!have.has(c.name)) _sqliteAuth.exec(`ALTER TABLE llm_usage ADD COLUMN ${c.name} ${c.sqlite}`);
    }
  }
  return _sqliteAuth;
}

/**
 * Connexion SQLite BRUTE du store global, ou null hors dialecte sqlite.
 * Réservée aux lectures qui doivent rester SYNCHRONES (cf. db/courses-store) :
 * `getCourse()` est appelé au cœur du moteur, dans des chemins non-async.
 */
export function authSqlite(): Database.Database | null {
  return dbDriverName() === "sqlite" ? sqliteAuth() : null;
}

// ---------------- backend postgres (schéma public) ----------------

let _pgReady = false;

async function pgExec(): Promise<{
  query(text: string, params: SqlParam[]): Promise<Record<string, unknown>[]>;
}> {
  // Réutilise l'infra du driver postgres, mais SANS search_path tenant (schéma public).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { authPgQuery } = require("./driver-postgres-auth") as typeof import("./driver-postgres-auth");
  if (!_pgReady) {
    for (const ddl of AUTH_DDL.postgres) await authPgQuery(ddl, []);
    // Migration additive des bases existantes (Postgres : ADD COLUMN IF NOT EXISTS).
    for (const c of LLM_USAGE_ADDED) {
      await authPgQuery(`ALTER TABLE public.llm_usage ADD COLUMN IF NOT EXISTS ${c.name} ${c.pg}`, []);
    }
    _pgReady = true;
  }
  return { query: authPgQuery };
}

// ---------------- API unifiée ----------------

export async function authAll<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): Promise<T[]> {
  if (dbDriverName() === "sqlite") {
    return sqliteAuth().prepare(sql).all(...params) as T[];
  }
  const ex = await pgExec();
  return (await ex.query(toDollarParams(sql), params)) as T[];
}

export async function authGet<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): Promise<T | undefined> {
  return (await authAll<T>(sql, ...params))[0];
}

/** INSERT avec récupération de l'id (lastInsertRowid / RETURNING id). */
export async function authInsert(sql: string, ...params: SqlParam[]): Promise<number> {
  if (dbDriverName() === "sqlite") {
    await sqliteTxIdle();
    return Number(sqliteAuth().prepare(sql).run(...params).lastInsertRowid);
  }
  const ex = await pgExec();
  const withReturning = /returning\s/i.test(sql) ? sql : `${sql.replace(/;\s*$/, "")} RETURNING id`;
  const rows = await ex.query(toDollarParams(withReturning), params);
  return Number((rows[0] as { id?: number | string })?.id ?? 0);
}

export async function authRun(sql: string, ...params: SqlParam[]): Promise<void> {
  if (dbDriverName() === "sqlite") {
    await sqliteTxIdle();
    sqliteAuth().prepare(sql).run(...params);
    return;
  }
  const ex = await pgExec();
  await ex.query(toDollarParams(sql), params);
}

// ---------------- transaction ----------------

/** Exécuteur lié à UNE transaction du store (mêmes placeholders `?`). */
export type AuthTx = {
  all<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): Promise<T | undefined>;
  run(sql: string, ...params: SqlParam[]): Promise<void>;
};

let _sqliteTxChain: Promise<unknown> = Promise.resolve();
/** Transaction sqlite en cours (connexion unique) : les écritures extérieures attendent sa fin. */
let _sqliteTxOpen: Promise<void> | null = null;
async function sqliteTxIdle(): Promise<void> {
  while (_sqliteTxOpen) await _sqliteTxOpen;
}

/**
 * TRANSACTION du store global — pour les décisions lire-puis-écrire qui
 * doivent être atomiques (réservation de crédits/quotas).
 *
 *  - Postgres : transaction native (connexion dédiée) ; l'appelant pose un
 *    `pg_advisory_xact_lock` par utilisateur pour sérialiser ses réservations.
 *  - sqlite : BEGIN IMMEDIATE (verrou d'écriture inter-process) + file
 *    in-process, et les écritures des autres tâches du process (authRun,
 *    authInsert) attendent la fin de la transaction — sur une connexion
 *    unique, elles tomberaient sinon dedans et seraient annulées par un
 *    ROLLBACK. `fn` RENVOIE un refus métier, il ne le lève pas.
 */
export async function authTx<T>(fn: (tx: AuthTx) => Promise<T>): Promise<T> {
  if (dbDriverName() === "sqlite") {
    const db = sqliteAuth();
    const tx: AuthTx = {
      async all<T2>(sql: string, ...params: SqlParam[]) { return db.prepare(sql).all(...params) as T2[]; },
      async get<T2>(sql: string, ...params: SqlParam[]) { return db.prepare(sql).get(...params) as T2 | undefined; },
      async run(sql: string, ...params: SqlParam[]) { db.prepare(sql).run(...params); },
    };
    const run = async () => {
      // Pendant la transaction, authRun/authInsert d'autres tâches ATTENDENT :
      // sur une connexion unique, une écriture étrangère glissée entre deux
      // await tomberait dans la transaction et serait annulée par un ROLLBACK
      // (crédit Stripe acquitté, ligne llm_usage…).
      let release!: () => void;
      _sqliteTxOpen = new Promise<void>((r) => { release = r; });
      db.exec("BEGIN IMMEDIATE");
      try {
        const out = await fn(tx);
        db.exec("COMMIT");
        return out;
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch { /* déjà rollback */ }
        throw e;
      } finally {
        _sqliteTxOpen = null;
        release();
      }
    };
    const next = _sqliteTxChain.then(run, run);
    _sqliteTxChain = next.then(() => undefined, () => undefined);
    return next;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { authPgTx } = require("./driver-postgres-auth") as typeof import("./driver-postgres-auth");
  return authPgTx(async (query: AuthPgQuery) => {
    const tx: AuthTx = {
      async all<T2>(sql: string, ...params: SqlParam[]) { return (await query(toDollarParams(sql), params)) as T2[]; },
      async get<T2>(sql: string, ...params: SqlParam[]) { return ((await query(toDollarParams(sql), params)) as T2[])[0]; },
      async run(sql: string, ...params: SqlParam[]) { await query(toDollarParams(sql), params); },
    };
    return fn(tx);
  });
}
