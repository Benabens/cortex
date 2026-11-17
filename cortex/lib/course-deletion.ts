/**
 * SUPPRESSION D'UN COURS AVEC SES DONNÉES (propriétaire seulement).
 *
 * Ordre : marqueur « en suppression » (aucun job ne démarre, le worker en
 * retard s'abstient) → annulation des jobs (un échec ANNULE la suppression) →
 * schéma tenant (Postgres) ou base du cours (sqlite) → ligne du registre →
 * fichiers data/u/<slug>/<cours>/ → fiche. Refusé : cours HISTORIQUES (id du
 * catalogue cs-202/algo/ml ou chemins partagés en base — corpus du cours de
 * référence, invariant de non-régression), tout cours du compte PROPRIÉTAIRE
 * de l'instance, et un schéma encore référencé par une autre ligne du registre
 * (ancienne troncature : deux cours longs ont pu partager un schéma).
 */
import fs from "node:fs";
import path from "node:path";
import { storage } from "@/lib/storage";
import { authAll, authGet, authRun } from "@/db/auth-store";
import { userSlug } from "@/db/context";
import { dbDriverName, nowStr } from "@/db/q";
import { cancelUserJobs, isOwnerAccount } from "@/lib/account-deletion";
import { contactEmail } from "@/lib/contact";
import { LEGACY_COURSES } from "@/lib/courses-legacy";
import { dataRoot, ensureCoursesLoaded, listCoursesOf, reloadCourses } from "@/lib/courses";
import { deleteCourseRow } from "@/db/courses-store";
import { log } from "@/lib/metrics";
import { ownedCourseCacheDir } from "@/lib/page-cache";
import { refusal, type Refusal } from "@/lib/i18n/user-error";

const LEGACY_IDS = new Set(LEGACY_COURSES.map((c) => c.id));

export type CourseDeletion =
  | { ok: true; id: string; residues: string[] }
  | ({ ok: false } & Refusal<404 | 409>);

export type CourseDeletionOptions = {
  /** (tests) remplace l'annulation des jobs. */
  cancelJobs?: (userId: string, courses: string[], errors: string[]) => Promise<void>;
  /**
   * Contourne UNIQUEMENT le refus « compte propriétaire » — jamais les cours
   * historiques/partagés. Réservé à scripts/delete-course.ts (admin, CLI) ;
   * jamais passée par une route HTTP.
   */
  allowOwner?: boolean;
};

type Rejection = { ok: false } & Refusal<404 | 409>;
const rejection = <S extends 404 | 409>(status: S, code: Parameters<typeof refusal<S>>[1], params?: Parameters<typeof refusal<S>>[2]): Rejection => ({ ok: false, ...refusal(status, code, params) });
type Checked = {
  tenant: { schema_name: string } | undefined;
};

/** Vérifications communes à la suppression et à son aperçu (dry-run). */
async function checkDeletable(userId: string, courseId: string, allowOwner: boolean): Promise<Rejection | Checked> {
  await ensureCoursesLoaded();
  const course = listCoursesOf(userId).find((c) => c.id === courseId);
  if (!course) return rejection(404, "course_not_found");
  if (LEGACY_IDS.has(courseId) || course.paths) {
    return rejection(409, "course_historical_deletion_forbidden");
  }
  if (!allowOwner && (await isOwnerAccount(userId))) {
    return rejection(409, "owner_course_deletion_forbidden");
  }
  const pg = dbDriverName() === "postgres";
  const tenant = pg
    ? await authGet<{ schema_name: string }>(`SELECT schema_name FROM tenants WHERE user_id = ? AND course = ?`, userId, courseId)
    : undefined;
  if (tenant) {
    const sharers = await authAll<{ user_id: string; course: string }>(`SELECT user_id, course FROM tenants WHERE schema_name = ?`, tenant.schema_name);
    if (sharers.length > 1) {
      log("error", "course.delete_shared_schema", { user: userId, course: courseId, schema: tenant.schema_name, sharers });
      return rejection(409, "course_shared_schema_deletion_forbidden", { email: contactEmail() });
    }
  }
  return { tenant };
}

export type CourseDeletionPreview =
  | { ok: true; id: string; schema?: string; files: number; bytes: number }
  | Rejection;

/** Aperçu LECTURE SEULE de ce que deleteCourseWithData(…, { allowOwner: true }) supprimerait. */
export async function previewCourseDeletion(userId: string, courseId: string): Promise<CourseDeletionPreview> {
  const check = await checkDeletable(userId, courseId, true);
  if ("ok" in check) return check;
  const root = path.join(dataRoot(), "u", userSlug(userId), courseId);
  const entries = await storage().list(root).catch(() => []);
  return {
    ok: true,
    id: courseId,
    schema: check.tenant?.schema_name,
    files: entries.length,
    bytes: entries.reduce((sum, e) => sum + e.size, 0),
  };
}

/** Résout --user (scripts/delete-course.ts) : identifiant direct, sinon e-mail (insensible à la casse). */
export async function resolveUserId(identifier: string): Promise<string | undefined> {
  const byId = await authGet<{ id: string }>(`SELECT id FROM users WHERE id = ?`, identifier);
  if (byId) return byId.id;
  const byEmail = await authGet<{ id: string }>(`SELECT id FROM users WHERE lower(email) = lower(?)`, identifier);
  return byEmail?.id;
}

