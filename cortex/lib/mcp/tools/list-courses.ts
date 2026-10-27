import * as z from "zod/v4";
import { ensureCoursesLoaded, listCoursesOf } from "@/lib/courses";
import { daysUntil } from "../content";
import { defineTool } from "../tool";

const output = z.object({
  courses: z.array(z.object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    university: z.string(),
    language: z.string(),
    exam_date: z.string().nullable(),
    days_until_exam: z.number().nullable(),
    app_link: z.string(),
  })),
});

export default defineTool({
  name: "list_courses",
  title: "List my courses",
  description:
    "List the courses in the signed-in student's Cortex account (code, name, exam date, days left). " +
    "Call this first when the student mentions a course you cannot match, or before any other tool when the account may have several courses. " +
    "Read-only and free.",
  kind: "read",
  input: z.object({}),
  output,
  async run(_args, ctx) {
    await ensureCoursesLoaded();
    const courses = listCoursesOf(ctx.principal.userId).map((c) => ({
      id: c.id,
      code: c.examCode || c.short,
      name: c.name,
      university: c.university,
      language: c.language,
      exam_date: c.examDate ?? null,
      days_until_exam: daysUntil(c.examDate),
      app_link: `${ctx.appOrigin}/?course=${encodeURIComponent(c.id)}`,
    }));
    return { courses };
  },
  summarize: (o) => o.courses.length
    ? `${o.courses.length} cours : ${o.courses.map((c) => (c.code && c.code !== c.name ? `${c.code} (${c.name})` : c.name)).join(", ")}.`
    : "Aucun cours sur ce compte.",
});
