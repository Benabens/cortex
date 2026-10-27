import * as z from "zod/v4";
import { SOURCE_CATEGORIES, SourceError, addTextSource, addUrlSource } from "@/lib/course-source";
import { courseArg, courseRef, courseRefOf } from "../schemas";
import { ToolError, codeForStatus, defineTool } from "../tool";

const output = z.object({
  status: z.enum(["added"]),
  course: courseRef,
  source: z.object({
    file: z.string().describe("File name stored in the course."),
    folder: z.string().describe("Where it was filed: refs (past exams), lectures, series (exercises), notes, exam-samples (official sample questions), exam-info (exam instructions), sites, images or misc."),
    bytes: z.number(),
    content_type: z.string(),
  }),
  next_steps: z.string(),
});

export default defineTool({
  name: "add_course_source",
  title: "Add a course material",
  description:
    "Add one material to a course (free; counts toward the account's storage quota), either from a public https URL (PDF, web page or plain text, 30 MB max; redirects are not followed, " +
    "pass the final URL) or from pasted text. category tells Cortex what it is: past_exam (an exam from a previous year, used to learn the exam format), " +
    "lecture, exercises, notes, sample_questions (official example questions published by the teacher: their style is imitated when there are no past exams) " +
    "or exam_info (exam instructions: syllabus or course page describing the exam, e.g. \"MCQ, 45 min\"); when omitted it is guessed from the file name. " +
    "The file is only stored: call prepare_course once all materials are added.",
  kind: "write",
  openWorld: true,
  input: z.object({
    course: courseArg,
    url: z.string().url().max(2000).optional().describe("Public https URL of a PDF, web page or text file. Give either url or text."),
    text: z.string().min(1).max(200_000).optional().describe("Pasted text (stored as Markdown). Give either url or text."),
    title: z.string().min(1).max(120).optional().describe("Name for the stored file, e.g. \"Final 2024\" (default: from the URL)."),
    category: z.enum(SOURCE_CATEGORIES).optional().describe("past_exam, lecture, exercises, notes, sample_questions or exam_info."),
  }),
  output,
  async run(args, ctx) {
    const given = [args.url, args.text].filter((v) => v !== undefined).length;
    if (given !== 1) throw new ToolError("invalid_input", "Donne soit « url », soit « text » (exactement l'un des deux).");
    return ctx.inCourse(args.course, async (c) => {
      let saved;
      try {
        saved = args.url
          ? await addUrlSource(c.id, { url: args.url, title: args.title, category: args.category })
          : await addTextSource(c.id, { text: args.text!, title: args.title, category: args.category });
      } catch (e) {
        if (e instanceof SourceError) throw new ToolError(codeForStatus(e.status), e.message);
        throw e;
      }
      return {
        status: "added" as const,
        course: courseRefOf(c),
        source: { file: saved.name, folder: saved.folder, bytes: saved.bytes, content_type: saved.contentType },
        next_steps: "Add the other materials the same way, then call prepare_course to (re)build the course.",
      };
    });
  },
  summarize: (o) => `Support ajouté à ${o.course.label} : ${o.source.file} (${o.source.folder}, ${Math.max(1, Math.round(o.source.bytes / 1024))} Ko). Lance prepare_course une fois tous les supports ajoutés.`,
});
