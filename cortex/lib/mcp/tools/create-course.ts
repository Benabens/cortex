import * as z from "zod/v4";
import { CourseCreationLimitError, insertCourse } from "@/db/courses-store";
import { InvalidCourseError, buildCourseRow } from "@/lib/course-create";
import { ensureCoursesLoaded, listCoursesOf, reloadCourses } from "@/lib/courses";
import { courseLabel } from "../courses";
import { LANGUAGES } from "@/lib/exam-format";
import { courseRef, courseRefOf, examFormatInput } from "../schemas";
import { ToolError, defineTool } from "../tool";
import { errorText } from "@/lib/i18n/user-error";


const output = z.object({
  status: z.enum(["created"]),
  course: courseRef,
  next_steps: z.string(),
});

export default defineTool({
  name: "create_course",
  title: "Create a course",
  description:
    "Creates a new course in the student's Cortex account, like \"New course\" in the app. Free. Fields: name, optional exam code (e.g. \"COMP 201\"), " +
    "university, course language, exam date and, optionally, exam_format (type, number of questions, duration), used when the course has no past exams: " +
    "Cortex never invents a format. A second course with the same exam code is refused. " +
    "The course starts empty: materials are added with add_course_source and the course is built by prepare_course.",
  kind: "write",
  // Ajout pur : un code déjà pris est refusé, rien n'est remplacé.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  userSummary: "createCourse",
  input: z.object({
    name: z.string().min(2).max(80).describe("Course name, e.g. \"Linear algebra\"."),
    code: z.string().min(1).max(24).optional().describe("Exam / course code, e.g. \"COMP 201\"."),
    university: z.string().min(1).max(80).optional().describe("University or school, as the student names it (never assume one)."),
    language: z.enum(LANGUAGES).optional().describe("Language of the course materials and exams. Omit it to detect it from the past exams, then the materials (English until materials are added)."),
    exam_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Exam date, YYYY-MM-DD."),
    exam_format: z.object(examFormatInput).optional().describe("Real format of the exam, if known (can be changed later with set_exam_format)."),
  }),
  output,
  async run(args, ctx) {
    const userId = ctx.principal.userId;
    await ensureCoursesLoaded();
    const code = args.code?.trim();
    const twin = code ? listCoursesOf(userId).find((c) => c.examCode?.toLowerCase() === code.toLowerCase()) : undefined;
    if (twin) throw new ToolError("conflict", `A course already uses code ${code}: ${courseLabel(twin)} (id ${twin.id}).`);
    let row;
    try {
      row = buildCourseRow({ name: args.name, code, university: args.university, language: args.language, examDate: args.exam_date, examFormat: args.exam_format }, userId);
    } catch (e) {
      if (e instanceof InvalidCourseError) throw new ToolError("invalid_input", errorText("en", e), undefined, e.code);
      throw e;
    }
    try {
      await insertCourse(row);
    } catch (e) {
      if (e instanceof CourseCreationLimitError) throw new ToolError("conflict", errorText("en", e), undefined, e.code);
      throw e;
    }
    // Le cache est la source de lecture du moteur et de list_courses : il doit voir le cours neuf.
    await reloadCourses();
    const created = listCoursesOf(userId).find((c) => c.id === row.id);
    if (!created) throw new ToolError("internal", "The course was saved but is not visible yet. Try list_courses again in a moment.");
    return {
      status: "created" as const,
      course: courseRefOf(created),
      next_steps: `Add materials with add_course_source (course="${created.id}"), then call prepare_course.`,
    };
  },
  summarize: (o) => `Course created: ${o.course.label} (id ${o.course.id}). Add its materials with add_course_source, then call prepare_course.`,
});
