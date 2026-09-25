import path from "node:path";
import type { CourseRow } from "@/db/courses-store";

/**
 * COUCHE D'ACCÈS AUX COURS (« les cours en base »).
 *
 * Un cours n'est plus un enregistrement figé en TypeScript : il vit dans la table
 * `courses` du store GLOBAL et appartient à un utilisateur (cf. db/courses-store).
 * Ce module en est la façade : un CACHE mémoire, alimenté depuis la base, plus les
 * quelques dérivations (chemins, libellé de prompt) que le moteur consomme.
 *
 * POURQUOI LE CACHE EST SYNCHRONE — `getCourse()` est appelé au cœur du moteur
 * (rendu LaTeX, composition, vérification, profils). Le rendre `async` obligerait
 * à rendre async la construction des prompts, donc à en changer l'ordre d'exécution :
 * c'est exactement ce que l'invariant de non-régression interdit. Le cache est donc
 * lu de façon synchrone et rempli :
 *   - sqlite (dev, CI, tests) : à la demande, en lecture directe (better-sqlite3 est
 *     synchrone) — aucune cérémonie, développement à coût nul préservé ;
 *   - postgres (produit) : explicitement par `await ensureCoursesLoaded()` au
 *     démarrage du serveur (instrumentation.ts), du worker et des scripts, puis
 *     rafraîchi à chaque écriture.
 * Cache froid en postgres ⇒ erreur EXPLICITE, jamais un repli silencieux.
 */

export type CourseConfig = {
  id: string;
  /** Propriétaire du cours (identifiant du compte). */
  ownerUserId: string;
  /** Libellé long (UI). */
  name: string;
  /** Libellé court pour le sélecteur (ex. « CS-202 »). */
  short: string;
  /** Code affiché sur la garde / dans les prompts (ex. « CS-202 »). */
  examCode: string;
  /** Matière (ex. « Computer Systems »). */
  examName: string;
  /** Type d'examen (ex. « Final Exam »). */
  examKind: string;
  /** Établissement (ex. « EPFL »). */
  university: string;
  /** Les lignes institutionnelles de la garde. */
  universityLines: string[];
  /** Faculté (garde). */
  faculty: string;
  /** Enseignant·es. */
  profs: string[];
  /** Langue de la matière (code ISO court). */
  language: string;
  /** Profil curaté (lib/profiles/…) ou null → profil générique dérivé de l'ADN. */
  profileId: string | null;
  /** Durée d'examen par défaut (minutes). */
  durationMin: number;
  /** Date de l'examen (ISO, optionnel) — alimente le compte à rebours du dashboard. */
  examDate?: string;
  createdAt: string;
  /**
   * Chemins HISTORIQUES stockés en base (cs-202 = data/cortex.db, data/refs…).
   * Absents pour un cours créé depuis l'interface : ses chemins sont alors
   * DÉRIVÉS sous data/u/<propriétaire>/<cours>/ — deux comptes ne partagent
   * jamais un dossier, même si leurs cours portaient le même nom.
   */
  paths?: {
    dbFile: string;
    refsRel: string;
    examsRel: string;
    uploadsRel: string;
    contentRel: string;
  };
};

export const DEFAULT_COURSE = "cs-202";

/** Identifiant de cours inconnu — 404 explicite, jamais un repli sur cs-202. */
export class UnknownCourseError extends Error {
  readonly courseId: string;
  constructor(courseId: string) {
    super(`Cours inconnu : « ${courseId} ».`);
    this.name = "UnknownCourseError";
    this.courseId = courseId;
  }
}

// ─────────────────────────────── cache ───────────────────────────────

const CACHE = new Map<string, CourseConfig>();
let loaded = false;
let loading: Promise<void> | null = null;

function parseList(raw: string | null | undefined, fallback: string[]): string[] {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : fallback;
  } catch {
    return fallback;
  }
}

