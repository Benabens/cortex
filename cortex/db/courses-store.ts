import { LEGACY_COURSES, type LegacyCourse } from "../lib/courses-legacy";
import { authAll, authRun, authSqlite } from "./auth-store";
import { dbDriverName, nowStr } from "./q";
import { OWNER_USER } from "./context";

/**
 * STORE DES COURS — table `courses` du store GLOBAL (pas par tenant).
 *
 * Un cours appartient à un UTILISATEUR, pas à un schéma de cours : il doit donc
 * vivre là où vivent les comptes (data/auth.db en sqlite, schéma `public` en
 * postgres), et non dans `t_<user>_<cours>` qui n'existe qu'une fois le cours
 * connu. Le couple (utilisateur, cours) continue de nommer le tenant : mettre
 * les cours en base NE DÉPLACE AUCUNE DONNÉE existante.
 *
 * Deux voies d'accès, volontairement :
 *  - ASYNC (les deux dialectes) — la voie normale, via db/auth-store ;
 *  - SYNC (sqlite uniquement) — better-sqlite3 est synchrone, ce qui permet à
 *    `getCourse()` de rester SYNCHRONE (il est appelé au cœur du moteur, dans
 *    des chemins que l'on ne peut pas rendre async sans toucher aux prompts).
 *    En postgres, le cache est chargé explicitement (cf. lib/courses.ts).
 */

export type CourseRow = {
  id: string;
  owner_user_id: string;
  name: string;
  short: string;
  code: string | null;
  exam_name: string | null;
  exam_kind: string | null;
  university: string | null;
  university_lines: string | null; // JSON
  faculty: string | null;
  teachers: string | null; // JSON
  language: string;
  profile_id: string | null;
  duration_min: number | null;
  exam_date: string | null;
  /** Chemins HISTORIQUES (cs-202, algo, ml…). NULL → dérivés du propriétaire. */
  db_file: string | null;
  refs_rel: string | null;
  exams_rel: string | null;
  uploads_rel: string | null;
  content_rel: string | null;
  created_at: string;
};

const COLUMNS = [
  "id", "owner_user_id", "name", "short", "code", "exam_name", "exam_kind",
  "university", "university_lines", "faculty", "teachers", "language",
  "profile_id", "duration_min", "exam_date", "db_file", "refs_rel",
  "exams_rel", "uploads_rel", "content_rel", "created_at",
] as const;

const SELECT_ALL = `SELECT ${COLUMNS.join(", ")} FROM courses ORDER BY created_at, id`;

// ───────────────────────────── lecture ─────────────────────────────

/** Tous les cours (tous propriétaires confondus) — la couche d'accès filtre. */
export async function readCourses(): Promise<CourseRow[]> {
  return authAll<CourseRow>(SELECT_ALL);
}

/** Lecture SYNCHRONE (sqlite seulement) — renvoie null si le dialecte ne s'y prête pas. */
export function readCoursesSync(): CourseRow[] | null {
  const db = authSqlite();
  if (!db) return null;
  return db.prepare(SELECT_ALL).all() as CourseRow[];
}

// ───────────────────────────── écriture ─────────────────────────────

function insertSql(): string {
  const cols = COLUMNS.join(", ");
  const marks = COLUMNS.map(() => "?").join(", ");
  return `INSERT INTO courses (${cols}) VALUES (${marks})`;
}

function insertParams(r: CourseRow): (string | number | null)[] {
  return COLUMNS.map((c) => r[c] ?? null);
}

export async function insertCourse(row: CourseRow): Promise<void> {
  await authRun(insertSql(), ...insertParams(row));
}

/**
 * Insertion de MIGRATION : tolérante au conflit d'identifiant. Plusieurs process
 * peuvent amorcer la base en même temps (le build Next lance plusieurs workers,
 * et en production le serveur et le worker de jobs démarrent ensemble) : le
 * second ne doit pas échouer, il doit constater que la ligne est déjà là.
 */
async function insertCourseIfAbsent(row: CourseRow): Promise<void> {
  await authRun(`${insertSql()} ON CONFLICT (id) DO NOTHING`, ...insertParams(row));
}

