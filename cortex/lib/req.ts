import { NextResponse } from "next/server";
import { enterCourse } from "@/db/client";
import { currentUser, enterUser } from "@/db/context";
import { courseExists, DEFAULT_COURSE, ownsCourse } from "@/lib/courses";

/**
 * Cours demandé par la requête : query `?course=` puis header `x-cortex-course`,
 * sinon le cours par défaut. L'identifiant est rendu TEL QUEL — un cours inconnu
 * n'est plus remplacé par cs-202 (cf. `courseDenied` pour la garde d'accès).
 */
export function courseOf(req: Request): string {
  let id: string | null = null;
  try {
    id = new URL(req.url).searchParams.get("course");
  } catch {}
  if (!id) id = req.headers?.get?.("x-cortex-course") ?? null;
  return id || DEFAULT_COURSE;
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

/**
 * GARDE D'ACCÈS AU COURS — à appeler APRÈS `useCourse(req)` (qui installe le
 * user courant). Renvoie un message d'erreur, ou null si l'accès est légitime.
 *
 * Deux refus distincts, tous deux rendus en 404 côté route (ne pas révéler
 * l'existence du cours d'un autre compte) :
 *  - le cours n'existe pas ;
 *  - il existe mais appartient à quelqu'un d'autre. C'est ce second cas qui
 *    empêche un compte de lire les annales d'un autre via `?course=`, les
 *    dossiers d'un cours créé depuis l'interface étant rangés sous son
 *    propriétaire (cf. lib/courses coursePaths).
 */
export function courseDenied(courseId: string): string | null {
  if (!courseExists(courseId)) return `Cours inconnu : « ${courseId} ».`;
  if (!ownsCourse(currentUser(), courseId)) return `Cours inconnu : « ${courseId} ».`;
  return null;
}

/**
 * Variante « route » de `courseDenied` : installe le contexte {user, cours} et
 * renvoie directement un 404 si le cours n'est pas accessible, sinon null.
 *
 *   const denied = useCourseOr404(req);
 *   if (denied) return denied;
 */
export function useCourseOr404(req: Request): NextResponse | null {
  const course = useCourse(req);
  const msg = courseDenied(course);
  return msg ? NextResponse.json({ error: msg }, { status: 404 }) : null;
}
