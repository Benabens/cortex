import * as z from "zod/v4";
import { updateCourseRow } from "@/db/courses-store";
import { InvalidCourseError, declaredFormatColumn } from "@/lib/course-create";
import { reloadCourses } from "@/lib/courses";
import { resolveExamFormat } from "@/lib/exam-format";
import { courseArg, courseRef, courseRefOf, examFormatInput, examFormatOf, examFormatSchema } from "../schemas";
import { ToolError, defineTool } from "../tool";
import { errorText } from "@/lib/i18n/user-error";

const output = z.object({
  status: z.enum(["updated"]),
  course: courseRef,
  exam_format: examFormatSchema.describe("The format the generator will now follow (past exams still take precedence when the course has some)."),
});

export default defineTool({
  name: "set_exam_format",
  title: "Declare the exam format of a course",
  description:
    "Declares (or clears) the real exam format of a course: type (qcm, exercises, mixed, composite, essay, oral), number of questions, duration, language, documents allowed, " +
    "and for multiple-choice exams whether each question has a single correct answer or several (answer_mode). " +
    "Free. Past exams of the course, when present and analysed, still take precedence; otherwise mock exams follow this format (e.g. \"a 20-question MCQ midterm, 45 min\"). " +
    "clear=true removes the declaration.",
  kind: "write",
  // Remplace (ou efface, clear) le format déclaré : destructif ; même appel, même état : idempotent.
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  userSummary: "setExamFormat",
  input: z.object({
    course: courseArg,
    kind: examFormatInput.kind.optional(),
    question_count: examFormatInput.question_count,
    duration_min: examFormatInput.duration_min,
    language: examFormatInput.language,
    answer_mode: examFormatInput.answer_mode,
    documents: examFormatInput.documents,
    clear: z.boolean().optional().describe("true = remove the declared format."),
  }),
  output,
  async run(args, ctx) {
    if (!args.clear && !args.kind) throw new ToolError("invalid_input", "Provide “kind” (qcm, exercises, mixed, composite, essay, or oral), or use clear=true to remove the declared format.");
    return ctx.inCourse(args.course, async (c) => {
      let column: string | null = null;
      if (!args.clear) {
        try {
          column = declaredFormatColumn({ kind: args.kind, questionCount: args.question_count, durationMin: args.duration_min, language: args.language, answerMode: args.answer_mode, documents: args.documents });
        } catch (e) {
          if (e instanceof InvalidCourseError) throw new ToolError("invalid_input", errorText("en", e), undefined, e.code);
          throw e;
        }
      }
      if (!(await updateCourseRow(c.id, ctx.principal.userId, { exam_format: column }))) throw new ToolError("not_found", "Course not found.");
      await reloadCourses();
      return { status: "updated" as const, course: courseRefOf(c), exam_format: examFormatOf(await resolveExamFormat()) };
    });
  },
  summarize: (o) => `${o.course.label} exam format: ${o.exam_format.kind ? o.exam_format.summary : "unknown (nothing declared)"}.`,
});
