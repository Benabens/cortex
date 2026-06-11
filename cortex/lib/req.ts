import { enterCourse } from "@/db/client";
import { normalizeCourse } from "@/lib/courses";

/** Cours demandé par la requête : query `?course=` puis header `x-cortex-course`, sinon cs-202. */
export function courseOf(req: Request): string {
  let id: string | null = null;
  try {
    id = new URL(req.url).searchParams.get("course");
  } catch {}
  if (!id) id = req.headers?.get?.("x-cortex-course") ?? null;
  return normalizeCourse(id);
}

/**
 * Lit le cours de la requête ET l'installe comme cours courant pour toute la suite
 * du handler (DB, chemins, prompts scopés). À appeler en 1ʳᵉ ligne. Retourne l'id.
 * Sans paramètre/inconnu → cs-202 (comportement identique à avant).
 */
export function useCourse(req: Request): string {
  return enterCourse(courseOf(req));
}
