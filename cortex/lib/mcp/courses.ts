import { runWithCourse } from "@/db/client";
import { runWithUser } from "@/db/context";
import { ensureCoursesLoaded, listCoursesOf, ownsCourse, revalidateCourses, type CourseConfig } from "@/lib/courses";
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
  (s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, "");

export function courseLabel(c: CourseConfig): string {
  return c.examCode && c.examCode !== c.name ? `${c.examCode} · ${c.name}` : c.name;
}

export async function resolveCourse(userId: string, ref: string | undefined): Promise<CourseConfig> {
  await ensureCoursesLoaded();
  try {
    return findCourse(userId, ref);
  } catch (e) {
    if (!(e instanceof ToolError)) throw e;
    // Cours inconnu ou compte vide : peut-être créé à l'instant par un autre
    // processus (script, worker). On relit la base une fois avant de répondre.
    await revalidateCourses(true);
    return findCourse(userId, ref);
  }
}

/** Même code de cours à la ponctuation près (« CS 250 », « cs-250 », « CS_250 ») : create_course refuse le doublon. */
export function sameCourseCode(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!norm(a) && norm(a) === norm(b);
}

const listOf = (courses: CourseConfig[]) => clip(courses.map((c) => `${courseLabel(c)} (id ${c.id})`).join("; "), 600);

/**
 * Le cours désigné, par ordre de confiance : id exact, code (ou abréviation), nom complet, puis
 * un morceau du nom ou du code (« enjeux mondiaux », « machine learning ») — accents, casse,
 * espaces et tirets ignorés. Plusieurs cours au même rang : on demande lequel au lieu d'en
 * prendre un au hasard (deux cours au même code se créaient avant le 22/11).
 */
function findCourse(userId: string, ref: string | undefined): CourseConfig {
  const mine = listCoursesOf(userId);
  const wanted = ref?.trim();
  if (!wanted) {
    if (mine.length === 1) return mine[0];
    if (!mine.length) throw new ToolError("not_found", "This account has no courses. Create a course in Cortex and import the student’s materials.");
    throw new ToolError("invalid_input", `This account has ${mine.length} courses. Specify one with “course”: ${listOf(mine)}.`);
  }
  const r = norm(wanted);
  const tiers: CourseConfig[][] = [
    mine.filter((c) => c.id === wanted),
    // r vide (« - ») : ne désigne aucun cours, pas tous ceux sans code.
    r ? mine.filter((c) => norm(c.examCode) === r || norm(c.short) === r) : [],
    r ? mine.filter((c) => norm(c.name) === r) : [],
    r.length >= 3 ? mine.filter((c) => norm(c.name).includes(r) || norm(c.examCode).includes(r)) : [],
  ];
  const tier = tiers.find((t) => t.length > 0) ?? [];
  if (tier.length > 1) {
    throw new ToolError("invalid_input", `“${clip(wanted, 80)}” matches ${tier.length} courses: ${listOf(tier)}. Specify one by its id.`);
  }
  const hit = tier[0];
  // Défense en profondeur : la liste est déjà celle du compte.
  if (!hit || !ownsCourse(userId, hit.id)) {
    const known = mine.length ? ` The account’s courses: ${listOf(mine)}.` : " This account has no courses.";
    throw new ToolError("not_found", `No course named “${clip(wanted, 80)}” was found in this account.${known}`);
  }
  return hit;
}

/** Exécute `fn` dans le contexte (compte, cours) : tenant Postgres, chemins, prompts scopés. */
export async function inCourseOf<T>(userId: string, ref: string | undefined, fn: (c: CourseConfig) => Promise<T>): Promise<T> {
  const course = await resolveCourse(userId, ref);
  return runWithUser(userId, () => runWithCourse(course.id, () => fn(course)));
}
