import * as z from "zod/v4";
import { insertCourse } from "@/db/courses-store";
import { InvalidCourseError, buildCourseRow } from "@/lib/course-create";
import { ensureCoursesLoaded, listCoursesOf, reloadCourses } from "@/lib/courses";
import { courseLabel } from "../courses";
import { courseRef, courseRefOf } from "../schemas";
import { ToolError, defineTool } from "../tool";

const LANGUAGES = ["fr", "en", "de", "it", "es", "pt", "nl"] as const;

const output = z.object({
  status: z.enum(["created"]),
  course: courseRef,
  next_steps: z.string(),
});

export default defineTool({
  name: "create_course",
  title: "Create a course",
  description:
    "Owner only. Create a new course in the owner's Cortex account (the same as \"New course\" in the app): name, optional exam code (e.g. \"MATH-111\"), " +
    "university, language of the course and exam date. Refuses a second course with the same exam code. " +
    "Then add its materials with add_course_source and build it with prepare_course.",
  kind: "admin",
  input: z.object({
    name: z.string().min(2).max(80).describe("Course name, e.g. \"Linear algebra\"."),
    code: z.string().min(1).max(24).optional().describe("Exam / course code, e.g. \"MATH-111\"."),
    university: z.string().min(1).max(80).optional().describe("University or school, e.g. \"EPFL\"."),
    language: z.enum(LANGUAGES).optional().describe("Language of the course materials and exams (default fr)."),
    exam_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Exam date, YYYY-MM-DD."),
  }),
  output,
  async run(args, ctx) {
    const userId = ctx.principal.userId;
    await ensureCoursesLoaded();
    const code = args.code?.trim();
    const twin = code ? listCoursesOf(userId).find((c) => c.examCode?.toLowerCase() === code.toLowerCase()) : undefined;
    if (twin) throw new ToolError("conflict", `Un cours porte déjà le code ${code} : ${courseLabel(twin)} (id ${twin.id}).`);
    let row;
    try {
      row = buildCourseRow({ name: args.name, code, university: args.university, language: args.language, examDate: args.exam_date }, userId);
    } catch (e) {
      if (e instanceof InvalidCourseError) throw new ToolError("invalid_input", e.message);
      throw e;
    }
    await insertCourse(row);
    // Le cache est la source de lecture du moteur et de list_courses : il doit voir le cours neuf.
    await reloadCourses();
    const created = listCoursesOf(userId).find((c) => c.id === row.id);
    if (!created) throw new ToolError("internal", "Le cours a été enregistré mais n'est pas encore visible : réessaie list_courses dans un instant.");
    return {
      status: "created" as const,
      course: courseRefOf(created),
      next_steps: `Add materials with add_course_source (course="${created.id}"), then call prepare_course.`,
    };
  },
  summarize: (o) => `Cours créé : ${o.course.label} (id ${o.course.id}). Ajoute ses supports avec add_course_source, puis lance prepare_course.`,
});
