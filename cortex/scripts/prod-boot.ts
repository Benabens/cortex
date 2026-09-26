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
import { assertAuthRequired, assertLlmProviderAllowed } from "../lib/boot-guards";
import { dataRoot, ensureCoursesLoaded, normalizeCourse } from "../lib/courses";

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
    // Deux sources de vérité INDÉPENDANTES : le marqueur vit sur le volume, le
    // corpus dans la base. Ni l'une ni l'autre ne suffit — on décide en croisant
    // les deux, et on ne RÉ-INGÈRE JAMAIS un tenant déjà peuplé (l'ingestion
    // purge sources/items : sur une base vivante, ce serait destructeur).
    const doneMarker = path.join(dataRoot(), `.seed-done-${course}`);
    const already = await runWithUser(seedUser, () =>
      runWithCourse(course, async () => {
        const row = await q.get<{ n: number }>("SELECT count(*) n FROM items");
        return Number(row?.n ?? 0);
      })
    );
    if (already > 0) {
      if (!fs.existsSync(doneMarker)) {
        // Corpus présent sans marqueur : volume recréé, ou seed antérieur à ce
        // mécanisme. On MARQUE sans toucher aux données (ne jamais purger une
        // base vivante), en le signalant clairement.
        fs.writeFileSync(doneMarker, `${nowStr()} (marqué a posteriori : corpus déjà présent)\n`);
        log(`seed ${course} : ${already} items déjà en base, marqueur (re)posé — AUCUNE ré-ingestion`);
      } else {
        log(`seed ${course} : déjà fait (${already} items) — rien à faire`);
      }
      continue;
    }
    // Base VIDE. Si le marqueur existe quand même (base recréée/basculée), il
    // ment : on le retire et on re-seed, sinon l'app resterait vide à jamais.
    if (fs.existsSync(doneMarker)) {
      log(`seed ${course} : marqueur présent mais base VIDE (base recréée ?) — re-seed`);
      try { fs.unlinkSync(doneMarker); } catch { /* on re-seed de toute façon */ }
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
      // NE PAS faire échouer le boot : l'app doit démarrer (le reste du site
      // fonctionne, le seed sera retenté au prochain démarrage). Un conteneur
      // qui refuse de démarrer à cause du seed, c'est une panne totale.
      log(`seed ${course} : ÉCHEC de l'ingestion (exit ${res.status}) — l'app démarre quand même, seed retenté au prochain boot`);
      continue;
    }
    fs.writeFileSync(doneMarker, `${nowStr()}\n`); // seed COMPLET (cf. ci-dessus)
    // Enregistre le tenant de seed dans le registre global (utile avant tout accès HTTP).
    await authRun(
      `INSERT INTO tenants (user_id, course, schema_name, last_seen) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, course) DO UPDATE SET last_seen = excluded.last_seen`,
      seedUser, course, `t_${seedUser}_${course}`.toLowerCase(), nowStr()
    );
    log(`seed ${course} : OK`);
  }
}

/**
 * L'isolation entre utilisateurs repose sur le schéma Postgres. En SQLite il
 * n'existe qu'UNE base par cours : avec l'authentification activée, tous les
 * comptes partageraient examens, faiblesses et file de jobs. On refuse cette
 * combinaison au démarrage plutôt que de la découvrir en production.
 */
function assertIsolationSane(): void {
  if (process.env.AUTH_ENABLED === "1" && dbDriverName() !== "postgres") {
    throw new Error(
      "Configuration dangereuse : AUTH_ENABLED=1 avec le driver sqlite. " +
      "L'isolation entre utilisateurs exige DB_DRIVER=postgres + DATABASE_URL " +
      "(en sqlite, tous les comptes partagent la même base de cours)."
    );
  }
}

// ── B′) les cours en base ─────────────────────────────────────────
/**
 * Matérialise le catalogue historique dans la table `courses` du store global,
 * puis remplit le cache. Idempotent et NON destructif : une ligne déjà présente
 * n'est jamais réécrite, et AUCUNE donnée de cours n'est déplacée — les cours
 * migrés gardent leurs chemins et leurs tenants (`t_<user>_<cours>`) d'origine.
 * Propriétaire : CORTEX_OWNER_USER_ID / CORTEX_OWNER_EMAIL, sinon l'utilisateur
 * qui possède déjà le tenant du cours (cf. db/courses-store).
 */
async function migrateCourses(): Promise<void> {
  const { migrateLegacyCourses, removeEmptyFakeCourse } = await import("../db/courses-store");
  const r = await migrateLegacyCourses();
  // Le cours factice de démonstration n'a rien à faire en production : retiré
  // s'il est vide. Jamais bloquant : l'entrypoint est en set -e, une purge
  // ratée ne doit pas empêcher le service de démarrer.
  try {
    const fake = await removeEmptyFakeCourse();
    if (fake.removed) log("cours factice « fictif » retiré (vide)");
    else if (fake.reason && fake.reason !== "absent") log(`cours factice « fictif » conservé : ${fake.reason}`);
  } catch (e) {
    log(`cours factice : purge ignorée (${(e as Error).message})`);
  }
  log(
    `cours en base : ${r.created.length} créé(s)${r.created.length ? ` [${r.created.join(", ")}]` : ""}` +
    ` · ${r.kept.length} déjà présent(s)${r.skipped.length ? ` · ${r.skipped.length} ignoré(s) (aucune donnée) [${r.skipped.join(", ")}]` : ""}`
  );
  await ensureCoursesLoaded();
}

async function main(): Promise<void> {
  log(`démarrage — DB_DRIVER=${dbDriverName()} · data=${dataRoot()} · seed=[${process.env.CORTEX_SEED_COURSES ?? ""}]`);
  // Une mise en ligne (NODE_ENV=production) ou une instance qui encaisse
  // (BILLING_ENABLED=1) sans AUTH_ENABLED=1 servirait tout le monde comme « owner ».
  assertAuthRequired();
  assertLlmProviderAllowed();
  assertIsolationSane();
  initVolume();
  await migrateCourses();
  await migrateTenants();
  await seedCourses();
  log("terminé");
  process.exit(0);
}

main().catch((e) => {
  console.error("[prod-boot] ÉCHEC :", e);
  process.exit(1);
});