/** Ligne de base → config consommée par le moteur. */
export function rowToConfig(r: CourseRow): CourseConfig {
  const name = r.name;
  const cfg: CourseConfig = {
    id: r.id,
    ownerUserId: r.owner_user_id,
    name,
    short: r.short || r.code || r.id,
    examCode: r.code ?? "",
    examName: r.exam_name ?? name,
    examKind: r.exam_kind ?? "Final Exam",
    university: r.university ?? "",
    universityLines: parseList(r.university_lines, r.university ? [r.university] : []),
    faculty: r.faculty ?? "",
    profs: parseList(r.teachers, []),
    language: r.language || "fr",
    profileId: r.profile_id ?? null,
    durationMin: r.duration_min ?? 180,
    createdAt: r.created_at,
  };
  if (r.exam_date) cfg.examDate = r.exam_date;
  // Un cours historique a ses cinq chemins en base ; un cours créé depuis
  // l'interface n'en a aucun (dérivation). Un mélange serait une ligne corrompue.
  if (r.db_file && r.refs_rel && r.exams_rel && r.uploads_rel && r.content_rel) {
    cfg.paths = {
      dbFile: r.db_file,
      refsRel: r.refs_rel,
      examsRel: r.exams_rel,
      uploadsRel: r.uploads_rel,
      contentRel: r.content_rel,
    };
  }
  return cfg;
}

function fillCache(rows: CourseRow[]): void {
  CACHE.clear();
  for (const r of rows) CACHE.set(r.id, rowToConfig(r));
  loaded = true;
}

/** Store lazy — `require` volontaire : évite un cycle d'initialisation lib ⇄ db. */
function store(): typeof import("@/db/courses-store") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("../db/courses-store") as typeof import("@/db/courses-store");
}

/**
 * Amorçage SYNCHRONE (sqlite uniquement) : un poste de dev / la CI retrouvent
 * cs-202 & co sans aucune commande préalable. La migration du catalogue
 * historique est protégée par un marqueur en base — elle ne s'exécute qu'une
 * fois, et ne ressuscite donc jamais un cours supprimé volontairement.
 */
function hydrateSync(): boolean {
  const s = store();
  if (!s.syncCapable()) return false;
  s.migrateLegacyCoursesSync();
  const rows = s.readCoursesSync();
  if (!rows) return false;
  fillCache(rows);
  return true;
}

/** Charge (une fois) le cache depuis la base. À appeler au boot serveur/worker/script. */
export async function ensureCoursesLoaded(): Promise<void> {
  if (loaded) return;
  if (!loading) loading = reloadCourses().finally(() => { loading = null; });
  return loading;
}

/** Recharge le cache depuis la base (après une écriture, ou au boot). */
export async function reloadCourses(): Promise<void> {
  const s = store();
  // Migration du catalogue historique : idempotente et marquée en base (elle ne
  // s'exécute qu'une fois, cf. db/courses-store), donc sûre à appeler ici.
  await s.migrateLegacyCourses();
  fillCache(await s.readCourses());
}

/** Vide le cache (tests, bascule de dialecte). */
export function resetCoursesCache(): void {
  CACHE.clear();
  loaded = false;
}

function cache(): Map<string, CourseConfig> {
  if (!loaded) hydrateSync();
  return CACHE;
}

// ─────────────────────────────── lecture ───────────────────────────────

/** Config d'un cours, ou undefined si inconnu. */
export function tryGetCourse(id?: string | null): CourseConfig | undefined {
  const c = cache();
  if (!id) return c.get(DEFAULT_COURSE);
  return c.get(id);
}

/**
 * Config d'un cours. Identifiant inconnu → ERREUR EXPLICITE.
 * (Auparavant, tout identifiant inconnu retombait silencieusement sur
 * cs-202 : un compte pouvait donc se voir servir la matière d'un autre.)
 */
export function getCourse(id?: string | null): CourseConfig {
  const hit = tryGetCourse(id);
  if (!hit) {
    if (!loaded) {
      throw new Error(
        "Cache des cours non chargé : appelle `await ensureCoursesLoaded()` au démarrage (voir lib/courses.ts)."
      );
    }
    throw new UnknownCourseError(id || DEFAULT_COURSE);
  }
  return hit;
}

export function courseExists(id?: string | null): boolean {
  return !!id && cache().has(id);
}

/** id de cours valide (sinon le défaut) — conservé pour les scripts qui valident une entrée. */
export function normalizeCourse(id?: string | null): string {
  return id && cache().has(id) ? id : DEFAULT_COURSE;
}

export function listCourses(): CourseConfig[] {
  return [...cache().values()];
}

export function listCourseIds(): string[] {
  return [...cache().keys()];
}

/** Cours d'un utilisateur — la seule liste qu'une interface a le droit de montrer. */
export function listCoursesOf(userId: string): CourseConfig[] {
  return listCourses().filter((c) => c.ownerUserId === userId);
}

