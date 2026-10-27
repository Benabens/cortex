import * as z from "zod/v4";
import { search } from "@/lib/search";
import { clip, htmlToText } from "../content";
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
    snippet: z.string(),
  })),
  app_link: z.string(),
});

export default defineTool({
  name: "search_course_materials",
  title: "Search my course materials",
  description:
    "Full-text search in the documents the student uploaded for a course (slides, past exams, exercise sets, notes). " +
    "Accent- and typo-tolerant; all words must match. Returns short excerpts with their source. " +
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
      const hits = groups.flatMap((g) => g.hits.map((h) => ({
        source_title: clip(h.sourceTitle, 200),
        source_type: g.label,
        title: h.title ? clip(h.title, 200) : null,
        snippet: clip(htmlToText(h.snippet), 400),
      })));
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
