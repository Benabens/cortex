import * as z from "zod/v4";
import { updateCourseRow } from "@/db/courses-store";
import { InvalidCourseError, declaredFormatColumn } from "@/lib/course-create";
import { reloadCourses } from "@/lib/courses";
import { resolveExamFormat } from "@/lib/exam-format";
import { courseArg, courseRef, courseRefOf, examFormatInput, examFormatOf, examFormatSchema } from "../schemas";
import { ToolError, defineTool } from "../tool";

const output = z.object({
  status: z.enum(["updated"]),
  course: courseRef,
  exam_format: examFormatSchema.describe("The format the generator will now follow (past exams still take precedence when the course has some)."),
});

export default defineTool({
  name: "set_exam_format",
  title: "Declare the exam format of a course",
  description:
    "Declare (or clear) the real exam format of a course: type (qcm, exercises, mixed, essay, oral), number of questions, duration and language. " +
    "Use it when generate_mock_exam answers format_required, or when the student tells you how the exam looks (e.g. \"a 20-question MCQ midterm, 45 min\"). " +
    "Free. Past exams of the course, when present and analysed, still take precedence; otherwise mock exams follow this format. clear=true removes the declaration.",
  kind: "write",
  input: z.object({
    course: courseArg,
    kind: examFormatInput.kind.optional(),
    question_count: examFormatInput.question_count,
    duration_min: examFormatInput.duration_min,
    language: examFormatInput.language,
    clear: z.boolean().optional().describe("true = remove the declared format."),
  }),
  output,
  async run(args, ctx) {
    if (!args.clear && !args.kind) throw new ToolError("invalid_input", "Donne « kind » (qcm, exercises, mixed, essay ou oral), ou clear=true pour effacer le format déclaré.");
    return ctx.inCourse(args.course, async (c) => {
      let column: string | null = null;
      if (!args.clear) {
        try {
          column = declaredFormatColumn({ kind: args.kind, questionCount: args.question_count, durationMin: args.duration_min, language: args.language });
        } catch (e) {
          if (e instanceof InvalidCourseError) throw new ToolError("invalid_input", e.message);
          throw e;
        }
      }
      if (!(await updateCourseRow(c.id, ctx.principal.userId, { exam_format: column }))) throw new ToolError("not_found", "Cours introuvable.");
      await reloadCourses();
      return { status: "updated" as const, course: courseRefOf(c), exam_format: examFormatOf(await resolveExamFormat()) };
    });
  },
  summarize: (o) => `Format d'examen de ${o.course.label} : ${o.exam_format.kind ? o.exam_format.summary : "inconnu (rien de déclaré)"}.`,
});
