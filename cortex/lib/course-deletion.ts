/**
 * SUPPRESSION D'UN COURS AVEC SES DONNÉES (propriétaire seulement).
 *
 * Efface le schéma tenant (Postgres) ou la base du cours (sqlite), la ligne du
 * registre `tenants`, les fichiers data/u/<slug>/<cours>/ et enfin la fiche.
 * Les cours HISTORIQUES (cs-202, algo, ml : chemins partagés en base, corpus du
 * cours de référence et invariant de non-régression) sont refusés : on ne peut
 * que les retirer de sa liste, pas détruire leur matériel.
 */
import fs from "node:fs";
import path from "node:path";
import { authGet, authRun } from "@/db/auth-store";
import { userSlug } from "@/db/context";
import { dbDriverName } from "@/db/q";
import { cancelUserJobs } from "@/lib/account-deletion";
import { dataRoot, ensureCoursesLoaded, listCoursesOf, reloadCourses } from "@/lib/courses";
import { deleteCourseRow } from "@/db/courses-store";
import { log } from "@/lib/metrics";

export type CourseDeletion =
  | { ok: true; id: string; residues: string[] }
  | { ok: false; status: 404 | 409; error: string };

export async function deleteCourseWithData(userId: string, courseId: string): Promise<CourseDeletion> {
  await ensureCoursesLoaded();
  const course = listCoursesOf(userId).find((c) => c.id === courseId);
  if (!course) return { ok: false, status: 404, error: "Cours introuvable." };
  if (course.paths) {
    return {
      ok: false, status: 409,
      error: "Ce cours historique partage son corpus et ses annales avec l'instance (cours de référence) : ses données ne peuvent pas être supprimées depuis l'application.",
    };
  }
  const residues: string[] = [];
  await cancelUserJobs(userId, [courseId], residues);

  if (dbDriverName() === "postgres") {
    const tenant = await authGet<{ schema_name: string }>(`SELECT schema_name FROM tenants WHERE user_id = ? AND course = ?`, userId, courseId);
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
  }
  // Cours créé depuis l'interface : tout vit sous data/u/<slug>/<cours>/ (base sqlite comprise).
  const root = path.join(dataRoot(), "u", userSlug(userId), courseId);
  try {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  } catch (e) {
    residues.push(`fichiers ${root} : ${e instanceof Error ? e.message : String(e)}`);
  }
  const n = await deleteCourseRow(courseId, userId);
  if (!n) return { ok: false, status: 404, error: "Cours introuvable." };
  await reloadCourses();
  if (residues.length) log("warn", "course.delete_residue", { user: userId, course: courseId, residues });
  log("info", "course.deleted", { user: userId, course: courseId });
  return { ok: true, id: courseId, residues };
}
