import { apiError } from "@/lib/i18n/api-error";
import { NextRequest, NextResponse } from "next/server";
import { updateCourseRow, type CoursePatch } from "@/db/courses-store";
import { InvalidCourseError, declaredFormatColumn, noTexCommand, parseTeachers } from "@/lib/course-create";
import { ensureCoursesLoaded, listCoursesOf, ownsCourse, reloadCourses } from "@/lib/courses";
import { toDto } from "@/lib/course-dto";
import { useUser } from "@/lib/req";
import { readJson, withBodyLimit } from "@/lib/upload-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * MODIFICATION / RETRAIT d'un cours, scopés au propriétaire.
 *
 * Un cours qui n'appartient pas au demandeur répond 404 (et pas 403) : révéler
 * « ce cours existe mais n'est pas à toi » énumère les matières des autres.
 */

async function guard(req: NextRequest, id: string): Promise<{ user: string } | NextResponse> {
  const u = useUser(req);
  await ensureCoursesLoaded();
  if (!ownsCourse(u, id)) return apiError(req, "course_not_found", 404);
  return { user: u };
}

function patchOf(body: Record<string, unknown>): CoursePatch {
  const patch: CoursePatch = {};
  const text = (v: unknown, max: number, field: string): string => {
    if (typeof v !== "string") throw new InvalidCourseError({ code: "course_field_must_be_text", params: { field } });
    const s = v.trim().replace(/\s+/g, " ");
    noTexCommand(s, `Le champ « ${field} »`);
    if (s.length > max) throw new InvalidCourseError({ code: "course_field_too_long", params: { field, max } });
    return s;
  };
  if (body.name !== undefined) {
    const name = text(body.name, 80, "nom");
    if (name.length < 2) throw new InvalidCourseError({ code: "course_name_too_short" });
    patch.name = name;
    patch.exam_name = name;
  }
  if (body.code !== undefined) {
    const code = text(body.code, 24, "code");
    patch.code = code || null;
    patch.short = code || undefined;
  }
  if (body.university !== undefined) {
    const uni = text(body.university, 80, "université");
    patch.university = uni || null;
    patch.university_lines = JSON.stringify(uni ? [uni] : []);
  }
  if (body.teachers !== undefined) patch.teachers = JSON.stringify(parseTeachers(body.teachers));
  if (body.examDate !== undefined) {
    const d = text(body.examDate, 10, "date d'examen");
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new InvalidCourseError({ code: "course_exam_date_expected" });
    patch.exam_date = d || null;
  }
  // Format d'examen déclaré : objet {kind, questionCount, durationMin, language}, ou null pour l'effacer.
  if (body.examFormat !== undefined) patch.exam_format = declaredFormatColumn(body.examFormat);
  if (body.durationMin !== undefined) {
    const n = Number(body.durationMin);
    if (!Number.isFinite(n) || n < 15 || n > 600) throw new InvalidCourseError({ code: "course_duration_expected" });
    patch.duration_min = Math.round(n);
  }
  return patch;
}

export const PATCH = withBodyLimit(async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await guard(req, id);
  if (g instanceof NextResponse) return g;
  const body = await readJson(req, null);
  if (!body || typeof body !== "object") return apiError(req, "json_body_expected", 400);
  let patch: CoursePatch;
  try {
    patch = patchOf(body as Record<string, unknown>);
  } catch (e) {
    if (e instanceof InvalidCourseError) return apiError(req, e, e.status);
    throw e;
  }
  if (!Object.keys(patch).length) return apiError(req, "nothing_to_update", 400);
  const n = await updateCourseRow(id, g.user, patch);
  if (!n) return apiError(req, "course_not_found", 404);
  await reloadCourses();
  const updated = listCoursesOf(g.user).find((c) => c.id === id);
  return NextResponse.json({ course: updated ? toDto(updated) : null });
})

/**
 * SUPPRESSION — la fiche ET les données du cours (schéma tenant, fichiers,
 * registre), après confirmation côté interface. Les cours historiques du
 * propriétaire (corpus partagé, cours de référence) sont refusés en 409.
 */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await guard(req, id);
  if (g instanceof NextResponse) return g;
  const { deleteCourseWithData } = await import("@/lib/course-deletion");
  const r = await deleteCourseWithData(g.user, id);
  if (!r.ok) return apiError(req, r, r.status);
  return NextResponse.json({ ok: true, id, dataDeleted: true, residues: r.residues.length });
}