/** Un utilisateur peut-il accéder à ce cours ? (propriétaire uniquement) */
export function ownsCourse(userId: string, courseId?: string | null): boolean {
  const c = tryGetCourse(courseId);
  return !!c && c.ownerUserId === userId;
}

/**
 * Libellé du cours pour les PROMPTS LLM — dérivé du cours ACTIF, jamais codé en
 * dur. Ex. « Computer Systems (CS-202, EPFL) ».
 */
export function courseLabel(id?: string | null): string {
  const c = getCourse(id);
  const meta = [c.examCode, c.university].filter(Boolean).join(", ");
  return meta ? `${c.examName} (${meta})` : c.examName;
}

// ─────────────────────────────── chemins ───────────────────────────────

// Racine des données mutables (DB sqlite, refs, exams, uploads). CORTEX_DATA_DIR
// permet de la déplacer sur un volume persistant en prod (Railway) ; non posée
// (dev, CI) → ./data, comportement historique inchangé.
const DATA = process.env.CORTEX_DATA_DIR
  ? path.resolve(process.env.CORTEX_DATA_DIR)
  : path.join(process.cwd(), "data");

/** Racine data effective (./data ou CORTEX_DATA_DIR) — partagée avec le store auth. */
export function dataRoot(): string {
  return DATA;
}

export type CoursePaths = {
  dbPath: string;
  refsDir: string;
  examsDir: string;
  uploadsDir: string;
  contentRoot: string;
};

/**
 * ISOLATION DISQUE PAR UTILISATEUR.
 *
 * Les ids d'examens sont SÉQUENTIELS PAR TENANT : sans préfixe utilisateur, le
 * premier examen de chaque user s'appellerait `exam-1.pdf` dans le MÊME dossier.
 * On isole donc les artefacts PRODUITS ou PERSONNELS (exams/, uploads/) dans
 * `data/u/<user>/…` dès que le mode multi-utilisateur est actif.
 *
 * Restent PARTAGÉS pour les cours HISTORIQUES (voulu) : le corpus du cours, sa
 * base et sa bibliothèque d'annales (`refs/`) — c'est le matériel du cours.
 * Un cours CRÉÉ depuis l'interface, lui, est entièrement rangé sous le dossier
 * de son propriétaire : il n'appartient qu'à lui.
 */
function multiUser(): boolean {
  return process.env.AUTH_ENABLED === "1" || (process.env.DB_DRIVER ?? "sqlite") === "postgres";
}

/** Normalisation d'un identifiant d'utilisateur en segment de chemin (= schéma PG). */
function slug(userId: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { userSlug } = require("../db/context") as typeof import("@/db/context");
  return userSlug(userId) || "owner";
}

/** Sous-dossier d'artefacts du user COURANT ("" en mono-user historique). */
function userScope(): string {
  if (!multiUser()) return "";
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { currentUser } = require("../db/context") as typeof import("@/db/context");
  return path.join("u", slug(currentUser()));
}

/** Racine d'un cours créé depuis l'interface : data/u/<propriétaire>/<cours>/. */
function ownedRoot(c: CourseConfig): string {
  return path.join(DATA, "u", slug(c.ownerUserId), c.id);
}

/** Chemins ABSOLUS d'un cours. cs-202 mono-user = exactement les chemins historiques. */
export function coursePaths(id?: string | null): CoursePaths {
  const c = getCourse(id);
  if (!c.paths) {
    const root = ownedRoot(c);
    return {
      dbPath: path.join(root, `${c.id}.db`),
      refsDir: path.join(root, "refs"),
      examsDir: path.join(root, "exams"),
      uploadsDir: path.join(root, "uploads"),
      contentRoot: path.join(root, "content"),
    };
  }
  const scope = userScope();
  return {
    dbPath: path.join(DATA, c.paths.dbFile),
    refsDir: path.join(DATA, c.paths.refsRel),
    examsDir: path.join(DATA, scope, c.paths.examsRel),
    uploadsDir: path.join(DATA, scope, c.paths.uploadsRel),
    contentRoot: path.resolve(process.cwd(), c.paths.contentRel),
  };
}

/** Chemin absolu de la DB d'un cours (utilisé par db/client). */
export function courseDbPath(id?: string | null): string {
  return coursePaths(id).dbPath;
}