/** Champs modifiables depuis l'interface (le slug et le propriétaire, eux, ne bougent pas). */
export type CoursePatch = Partial<
  Pick<CourseRow, "name" | "short" | "code" | "exam_name" | "university" | "university_lines" | "teachers" | "language" | "exam_date" | "duration_min">
>;

export async function updateCourseRow(id: string, ownerUserId: string, patch: CoursePatch): Promise<number> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (!entries.length) return 0;
  const set = entries.map(([k]) => `${k} = ?`).join(", ");
  const params = entries.map(([, v]) => v as string | number | null);
  const rows = await authAll<{ id: string }>(
    `UPDATE courses SET ${set} WHERE id = ? AND owner_user_id = ? RETURNING id`,
    ...params, id, ownerUserId,
  );
  return rows.length;
}

export async function deleteCourseRow(id: string, ownerUserId: string): Promise<number> {
  const rows = await authAll<{ id: string }>(
    `DELETE FROM courses WHERE id = ? AND owner_user_id = ? RETURNING id`,
    id, ownerUserId,
  );
  return rows.length;
}

// ───────────────────── migration du catalogue historique ─────────────────────

/**
 * Propriétaire des cours historiques. JAMAIS codé en dur — dans l'ordre :
 *  1. `CORTEX_OWNER_USER_ID` (identifiant exact) ;
 *  2. `CORTEX_OWNER_EMAIL` → `users.email` ;
 *  3. le registre `tenants` : l'utilisateur qui possède DÉJÀ le tenant du cours
 *     (c'est lui qui a les données — c'est la preuve la plus forte) ;
 *  4. `owner` (dev mono-utilisateur, comportement historique).
 */