/** Texte console de l'aperçu (dry-run) — cf. scripts/delete-course.ts. */
export function describePreview(userId: string, p: CourseDeletionPreview): string {
  if (!p.ok) return `Refusé : ${p.error}`;
  return [
    `Dry-run — rien n'est supprimé.`,
    `  cours : ${p.id} (utilisateur ${userId})`,
    p.schema ? `  schéma Postgres : ${p.schema}` : `  pas de schéma Postgres (sqlite, ou pas encore de tenant)`,
    `  fichiers : ${p.files} (${p.bytes} octets)`,
    `  ligne du registre (courses) : 1`,
    `→ relancer avec --yes pour exécuter.`,
  ].join("\n");
}

/** Texte console du résultat d'exécution — cf. scripts/delete-course.ts. */
export function describeDeletion(r: CourseDeletion): string {
  if (!r.ok) return `Échec : ${r.error}`;
  return `Supprimé : ${r.id}${r.residues.length ? ` — résidus : ${r.residues.join("; ")}` : ""}`;
}

/** Marqueur partagé (base) : vu par toutes les instances et par les workers. */
export async function markCourseDeleting(userId: string, courseId: string): Promise<void> {
  await authRun(
    `INSERT INTO course_deletions (user_id, course, started_at) VALUES (?,?,?) ON CONFLICT (user_id, course) DO NOTHING`,
    userId, courseId, nowStr(),
  );
}
export async function unmarkCourseDeleting(userId: string, courseId: string): Promise<void> {
  await authRun(`DELETE FROM course_deletions WHERE user_id = ? AND course = ?`, userId, courseId);
}
export async function isCourseDeleting(userId: string, courseId: string): Promise<boolean> {
  try {
    return !!(await authGet(`SELECT 1 FROM course_deletions WHERE user_id = ? AND course = ?`, userId, courseId));
  } catch {
    return false; // store indisponible : on ne bloque pas les jobs pour autant (la suppression elle-même échouerait)
  }
}

export async function deleteCourseWithData(userId: string, courseId: string, opts: CourseDeletionOptions = {}): Promise<CourseDeletion> {
  const check = await checkDeletable(userId, courseId, opts.allowOwner ?? false);
  if ("ok" in check) return check;
  const { tenant } = check;

  await markCourseDeleting(userId, courseId);
  const residues: string[] = [];
  const cancelErrors: string[] = [];
  await (opts.cancelJobs ?? cancelUserJobs)(userId, [courseId], cancelErrors);
  // Une énumération impossible (schéma absent) n'est pas un job qui résiste.
  const stuck = cancelErrors.filter((e) => e.startsWith("cancel job"));
  if (stuck.length) {
    await unmarkCourseDeleting(userId, courseId);
    log("warn", "course.delete_jobs_stuck", { user: userId, course: courseId, stuck });
    return rejection(409, "course_active_generation_stop_failed");
  }
  residues.push(...cancelErrors);

  if (tenant) {
    try {
      await authRun(`DROP SCHEMA IF EXISTS "${tenant.schema_name}" CASCADE`);
      await authRun(`DELETE FROM tenants WHERE user_id = ? AND course = ?`, userId, courseId);
      const { forgetTenant } = await import("@/db/driver-postgres");
      forgetTenant(userId, courseId);
    } catch (e) {
      residues.push(`schéma ${tenant.schema_name} : ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Purges de process, quel que soit le stockage : le mémo du schéma ne doit pas
  // faire croire à des tables dans une base recréée, et la connexion sqlite doit
  // être fermée AVANT l'effacement du fichier (un descripteur ouvert garde
  // l'inode : le cours recréé lisait encore l'ancienne base).
  const { forgetSchemaMemo } = await import("@/db/q");
  forgetSchemaMemo(userId, courseId);
  const { forgetCourseConnection } = await import("@/db/client");
  forgetCourseConnection(courseId);
  // Cours créé depuis l'interface : tout vit sous data/u/<slug>/<cours>/ (base sqlite comprise).
  const root = path.join(dataRoot(), "u", userSlug(userId), courseId);
  try {
    await storage().remove(root); // disque et, en stockage objet, seau
  } catch (e) {
    residues.push(`fichiers ${root} : ${e instanceof Error ? e.message : String(e)}`);
  }
  // Ses images de pages rendues (lib/page-cache), hors de data/u/.
  const cache = ownedCourseCacheDir(userId, courseId);
  try { fs.rmSync(cache, { recursive: true, force: true }); } catch (e) { residues.push(`cache ${cache} : ${e instanceof Error ? e.message : String(e)}`); }
  // Signalements des questions de ce cours (store global, lib/question-reports), quel que soit le pilote.
  try { await authRun(`DELETE FROM question_reports WHERE user_id = ? AND course = ?`, userId, courseId); } catch (e) { residues.push(`question_reports : ${e instanceof Error ? e.message : String(e)}`); }
  try { await authRun(`DELETE FROM index_usage WHERE user_id = ? AND course = ?`, userId, courseId); } catch (e) { residues.push(`index_usage : ${e instanceof Error ? e.message : String(e)}`); }
  const n = await deleteCourseRow(courseId, userId);
  await reloadCourses();
  await unmarkCourseDeleting(userId, courseId);
  if (!n) return rejection(404, "course_not_found");
  if (residues.length) log("warn", "course.delete_residue", { user: userId, course: courseId, residues });
  log("info", "course.deleted", { user: userId, course: courseId });
  return { ok: true, id: courseId, residues };
}
