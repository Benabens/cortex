import { NextRequest, NextResponse } from "next/server";
import { insertCourse } from "@/db/courses-store";
import { buildCourseRow, InvalidCourseError } from "@/lib/course-create";
import { ensureCoursesLoaded, listCoursesOf, reloadCourses } from "@/lib/courses";
import { toDto } from "@/lib/course-dto";
import { useUser } from "@/lib/req";
import { readJson, withBodyLimit } from "@/lib/upload-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * LES COURS DE L'UTILISATEUR CONNECTÉ.
 *
 * Scopé au compte : la liste ne contient JAMAIS le cours d'un autre. C'est cette
 * route qui alimente le sélecteur — il n'y a plus de catalogue en dur côté client.
 * L'identité vient du header interne `x-cortex-user` (posé par proxy.ts, strippé
 * des requêtes entrantes) ; sans authentification, c'est « owner » (dev mono-user).
 */

/** Installe l'utilisateur de la requête et garantit un cache de cours à jour. */
async function user(req: NextRequest): Promise<string> {
  const u = useUser(req);
  await ensureCoursesLoaded();
  return u;
}

export async function GET(req: NextRequest) {
  const u = await user(req);
  const courses = listCoursesOf(u).map(toDto);
  return NextResponse.json({ courses });
}

export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const u = await user(req);
  const body = await readJson(req, null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Corps JSON attendu." }, { status: 400 });
  }
  let row;
  try {
    row = buildCourseRow(body, u);
  } catch (e) {
    if (e instanceof InvalidCourseError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
  await insertCourse(row);
  // Le cache est la source de lecture du moteur : il doit voir le cours neuf
  // AVANT que l'interface ne bascule dessus.
  await reloadCourses();
  const created = listCoursesOf(u).find((c) => c.id === row.id);
  return NextResponse.json({ course: created ? toDto(created) : null }, { status: 201 });
}
)