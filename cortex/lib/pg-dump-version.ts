/**
 * VERSION DE pg_dump vs SERVEUR — `pg_dump` refuse un serveur plus récent que
 * lui (« aborting because of server version mismatch ») : une image avec le
 * client 17 face à un Postgres 18 ne sauvegarde rien. On le dit AU DÉMARRAGE,
 * pas à 3 h du matin quand la sauvegarde échoue.
 */
import { spawnSync } from "node:child_process";
import { authGet } from "@/db/auth-store";
import { dumpExpected } from "./backup-schedule";

/** « pg_dump (PostgreSQL) 18.6 (Homebrew) » → 18. */
export function parsePgMajor(versionLine: string | undefined | null): number | null {
  const m = versionLine?.match(/\b(\d{2,3})(?:\.\d+)?\b/);
  return m ? Number(m[1]) : null;
}

export type PgDumpMismatch = { serverMajor: number; clientMajor: number | null; message: string };

export function pgDumpMismatch(o: { serverVersionNum: number; pgDumpVersion: string | undefined | null }): PgDumpMismatch | null {
  const serverMajor = Math.floor(o.serverVersionNum / 10000);
  const clientMajor = parsePgMajor(o.pgDumpVersion);
  if (clientMajor === null) {
    return { serverMajor, clientMajor, message: `pg_dump introuvable ou version illisible alors que le serveur Postgres est en ${serverMajor} : aucune sauvegarde de la base ne sera possible. Installe postgresql-client-${serverMajor} (image : ARG PG_CLIENT_MAJOR=${serverMajor}).` };
  }
  if (clientMajor >= serverMajor) return null;
  return {
    serverMajor, clientMajor,
    message: `pg_dump ${clientMajor} est plus ancien que le serveur ${serverMajor} : la sauvegarde échouera (« server version mismatch »). Reconstruis l'image avec ARG PG_CLIENT_MAJOR=${serverMajor} (ou supérieur).`,
  };
}

export async function serverVersionNum(): Promise<number | null> {
  try {
    const r = await authGet<{ v: string | number }>(`SELECT current_setting('server_version_num') AS v`);
    const n = Number(r?.v);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function pgDumpVersionLine(): string | undefined {
  try {
    const r = spawnSync("pg_dump", ["--version"], { encoding: "utf8" });
    return r.status === 0 ? (r.stdout || "").trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Compare et journalise. Renvoie le désaccord (ou null). Jamais bloquant. */
export async function warnIfPgDumpTooOld(opts: { log?: (m: string) => void; pgDumpVersion?: string | undefined; expectDump?: boolean } = {}): Promise<PgDumpMismatch | null> {
  const log = opts.log ?? console.error;
  if (!(opts.expectDump ?? dumpExpected())) return null;
  const server = await serverVersionNum();
  if (server === null) return null;
  const client = opts.pgDumpVersion !== undefined ? opts.pgDumpVersion : pgDumpVersionLine();
  const mismatch = pgDumpMismatch({ serverVersionNum: server, pgDumpVersion: client });
  if (mismatch) log(`[backup] AVERTISSEMENT — ${mismatch.message} (serveur ${server}, client « ${client ?? "absent"} »)`);
  return mismatch;
}
