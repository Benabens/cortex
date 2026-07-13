/**
 * MIGRATION SQLite → Postgres (Phase B5 backend-overhaul).
 *
 *   DATABASE_URL=postgres://… npx tsx scripts/migrate-to-postgres.ts [options]
 *     --user <id>       tenant utilisateur cible (défaut : owner)
 *     --courses a,b,c   cours à migrer (défaut : tous ceux dont la DB existe)
 *     --drop            DROP le schéma tenant cible avant import (ré-import propre)
 *
 * - Source : les DB SQLite par cours (data/cortex.db, data/algo/algo.db, data/ml/ml.db).
 * - Cible : un schéma PG par (user, cours) — t_<user>_<cours> (cf. db/context.ts).
 * - Ids PRÉSERVÉS (identity BY DEFAULT) + séquences resynchronisées (setval).
 * - IDEMPOTENT : sans --drop, les lignes déjà présentes sont ignorées
 *   (ON CONFLICT DO NOTHING) ; avec --drop, le tenant est reconstruit à neuf.
 * - VÉRIFICATION : comptes source vs cible par table — mismatch ⇒ exit 1.
 * - La recherche plein-texte n'est PAS copiée (fts_items = artefact SQLite ;
 *   côté PG la recherche est dérivée de `items` — cf. lib/search.ts).
 */
process.env.DB_DRIVER = "postgres";

import BetterSqlite3 from "better-sqlite3";
import fs from "node:fs";
import { runWithCourse } from "../db/client";
import { runWithUser, tenantSchema } from "../db/context";
import { closePostgres } from "../db/driver-postgres";
import { q } from "../db/q";
import { TABLES } from "../db/tables";
import { COURSES, coursePaths } from "../lib/courses";

type Args = { user: string; courses: string[]; drop: boolean };

/**
 * SQLite tolère les octets NUL et les surrogates UTF-16 isolés dans les TEXT
 * (textes extraits de PDF) — Postgres les REJETTE (« invalid byte sequence for
 * encoding UTF8 »). On les retire à l'import (perte limitée à ces octets
 * invalides ; loggé s'il y en a).
 */
let sanitizedCount = 0;
function pgSafe(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const clean = v.includes("\u0000") ? v.replaceAll("\u0000", "") : v;
  const well = clean.toWellFormed();
  if (well !== v) sanitizedCount++;
  return well;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const all = Object.keys(COURSES).filter((id) => fs.existsSync(coursePaths(id).dbPath));
  return {
    user: get("--user") ?? "owner",
    courses: (get("--courses")?.split(",").map((s) => s.trim()).filter(Boolean)) ?? all,
    drop: argv.includes("--drop"),
  };
}

async function migrateCourse(user: string, courseId: string): Promise<boolean> {
  const dbPath = coursePaths(courseId).dbPath;
  if (!fs.existsSync(dbPath)) {
    console.log(`— ${courseId} : pas de DB SQLite (${dbPath}) → ignoré`);
    return true;
  }
  const src = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
  const srcTables = new Set(
    (src.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((r) => r.name)
  );

  return runWithUser(user, () =>
    runWithCourse(courseId, async () => {
      const schema = tenantSchema();
      console.log(`\n═══ ${courseId} → schéma ${schema} ═══`);
      if (ARGS.drop) {
        await q.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        // le bootstrap du driver a déjà marqué ce schéma comme créé → re-force
        const { closePostgres } = await import("../db/driver-postgres");
        await closePostgres();
      }

      let allOk = true;
      for (const spec of TABLES) {
        if (!srcTables.has(spec.name)) continue;
        const srcCols = new Set(
          (src.prepare(`PRAGMA table_info(${spec.name})`).all() as { name: string }[]).map((r) => r.name)
        );
        const cols = spec.cols.map((c) => c.name).filter((c) => srcCols.has(c));
        const rows = src.prepare(`SELECT ${cols.join(", ")} FROM ${spec.name}`).all() as Record<string, unknown>[];
        const srcCount = rows.length;

        if (srcCount) {
          const ph = cols.map(() => "?").join(",");
          const insert = `INSERT INTO ${spec.name} (${cols.join(", ")}) VALUES (${ph}) ON CONFLICT DO NOTHING`;
          await q.tx(async () => {
            for (const row of rows) {
              await q.run(insert, ...cols.map((c) => pgSafe(row[c]) as never));
            }
          });
        }
        const tgtCount = Number((await q.get<{ n: number }>(`SELECT count(*) n FROM ${spec.name}`))!.n);
        const ok = tgtCount >= srcCount;
        if (!ok) allOk = false;
        console.log(`  ${ok ? "✓" : "✗"} ${spec.name.padEnd(16)} source=${srcCount}  cible=${tgtCount}`);

        // resynchronise la séquence identity (ids préservés)
        const hasAiId = spec.cols.some((c) => c.pk && c.ai);
        if (hasAiId && tgtCount > 0) {
          await q.exec(
            `SELECT setval(pg_get_serial_sequence('${spec.name}', 'id'), (SELECT COALESCE(MAX(id), 1) FROM ${spec.name}))`
          );
        }
      }
      src.close();
      return allOk;
    })
  );
}

const ARGS = parseArgs();

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL manquante (postgres://… ou pglite://<dossier>).");
    process.exit(1);
  }
  console.log(`Migration SQLite → Postgres — user tenant : ${ARGS.user}, cours : ${ARGS.courses.join(", ")}${ARGS.drop ? " (avec --drop)" : ""}`);
  let ok = true;
  for (const course of ARGS.courses) {
    try {
      ok = (await migrateCourse(ARGS.user, course)) && ok;
    } catch (e) {
      console.error(`✗ ${course} : ${(e as Error).message}`);
      ok = false;
    }
  }
  await closePostgres();
  if (!ok) {
    console.error("\n✗ Migration INCOMPLÈTE (comptes non conservés) — voir ci-dessus.");
    process.exit(1);
  }
  if (sanitizedCount) {
    console.log(`ℹ ${sanitizedCount} valeur(s) texte nettoyée(s) (octets NUL/surrogates invalides — artefacts d'extraction PDF).`);
  }
  console.log("\n✓ Migration terminée : tous les comptes source ≤ cible (idempotent).");
})();
