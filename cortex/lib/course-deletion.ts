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
import { authAll, authGet, authRun } from "@/db/auth-store";
import { userSlug } from "@/db/context";
import { dbDriverName, nowStr } from "@/db/q";
import { cancelUserJobs, isOwnerAccount } from "@/lib/account-deletion";
import { LEGACY_COURSES } from "@/lib/courses-legacy";
import { dataRoot, ensureCoursesLoaded, listCoursesOf, reloadCourses } from "@/lib/courses";
import { deleteCourseRow } from "@/db/courses-store";
import { log } from "@/lib/metrics";

const LEGACY_IDS = new Set(LEGACY_COURSES.map((c) => c.id));

export type CourseDeletion =
  | { ok: true; id: string; residues: string[] }
  | { ok: false; status: 404 | 409; error: string };

export type CourseDeletionOptions = {
  /** (tests) remplace l'annulation des jobs. */
  cancelJobs?: (userId: string, courses: string[], errors: string[]) => Promise<void>;
};

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
  await ensureCoursesLoaded();
  const course = listCoursesOf(userId).find((c) => c.id === courseId);
  if (!course) return { ok: false, status: 404, error: "Cours introuvable." };
  if (LEGACY_IDS.has(courseId) || course.paths) {
    return {
      ok: false, status: 409,
      error: "Ce cours historique partage son corpus et ses annales avec l'instance (cours de référence) : ses données ne peuvent pas être supprimées depuis l'application.",
    };
  }
  if (await isOwnerAccount(userId)) {
    return {
      ok: false, status: 409,
      error: "Le compte propriétaire de l'instance ne supprime pas de cours depuis l'application : passe par les scripts d'administration.",
    };
  }
  const pg = dbDriverName() === "postgres";
  const tenant = pg
    ? await authGet<{ schema_name: string }>(`SELECT schema_name FROM tenants WHERE user_id = ? AND course = ?`, userId, courseId)
    : undefined;
  if (tenant) {
    const sharers = await authAll<{ user_id: string; course: string }>(`SELECT user_id, course FROM tenants WHERE schema_name = ?`, tenant.schema_name);
    if (sharers.length > 1) {
      log("error", "course.delete_shared_schema", { user: userId, course: courseId, schema: tenant.schema_name, sharers });
      return {
        ok: false, status: 409,
        error: "Les données de ce cours sont partagées avec un autre cours (schéma commun) : suppression refusée, contacte le support.",
      };
    }
  }

  await markCourseDeleting(userId, courseId);
  const residues: string[] = [];
  const cancelErrors: string[] = [];
  await (opts.cancelJobs ?? cancelUserJobs)(userId, [courseId], cancelErrors);
  // Une énumération impossible (schéma absent) n'est pas un job qui résiste.
  const stuck = cancelErrors.filter((e) => e.startsWith("cancel job"));
  if (stuck.length) {
    await unmarkCourseDeleting(userId, courseId);
    log("warn", "course.delete_jobs_stuck", { user: userId, course: courseId, stuck });
    return { ok: false, status: 409, error: "Une génération en cours n'a pas pu être arrêtée : réessaie dans un instant." };
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
  // Cours créé depuis l'interface : tout vit sous data/u/<slug>/<cours>/ (base sqlite comprise).
  const root = path.join(dataRoot(), "u", userSlug(userId), courseId);
  try {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  } catch (e) {
    residues.push(`fichiers ${root} : ${e instanceof Error ? e.message : String(e)}`);
  }
  const n = await deleteCourseRow(courseId, userId);
  await reloadCourses();
  await unmarkCourseDeleting(userId, courseId);
  if (!n) return { ok: false, status: 404, error: "Cours introuvable." };
  if (residues.length) log("warn", "course.delete_residue", { user: userId, course: courseId, residues });
  log("info", "course.deleted", { user: userId, course: courseId });
  return { ok: true, id: courseId, residues };
}
