import { enterCourse } from "@/db/client";
import { enterUser } from "@/db/context";
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
 * Lit le cours ET l'utilisateur de la requête, et les installe comme contexte
 * courant pour toute la suite du handler (DB/tenant, chemins, prompts scopés).
 * À appeler en 1ʳᵉ ligne. Retourne l'id du cours.
 * Sans paramètre/inconnu → cs-202 ; sans auth (défaut) → user « owner » —
 * comportement identique à avant. Le header x-cortex-user est posé par
 * proxy.ts UNIQUEMENT (strippé des requêtes entrantes — non usurpable).
 */
export function useCourse(req: Request): string {
  enterUser(req.headers?.get?.("x-cortex-user") ?? null);
  return enterCourse(courseOf(req));
}
