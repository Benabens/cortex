import * as z from "zod/v4";
import { dueConcepts } from "@/lib/schedule";
import { listWeaknesses, weaknessesByTheme } from "@/lib/weaknesses";
import { clip } from "../content";
import { courseArg, courseRef, courseRefOf } from "../schemas";
import { defineTool, READ_ONLY_HINTS } from "../tool";

const output = z.object({
  course: courseRef,
  total: z.number(),
  weak_points: z.array(z.object({
    id: z.number(),
    topic: z.string(),
    theme: z.string().nullable(),
    severity: z.number().describe("1 (minor) to 3 (serious)."),
    times_seen: z.number(),
    description: z.string(),
    source: z.string(),
    logged_at: z.string().nullable(),
  })),
  by_theme: z.array(z.object({ theme: z.string(), count: z.number(), avg_severity: z.number() })),
  due_for_review: z.array(z.string()).describe("Concepts due now in spaced repetition (never tested or overdue)."),
  app_link: z.string(),
});

export default defineTool({
  name: "get_weak_points",
  title: "Get my weak points",
  description:
    "Returns the student's tracked weak points for a course, most serious first (topic, theme, severity, the note explaining the gap), " +
    "grouped by theme, plus the concepts due for spaced-repetition review. Read-only and free.",
  kind: "read",
  annotations: READ_ONLY_HINTS,
  userSummary: "Lit tes points faibles, du plus grave au moins grave.",
  input: z.object({
    course: courseArg,
    limit: z.number().int().min(1).max(50).optional().describe("Maximum weak points returned (default 20)."),
  }),
  output,
  async run({ course, limit }, ctx) {
    return ctx.inCourse(course, async (c) => {
      const all = (await listWeaknesses()).filter((w) => w.topic && w.topic !== "(à analyser)");
      const sorted = [...all].sort((a, b) => b.severity - a.severity || (b.timesSeen ?? 0) - (a.timesSeen ?? 0) || String(b.loggedAt ?? "").localeCompare(String(a.loggedAt ?? "")));
      return {
        course: courseRefOf(c),
        total: all.length,
        weak_points: sorted.slice(0, limit ?? 20).map((w) => ({
          id: w.id,
          topic: clip(w.topic, 200),
          theme: w.theme,
          severity: w.severity,
          times_seen: w.timesSeen ?? 1,
          description: clip(w.description, 600),
          source: w.source,
          logged_at: w.loggedAt,
        })),
        by_theme: (await weaknessesByTheme()).slice(0, 15).map((t) => ({ theme: clip(t.theme, 120), count: t.count, avg_severity: t.avgSeverity })),
        due_for_review: (await dueConcepts(10)).map((s) => clip(s, 160)),
        app_link: `${ctx.appOrigin}/faiblesses?course=${encodeURIComponent(c.id)}`,
      };
    });
  },
  summarize: (o) => o.total
    ? `${o.course.label} : ${o.total} point(s) faible(s) suivi(s), dont ${o.weak_points.filter((w) => w.severity >= 3).length} grave(s).`
    : `${o.course.label} : aucun point faible enregistré pour l'instant.`,
});
