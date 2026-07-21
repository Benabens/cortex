/**
 * BOOT DE PROD (appelé par scripts/docker-entrypoint.sh avant `next start`).
 * Idempotent, et NO-OP complet en dev (aucune env posée → ne fait rien).
 *
 * Trois étapes :
 *  A) VOLUME  — si CORTEX_DATA_DIR pointe ailleurs que ./data : première
 *     initialisation du volume persistant en copiant le contenu committé
 *     (refs, content, cortex.db…) SANS écraser l'existant (les données des
 *     utilisateurs priment), marqueur `.cortex-volume-initialise`.
 *  B) MIGRATIONS — DB_DRIVER=postgres : rattrape le schéma de TOUS les
 *     tenants connus (registre public.tenants) : CREATE TABLE IF NOT EXISTS +
 *     ADD COLUMN manquantes depuis db/tables.ts (source de vérité). Les
 *     tenants neufs restent bootstrappés lazy au premier accès (inchangé).
 *  C) SEED — CORTEX_SEED_COURSES (ex. "ml", posée par le Dockerfile) : pour
 *     chaque cours listé, si le tenant du user de seed (CORTEX_SEED_USER,
 *     défaut owner) n'a AUCUN item, lance l'ingestion depuis le contenu
 *     COMMITTÉ (data/<cours>/content + refs) → l'app n'est pas vide au
 *     premier lancement, sans aucun appel LLM.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runWithCourse } from "../db/client";
import { runWithUser } from "../db/context";
import { authAll, authRun } from "../db/auth-store";
import { dbDriverName, nowStr, q } from "../db/q";
import { TABLES } from "../db/tables";
import { dataRoot, normalizeCourse } from "../lib/courses";

const log = (msg: string) => console.log(`[prod-boot] ${msg}`);

// ── A) initialisation du volume persistant ──────────────────────────────────
function initVolume(): void {
  const root = dataRoot();
  const baked = path.join(process.cwd(), "data");
  if (path.resolve(root) === path.resolve(baked)) return; // pas de volume séparé
  const marker = path.join(root, ".cortex-volume-initialise");
  if (fs.existsSync(marker)) {
    log(`volume déjà initialisé (${root})`);
    return;
  }
  log(`initialisation du volume : copie ${baked} → ${root} (sans écraser)…`);
  fs.mkdirSync(root, { recursive: true });
  if (fs.existsSync(baked)) {
    fs.cpSync(baked, root, { recursive: true, force: false, errorOnExist: false });
  }
  fs.writeFileSync(marker, `${nowStr()}\n`);
  log("volume initialisé");
}

// ── B) migrations idempotentes de tous les tenants connus ───────────────────
async function migrateTenants(): Promise<void> {
  if (dbDriverName() !== "postgres") return;
  // Le SELECT déclenche la création des tables du store auth (dont tenants).
  const rows = await authAll<{ user_id: string; course: string }>(
    "SELECT user_id, course FROM tenants ORDER BY user_id, course"
  );
  if (!rows.length) {
    log("migrations : aucun tenant enregistré (base neuve) — bootstrap lazy au premier accès");
    return;
  }
  for (const t of rows) {
    await runWithUser(t.user_id, () =>
      runWithCourse(normalizeCourse(t.course), async () => {
        for (const spec of TABLES) {
          await q.ensureTable(spec.name);
          await q.ensureColumns(spec.name, spec.cols.map((c) => c.name));
        }
      })
    );
    log(`migré : tenant ${t.user_id} × ${t.course} (${TABLES.length} tables)`);
  }
}

// ── C) seed du contenu committé ─────────────────────────────────────────────
async function seedCourses(): Promise<void> {
  const list = (process.env.CORTEX_SEED_COURSES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!list.length) return;
  const seedUser = process.env.CORTEX_SEED_USER || "owner";
  for (const rawCourse of list) {
    const course = normalizeCourse(rawCourse);
    if (course !== rawCourse) {
      log(`seed : cours inconnu « ${rawCourse} » — ignoré`);
      continue;
    }
    const already = await runWithUser(seedUser, () =>
      runWithCourse(course, async () => {
        const row = await q.get<{ n: number }>("SELECT count(*) n FROM items");
        return Number(row?.n ?? 0);
      })
    );
    if (already > 0) {
      log(`seed ${course} : déjà peuplé (${already} items) — rien à faire`);
      continue;
    }
    log(`seed ${course} : ingestion du contenu committé (user ${seedUser})…`);
    // PGlite (pglite://…) = Postgres in-process à stockage FICHIER mono-process :
    // il faut FERMER notre connexion avant de spawner l'ingestion (sinon le
    // sous-processus bloque sur le verrou du répertoire). Sans effet néfaste
    // sur postgres:// ; le driver rouvre lazy au prochain accès.
    if (dbDriverName() === "postgres") {
      const { closePostgres } = await import("../db/driver-postgres");
      await closePostgres();
    }
    const tsxBin = path.join("node_modules", ".bin", "tsx");
    const res = spawnSync(tsxBin, ["scripts/ingest.ts", `--course=${course}`], {
      stdio: "inherit",
      env: { ...process.env, CORTEX_USER: seedUser, CORTEX_COURSE: course },
    });
    if (res.status !== 0) {
      throw new Error(`seed ${course} : ingestion en échec (exit ${res.status})`);
    }
    // Enregistre le tenant de seed dans le registre global (utile avant tout accès HTTP).
    await authRun(
      `INSERT INTO tenants (user_id, course, schema_name, last_seen) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, course) DO UPDATE SET last_seen = excluded.last_seen`,
      seedUser, course, `t_${seedUser}_${course}`.toLowerCase(), nowStr()
    );
    log(`seed ${course} : OK`);
  }
}

async function main(): Promise<void> {
  log(`démarrage — DB_DRIVER=${dbDriverName()} · data=${dataRoot()} · seed=[${process.env.CORTEX_SEED_COURSES ?? ""}]`);
  initVolume();
  await migrateTenants();
  await seedCourses();
  log("terminé");
  process.exit(0);
}

main().catch((e) => {
  console.error("[prod-boot] ÉCHEC :", e);
  process.exit(1);
});
