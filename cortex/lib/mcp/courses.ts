import { runWithCourse } from "@/db/client";
import { runWithUser } from "@/db/context";
import { ensureCoursesLoaded, listCoursesOf, ownsCourse, type CourseConfig } from "@/lib/courses";
import { clip } from "./content";
import { ToolError } from "./tool";

/**
 * COURS D'UN APPEL MCP. Le modèle désigne un cours comme la personne en parle
 * (« CS-233 », « Algèbre linéaire ») ; la recherche se fait UNIQUEMENT parmi les
 * cours du compte du jeton. Un cours d'un autre compte n'est pas « interdit »,
 * il est introuvable : même réponse qu'un cours inexistant (comme les routes,
 * cf. lib/req CourseAccessError), rien qui permette d'énumérer les matières
 * des autres.
 */

const norm = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[\s_-]+/g, "");

export function courseLabel(c: CourseConfig): string {
  return c.examCode && c.examCode !== c.name ? `${c.examCode} — ${c.name}` : c.name;
}

export async function resolveCourse(userId: string, ref: string | undefined): Promise<CourseConfig> {
  await ensureCoursesLoaded();
  const mine = listCoursesOf(userId);
  const wanted = ref?.trim();
  if (!wanted) {
    if (mine.length === 1) return mine[0];
    if (!mine.length) throw new ToolError("not_found", "Aucun cours sur ce compte : crée un cours dans Cortex et importe tes documents.");
    throw new ToolError("invalid_input",
      `Ce compte a ${mine.length} cours : précise lequel avec « course ». ${mine.map((c) => `${courseLabel(c)} (id ${c.id})`).join(" ; ")}.`);
  }
  const r = norm(wanted);
  const hit = mine.find((c) => c.id === wanted)
    ?? mine.find((c) => norm(c.examCode) === r || norm(c.short) === r)
    ?? mine.find((c) => norm(c.name) === r);
  // Défense en profondeur : la liste est déjà celle du compte.
  if (!hit || !ownsCourse(userId, hit.id)) {
    throw new ToolError("not_found", `Cours introuvable sur ce compte : « ${clip(wanted, 80)} ». La liste des cours est donnée par list_courses.`);
  }
  return hit;
}

/** Exécute `fn` dans le contexte (compte, cours) : tenant Postgres, chemins, prompts scopés. */
export async function inCourseOf<T>(userId: string, ref: string | undefined, fn: (c: CourseConfig) => Promise<T>): Promise<T> {
  const course = await resolveCourse(userId, ref);
  return runWithUser(userId, () => runWithCourse(course.id, () => fn(course)));
}
