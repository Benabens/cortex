import type { SqlParam } from "./q";
import { databaseUrl, pglitePublicQuery } from "./driver-postgres";

/**
 * Accès Postgres du store d'auth : schéma `public`, HORS search_path tenant.
 * Supporte les deux backends (postgres.js / PGlite) comme driver-postgres.
 */

type PostgresSql = import("postgres").Sql;

let _pool: PostgresSql | null = null;

export async function authPgQuery(text: string, params: SqlParam[]): Promise<Record<string, unknown>[]> {
  const url = databaseUrl();
  if (url.startsWith("pglite://")) {
    return pglitePublicQuery(text, params);
  }
  if (!_pool) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const postgres = require("postgres") as typeof import("postgres");
    _pool = postgres(url, { max: 2, connection: { search_path: "public" }, onnotice: () => {} });
  }
  const r = await _pool.unsafe(text, params as never[]);
  return r as unknown as Record<string, unknown>[];
}
