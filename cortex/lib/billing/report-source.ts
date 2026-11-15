import fs from "node:fs";
import path from "node:path";
import { authAll } from "@/db/auth-store";
import { PG_TYPES, toDollarParams } from "@/db/driver-postgres";
import { dbDriverName } from "@/db/q";
import { dataRoot } from "@/lib/courses";

/**
 * SOURCE EN LECTURE SEULE des rapports d'exploitation (npm run cost:report).
 *
 * Défaut du 14/11/2026 : `DATABASE_URL=<Postgres de prod> npm run cost:report`
 * passait par le store global, qui suit DB_DRIVER (sqlite par défaut) et lisait
 * donc le data/auth.db local, vide : « aucun job dans llm_usage ». Et la voie
 * Postgres du store exécute ses migrations (CREATE TABLE, ALTER TABLE) au
 * premier accès : lancée contre la prod, elle y aurait écrit.
 *
 * Ici, la base vient de DATABASE_URL quand elle est posée (Postgres ou PGlite),
 * sinon du store local. La connexion est ouverte en lecture seule
 * (`default_transaction_read_only`, fichier SQLite en `readonly`) et aucune DDL
 * n'est jouée : une table absente est une erreur que l'appelant traite.
 */
export type ReportReader = {
  /** Requête à placeholders `?`, exécutée en lecture seule. */
  all<T = Record<string, unknown>>(sql: string, ...params: Array<string | number | null>): Promise<T[]>;
  dialect: "sqlite" | "postgres";
  /** Ce qui est lu, sans secret (hôte et base, jamais le mot de passe). */
  label: string;
  close(): Promise<void>;
};

/** « postgres://user:secret@host:5432/db » → « host/db » : jamais d'identifiant dans une sortie. */
export function describeDatabaseUrl(url: string): string {
  if (url.startsWith("pglite://")) return `PGlite ${url.slice("pglite://".length) === "memory" ? "en mémoire" : "(dossier local)"}`;
  try {
    const u = new URL(url);
    return `Postgres ${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`;
  } catch {
    return "Postgres";
  }
}

export async function openReportReader(env: Partial<NodeJS.ProcessEnv> = process.env): Promise<ReportReader> {
  const url = env.DATABASE_URL?.trim();
  if (url && url.startsWith("pglite://")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const target = url.slice("pglite://".length);
    const db = new PGlite(target === "memory" ? undefined : target);
    await db.exec(`SET default_transaction_read_only = on`);
    return {
      dialect: "postgres",
      label: `${describeDatabaseUrl(url)} (lecture seule)`,
      async all<T>(sql: string, ...params: Array<string | number | null>) {
        return (await db.query<T>(toDollarParams(sql), params)).rows;
      },
      close: () => db.close(),
    };
  }
  if (url && /^postgres(ql)?:\/\//.test(url)) {
    const { default: postgres } = await import("postgres");
    const sql = postgres(url, {
      max: 1,
      // Paramètre de session posé à la connexion : toute écriture est refusée par le serveur.
      connection: { default_transaction_read_only: true },
      onnotice: () => {},
      types: PG_TYPES,
    });
    return {
      dialect: "postgres",
      label: `${describeDatabaseUrl(url)} (lecture seule)`,
      async all<T>(text: string, ...params: Array<string | number | null>) {
        return (await sql.unsafe(toDollarParams(text), params as never[])) as unknown as T[];
      },
      close: () => sql.end({ timeout: 2 }),
    };
  }
  if (dbDriverName() === "postgres") {
    // DB_DRIVER=postgres sans URL exploitable ici : le store lui-même le dira.
    return { dialect: "postgres", label: "store global", all: (s, ...p) => authAll(s, ...p), close: async () => {} };
  }
  const file = path.join(dataRoot(), "auth.db");
  if (!fs.existsSync(file)) {
    return { dialect: "sqlite", label: `${file} (absent)`, all: async () => [], close: async () => {} };
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const BetterSqlite3 = require("better-sqlite3") as typeof import("better-sqlite3");
  const db = new BetterSqlite3(file, { readonly: true, fileMustExist: true });
  return {
    dialect: "sqlite",
    label: `${file} (lecture seule)`,
    async all<T>(sql: string, ...params: Array<string | number | null>) {
      return db.prepare(sql).all(...params) as T[];
    },
    close: async () => { db.close(); },
  };
}
