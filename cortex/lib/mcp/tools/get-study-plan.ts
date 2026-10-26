import * as z from "zod/v4";
import { rankTopics, toNextUp, upNext } from "@/lib/next-up";
import { programOverview, type ProgramOverview } from "@/lib/program";
import { scheduleStats } from "@/lib/schedule";
import { clip, daysUntil } from "../content";
import { courseArg, courseRef, courseRefOf } from "../schemas";
import { defineTool } from "../tool";

const topicOut = z.object({
  id: z.number(),
  label: z.string(),
  chapter: z.string().nullable(),
  exam_weight_pct: z.number().describe("Share of past-exam questions on this topic, in %."),
  times_in_exams: z.number(),
  status: z.enum(["never", "due", "ok"]).describe("never = not practised yet; due = review due now; ok = up to date."),
  mastery: z.number().nullable().describe("Smoothed mastery score 0-10 (null = never practised)."),
});

const output = z.object({
  course: courseRef,
  analyzed: z.boolean().describe("false = the course material has not been analysed yet (no programme)."),
  exam: z.object({ date: z.string().nullable(), days_left: z.number().nullable() }),
  stats: z.object({
    topics: z.number(), practised: z.number(), mastered: z.number(), due_now: z.number(),
    coverage_pct: z.number().describe("% of exam weight practised at least once."),
    mastery_pct: z.number().describe("% of exam weight mastered (weighted by score)."),
  }),
  spaced_repetition: z.object({ concepts: z.number(), due: z.number() }),
  next_topic: topicOut.nullable().describe("The single highest-priority topic to work on now."),
  then: z.array(topicOut).describe("The next topics by priority."),
  chapters: z.array(z.object({ seq: z.number(), lecture: z.number().nullable(), title: z.string(), topics: z.number(), topics_seen_in_exams: z.number() })),
  topics: z.array(topicOut).describe("Topics ranked by priority (exam weight × gap × review due)."),
  truncated: z.boolean(),
  app_link: z.string(),
});

type TopicOut = z.infer<typeof topicOut>;

function topicOf(t: ProgramOverview["topics"][number], chapters: ProgramOverview["chapters"]): TopicOut {
  const ch = t.chapterId == null ? undefined : chapters.find((c) => c.id === t.chapterId);
  return {
    id: t.id,
    label: clip(t.label, 200),
    chapter: ch ? clip(ch.title, 160) : null,
    exam_weight_pct: t.examWeight,
    times_in_exams: (t.occurrences ?? 0) > 0 ? t.occurrences! : t.examCount,
    status: t.status,
    mastery: t.mastery,
  };
}

const MAX_TOPICS = 40;

export default defineTool({
  name: "get_study_plan",
  title: "Get my study plan",
  description:
    "Get where the student stands in a course's programme: exam countdown, coverage and mastery weighted by how often each topic appears in past exams, " +
    "topics due for review, the course chapters, and the prioritised list of what to work on next. " +
    "Use it for \"where am I in my programme?\", \"what should I revise next?\" or before choosing a chapter for a mock exam. Read-only and free.",
  kind: "read",
  input: z.object({ course: courseArg }),
  output,
  async run({ course }, ctx) {
    return ctx.inCourse(course, async (c) => {
      let ov: ProgramOverview = { topics: [], chapters: [], planOk: false, stats: { total: 0, covered: 0, mastered: 0, due: 0, coveragePct: 0, masteryPct: 0 } };
      try { ov = await programOverview(); } catch { /* cours pas encore analysé : programme vide */ }
      let sched = { total: 0, due: 0 };
      try { sched = await scheduleStats(); } catch { /* pas de planning */ }
      // rankTopics applique la règle de nextTopic() (lib/next-up) sans recalculer tout le programme.
      const ranked = rankTopics(ov.topics);
      const next = ranked[0] ?? null;
      const nu = next ? toNextUp(next, ov.chapters) : null;
      const byId = new Map(ov.topics.map((t) => [t.id, t]));
      return {
        course: courseRefOf(c),
        analyzed: ov.stats.total > 0,
        exam: { date: c.examDate ?? null, days_left: daysUntil(c.examDate) },
        stats: {
          topics: ov.stats.total, practised: ov.stats.covered, mastered: ov.stats.mastered, due_now: ov.stats.due,
          coverage_pct: ov.stats.coveragePct, mastery_pct: ov.stats.masteryPct,
        },
        spaced_repetition: { concepts: sched.total, due: sched.due },
        next_topic: nu && byId.get(nu.id) ? topicOf(byId.get(nu.id)!, ov.chapters) : null,
        then: upNext(ov, next?.id ?? null).map((u) => byId.get(u.id)).filter((t): t is NonNullable<typeof t> => !!t).map((t) => topicOf(t, ov.chapters)),
        chapters: ov.chapters.slice(0, 40).map((ch) => ({
          seq: ch.seq, lecture: ch.lectureNo, title: clip(ch.title, 160), topics: ch.notionCount, topics_seen_in_exams: ch.fallenCount,
        })),
        topics: ranked.slice(0, MAX_TOPICS).map((t) => topicOf(t, ov.chapters)),
        truncated: ranked.length > MAX_TOPICS,
        app_link: `${ctx.appOrigin}/programme?course=${encodeURIComponent(c.id)}`,
      };
    });
  },
  summarize: (o) => {
    if (!o.analyzed) return `${o.course.label} : le programme n'a pas encore été analysé (importe les annales dans Cortex et lance l'analyse).`;
    const countdown = o.exam.days_left !== null ? ` Examen dans ${o.exam.days_left} jour(s).` : "";
    // Aucun libellé de notion ici : ils viennent des documents du cours et restent dans le bloc de données.
    return `${o.course.label} : couverture ${o.stats.coverage_pct} %, maîtrise ${o.stats.mastery_pct} %, ${o.stats.due_now} notion(s) à revoir sur ${o.stats.topics}.${countdown}`;
  },
});
