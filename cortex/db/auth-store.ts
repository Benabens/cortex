import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { dbDriverName, type SqlParam } from "./q";
import { toDollarParams } from "./driver-postgres";

/**
 * STORE D'AUTH global (Phase B4) — utilisateurs, comptes OAuth, jetons magic-link.
 * SÉPARÉ des données de cours (qui vivent par tenant) :
 *  - DB_DRIVER=sqlite → data/auth.db (fichier dédié, gitignoré — e-mails = données perso) ;
 *  - DB_DRIVER=postgres → schéma `public` de DATABASE_URL (postgres.js ou PGlite).
 * Sessions : stratégie JWT (aucune table session nécessaire).
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
    `CREATE TABLE IF NOT EXISTS public.verification_tokens (
      identifier text NOT NULL,
      token text NOT NULL,
      expires text NOT NULL,
      PRIMARY KEY (identifier, token)
    )`,
  ],
};

// ---------------- backend sqlite (fichier dédié) ----------------

let _sqliteAuth: Database.Database | null = null;

function sqliteAuth(): Database.Database {
  if (!_sqliteAuth) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BetterSqlite3 = require("better-sqlite3") as typeof import("better-sqlite3");
    const file = path.join(process.cwd(), "data", "auth.db");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    _sqliteAuth = new BetterSqlite3(file);
    _sqliteAuth.pragma("journal_mode = WAL");
    for (const ddl of AUTH_DDL.sqlite) _sqliteAuth.exec(ddl);
  }
  return _sqliteAuth;
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

export async function authRun(sql: string, ...params: SqlParam[]): Promise<void> {
  if (dbDriverName() === "sqlite") {
    sqliteAuth().prepare(sql).run(...params);
    return;
  }
  const ex = await pgExec();
  await ex.query(toDollarParams(sql), params);
}
