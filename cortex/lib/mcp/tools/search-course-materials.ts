import * as z from "zod/v4";
import { q } from "@/db/q";
import { search } from "@/lib/search";
import { sourceHeads } from "@/lib/source-scope";
import { clip, htmlToText } from "../content";
import { EXCERPT_CHARS, contextExcerpt, isOffProgram } from "../excerpts";
import { courseArg, courseRef, courseRefOf } from "../schemas";
import { defineTool } from "../tool";

const output = z.object({
  course: courseRef,
  query: z.string(),
  total: z.number(),
  hits: z.array(z.object({
    source_title: z.string(),
    source_type: z.string().describe("Kind of material: course slides, past finals, exercise sets, reviews…"),
    title: z.string().nullable(),
    snippet: z.string().describe("About 300 characters around the match, matched words between « »."),
  })),
  app_link: z.string(),
});

export default defineTool({
  name: "search_course_materials",
  title: "Search my course materials",
  description:
    "Full-text search in the documents the student uploaded for a course (slides, past exams, exercise sets, notes). " +
    "Accent- and typo-tolerant; all words must match. Returns excerpts of about 300 characters with their source; " +
    "material marked as out of the syllabus (hors programme) comes after the course material. " +
    "Use it to ground an explanation in the student's own material or to find where a topic appears in past exams. Read-only and free.",
  kind: "read",
  input: z.object({
    course: courseArg,
    query: z.string().min(2).max(200).describe("Words to look for, e.g. \"valeurs propres\" or \"page table\"."),
    limit: z.number().int().min(1).max(30).optional().describe("Maximum excerpts returned (default 10)."),
  }),
  output,
  async run({ course, query, limit }, ctx) {
    return ctx.inCourse(course, async (c) => {
      const groups = await search(query, Math.max(limit ?? 10, 10));
      const flat = groups.flatMap((g) => g.hits.map((h) => ({ g, h })));
      const texts = await itemTexts(flat.map(({ h }) => Number(h.itemId)));
      const offProgram = await offProgramSources(flat.map(({ h }) => Number(h.sourceId)));
      const ranked = [...flat.filter(({ h }) => !offProgram.has(Number(h.sourceId))), ...flat.filter(({ h }) => offProgram.has(Number(h.sourceId)))];
      const hits = ranked.map(({ g, h }) => {
        const body = texts.get(Number(h.itemId));
        const engine = htmlToText(h.snippet);
        return {
          source_title: clip(h.sourceTitle, 200),
          source_type: offProgram.has(Number(h.sourceId)) ? `${g.label} (hors programme)` : g.label,
          title: h.title ? clip(h.title, 200) : null,
          // Fenêtre prise dans le texte de l'item ; le surlignage du moteur seulement si l'item n'a pas de texte.
          snippet: clip(body ? contextExcerpt(body, query) : engine, EXCERPT_CHARS + 40),
        };
      });
      return {
        course: courseRefOf(c),
        query,
        total: hits.length,
        hits: hits.slice(0, limit ?? 10),
        app_link: `${ctx.appOrigin}/recherche?course=${encodeURIComponent(c.id)}&q=${encodeURIComponent(query)}`,
      };
    });
  },
  summarize: (o) => o.total
    ? `${o.course.label} : ${o.total} passage(s) trouvé(s) pour « ${clip(o.query, 60)} ».`
    : `${o.course.label} : rien trouvé pour « ${clip(o.query, 60)} » dans les documents du cours.`,
});

/** Texte brut des items trouvés (le moteur ne rend qu'un surlignage de quelques mots). */
async function itemTexts(ids: number[]): Promise<Map<number, string>> {
  const unique = [...new Set(ids.filter((n) => Number.isFinite(n)))];
  if (!unique.length) return new Map();
  const rows = await q.all<{ id: number | string; text: string | null }>(
    `SELECT id, text FROM items WHERE id IN (${unique.map(() => "?").join(",")})`, ...unique,
  );
  return new Map(rows.filter((r) => r.text).map((r) => [Number(r.id), String(r.text)]));
}

/** Sources marquées hors programme par leur titre ou le début de leur premier item (une note). */
async function offProgramSources(ids: number[]): Promise<Set<number>> {
  const unique = [...new Set(ids.filter((n) => Number.isFinite(n)))];
  if (!unique.length) return new Set();
  const rows = await sourceHeads(unique);
  return new Set(rows.filter((r) => isOffProgram(r.title, r.head)).map((r) => r.id));
}