async function resolveOwner(courseId: string): Promise<string> {
  const explicit = process.env.CORTEX_OWNER_USER_ID?.trim();
  if (explicit) return explicit;
  const email = process.env.CORTEX_OWNER_EMAIL?.trim();
  if (email) {
    const hit = await authAll<{ id: string }>(
      `SELECT id FROM users WHERE lower(email) = lower(?)`, email,
    ).catch(() => []);
    if (hit[0]?.id) return hit[0].id;
  }
  const owners = await authAll<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM tenants WHERE course = ?`, courseId,
  ).catch(() => []);
  if (owners.length === 1) return owners[0].user_id;
  return OWNER_USER;
}

function resolveOwnerSync(courseId: string): string {
  const explicit = process.env.CORTEX_OWNER_USER_ID?.trim();
  if (explicit) return explicit;
  const db = authSqlite();
  if (!db) return OWNER_USER;
  const email = process.env.CORTEX_OWNER_EMAIL?.trim();
  if (email) {
    try {
      const hit = db.prepare(`SELECT id FROM users WHERE lower(email) = lower(?)`).get(email) as { id?: string } | undefined;
      if (hit?.id) return hit.id;
    } catch { /* table users absente : on continue */ }
  }
  try {
    const owners = db.prepare(`SELECT DISTINCT user_id FROM tenants WHERE course = ?`).all(courseId) as { user_id: string }[];
    if (owners.length === 1) return owners[0].user_id;
  } catch { /* registre absent */ }
  return OWNER_USER;
}

/** Ligne `courses` d'un cours du catalogue historique — chemins d'origine PRÉSERVÉS. */
function legacyRow(c: LegacyCourse, ownerUserId: string, createdAt: string): CourseRow {
  return {
    id: c.id,
    owner_user_id: ownerUserId,
    name: c.name,
    short: c.short,
    code: c.examCode,
    exam_name: c.examName,
    exam_kind: c.examKind,
    university: c.university,
    university_lines: JSON.stringify(c.universityLines),
    faculty: c.faculty,
    teachers: JSON.stringify(c.profs),
    language: "fr",
    profile_id: c.profileId,
    duration_min: c.durationMin,
    exam_date: c.examDate ?? null,
    // Les chemins historiques sont STOCKÉS : c'est ce qui garantit qu'après
    // migration, cs-202 lit toujours data/cortex.db, data/refs, data/exams…
    db_file: c.dbFile,
    refs_rel: c.refsRel,
    exams_rel: c.examsRel,
    uploads_rel: c.uploadsRel,
    content_rel: c.contentRel,
    created_at: createdAt,
  };
}

export type MigrationReport = { created: string[]; kept: string[]; skipped: string[] };

/**
 * MARQUEUR de migration. Sans lui, un propriétaire qui supprime tous ses cours
 * les verrait RÉAPPARAÎTRE au rechargement suivant (table vide = « jamais
 * migrée »). La migration ne doit s'exécuter qu'une fois par base.
 */
const MIGRATED_KEY = "courses_migrated_at";

export async function coursesMigrated(): Promise<boolean> {
  const r = await authAll<{ value: string }>(`SELECT value FROM app_meta WHERE key = ?`, MIGRATED_KEY).catch(() => []);
  return r.length > 0;
}

function coursesMigratedSync(): boolean {
  const db = authSqlite();
  if (!db) return false;
  try {
    return !!db.prepare(`SELECT value FROM app_meta WHERE key = ?`).get(MIGRATED_KEY);
  } catch {
    return false;
  }
}

/**
 * La migration est-elle active ? Par défaut OUI : le catalogue historique EST
 * l'ancien registre de cours, et rien ne doit être perdu.
 * `CORTEX_MIGRATE_LEGACY_COURSES=0` permet à une installation neuve de démarrer
 * sur une base réellement vide (aucune matière préfabriquée).
 */
function migrationEnabled(): boolean {
  return process.env.CORTEX_MIGRATE_LEGACY_COURSES !== "0";
}

/**
 * MIGRATION IDEMPOTENTE du catalogue historique vers la base.
 * Ne touche JAMAIS une ligne existante : un cours déjà en base est « kept ».
 * AUCUNE donnée de cours n'est déplacée — seules des métadonnées apparaissent,
 * et les chemins d'origine (data/cortex.db, data/refs…) sont recopiés tels quels.
 */
export async function migrateLegacyCourses(): Promise<MigrationReport> {
  if (!migrationEnabled()) {
    return { created: [], kept: [], skipped: LEGACY_COURSES.map((c) => c.id) };
  }
  if (await coursesMigrated()) {
    return { created: [], kept: (await readCourses()).map((r) => r.id), skipped: [] };
  }
  const existing = new Set((await readCourses()).map((r) => r.id));
  const report: MigrationReport = { created: [], kept: [], skipped: [] };
  const at = nowStr();
  for (const c of LEGACY_COURSES) {
    if (existing.has(c.id)) { report.kept.push(c.id); continue; }
    await insertCourseIfAbsent(legacyRow(c, await resolveOwner(c.id), at));
    report.created.push(c.id);
  }
  await authRun(
    `INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING`,
    MIGRATED_KEY, at,
  );
  return report;
}

/** Même migration, voie synchrone (sqlite) — utilisée par l'amorçage de lib/courses. */
export function migrateLegacyCoursesSync(): MigrationReport {
  const db = authSqlite();
  const report: MigrationReport = { created: [], kept: [], skipped: [] };
  if (!db) return report;
  if (!migrationEnabled()) {
    report.skipped = LEGACY_COURSES.map((c) => c.id);
    return report;
  }
  if (coursesMigratedSync()) {
    report.kept = (readCoursesSync() ?? []).map((r) => r.id);
    return report;
  }
  const existing = new Set((readCoursesSync() ?? []).map((r) => r.id));
  const at = nowStr();
  const stmt = db.prepare(`${insertSql()} ON CONFLICT (id) DO NOTHING`);
  const mark = db.prepare(`INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING`);
  const rows = LEGACY_COURSES.filter((c) => !existing.has(c.id));
  report.kept = LEGACY_COURSES.filter((c) => existing.has(c.id)).map((c) => c.id);
  // Transaction : inserts + marqueur d'un seul bloc, sinon deux process qui
  // amorcent la base en parallèle laisseraient une migration à moitié faite.
  db.transaction(() => {
    for (const c of rows) stmt.run(...insertParams(legacyRow(c, resolveOwnerSync(c.id), at)));
    mark.run(MIGRATED_KEY, at);
  })();
  report.created = rows.map((c) => c.id);
  return report;
}

/** Le dialecte courant permet-il la voie synchrone ? */
export function syncCapable(): boolean {
  return dbDriverName() === "sqlite";
}
