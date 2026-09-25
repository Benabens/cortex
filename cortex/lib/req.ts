import { NextResponse } from "next/server";
import { enterCourse } from "@/db/client";
import { enterUser } from "@/db/context";
import { courseExists, DEFAULT_COURSE, ownsCourse } from "@/lib/courses";

/**
 * Cours demandé par la requête : query `?course=` puis header `x-cortex-course`,
 * sinon le cours par défaut. L'identifiant est rendu TEL QUEL — un cours inconnu
 * n'est plus remplacé par cs-202 (la garde d'accès est dans `useCourse`).
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
 * Installe l'UTILISATEUR de la requête sans cours — pour les routes qui n'en
 * dépendent pas (facturation, catalogue des cours). Le header x-cortex-user est
 * posé par proxy.ts uniquement ; sans auth → « owner ».
 */
export function useUser(req: Request): string {
  return enterUser(req.headers?.get?.("x-cortex-user") ?? null);
}

/** Cours inexistant OU appartenant à un autre compte — rendu 404 (jamais 403 :
 *  révéler « ce cours existe mais n'est pas à toi » énumérerait les matières
 *  des autres). Portée par `useCourse` pour qu'AUCUNE route ne puisse installer
 *  le contexte d'un cours non possédé, même par oubli de garde. */
export class CourseAccessError extends Error {
  readonly status = 404;
  readonly courseId: string;
  constructor(courseId: string) {
    super(`Cours inconnu : « ${courseId} ».`);
    this.name = "CourseAccessError";
    this.courseId = courseId;
  }
}

/**
 * Lit le cours ET l'utilisateur de la requête, VÉRIFIE que le cours existe et
 * appartient à cet utilisateur, puis les installe comme contexte courant pour
 * toute la suite du handler (DB/tenant, chemins, prompts scopés).
 *
 * La garde de propriété vit ICI et non dans chaque route : avant, seule
 * `useCourseOr404` vérifiait, et ~25 routes installaient le contexte d'un cours
 * arbitraire (`?course=` d'un autre compte → écriture dans ses annales,
 * création de son schéma Postgres…). Refus → `CourseAccessError` AVANT toute
 * requête au tenant : aucun `ensureTenant`/CREATE SCHEMA n'est déclenché pour
 * un cours non possédé.
 *
 * Sans paramètre → cs-202 ; sans auth (défaut) → user « owner », propriétaire
 * des cours historiques : le mode dev est inchangé. Le header x-cortex-user
 * est posé par proxy.ts UNIQUEMENT (strippé des requêtes entrantes).
 *
 * Dans une route, préférer `useCourseOr404` / `requireCourse` qui traduisent
 * l'erreur en réponse 404 ; `useCourse` nu ne doit servir qu'aux contextes qui
 * gèrent l'exception eux-mêmes.
 */
export function useCourse(req: Request): string {
  const user = useUser(req);
  const course = courseOf(req);
  if (!courseExists(course) || !ownsCourse(user, course)) throw new CourseAccessError(course);
  return enterCourse(course);
}

function deniedResponse(e: CourseAccessError): NextResponse {
  return NextResponse.json({ error: e.message }, { status: e.status });
}

/**
 * Variante « route » : installe le contexte {user, cours} et renvoie directement
 * un 404 si le cours n'est pas accessible, sinon null.
 *
 *   const denied = useCourseOr404(req);
 *   if (denied) return denied;
 */
export function useCourseOr404(req: Request): NextResponse | null {
  try {
    useCourse(req);
    return null;
  } catch (e) {
    if (e instanceof CourseAccessError) return deniedResponse(e);
    throw e;
  }
}

/**
 * Même garde, quand la route a besoin de l'id du cours :
 *
 *   const { course, denied } = requireCourse(req);
 *   if (denied) return denied;
 */
export function requireCourse(req: Request): { course: string; denied: null } | { course: null; denied: NextResponse } {
  try {
    return { course: useCourse(req), denied: null };
  } catch (e) {
    if (e instanceof CourseAccessError) return { course: null, denied: deniedResponse(e) };
    throw e;
  }
}
