import * as z from "zod/v4";
import { getUsageLimits } from "@/lib/billing/limits";
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
    "The file is only stored: call prepare_course once all materials are added. On a free account Cortex keeps only the text index of the material, " +
    "not the file (Premium keeps originals in the cloud): its indexing starts right away, at no cost.",
  kind: "write",
  // Ajout pur (jamais d'écrasement : « -2 », « -3 »…) ; lit une URL hors de Cortex.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  userSummary: "Ajoute un support à un cours (adresse web ou texte collé), gratuitement.",
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
      // Compte gratuit : l'original ne reste pas sur le serveur (lib/originals). Son texte est lu
      // tout de suite par une ingestion gratuite, sinon il partirait sans index.
      const local = saved.home === "local" ? await startFreeIngest(c.id) : null;
      const steps = saved.folder === "refs" ? await pastExamNextSteps(ctx.principal.userId) : "Add the other materials the same way, then call prepare_course to (re)build the course.";
      return {
        status: "added" as const,
        course: courseRefOf(c),
        source: { file: saved.name, folder: saved.folder, bytes: saved.bytes, content_type: saved.contentType },
        next_steps: local ? `${local} ${steps}` : steps,
      };
    });
  },
  summarize: (o) => `Support ajouté à ${o.course.label} : ${o.source.file} (${o.source.folder}, ${Math.max(1, Math.round(o.source.bytes / 1024))} Ko). ` +
    (o.source.folder === "refs"
      ? "Ajout gratuit : le format de cette annale sera relu par prepare_course, dont le coût est annoncé avant tout débit."
      : "Lance prepare_course une fois tous les supports ajoutés."),
});

/**
 * Une annale ne sert qu'une fois son format relu, par prepare_course : un job payant (crédits
 * et une génération du jour). L'ajout, lui, est gratuit ; le coût de la suite est dit ici,
 * avant que l'assistant ne le demande, puis devisé par prepare_course avant tout débit.
 */
async function pastExamNextSteps(userId: string): Promise<string> {
  // Même verdict que get_account_status et les devis : propriétaire et facturation coupée → 0 crédit ;
  // remaining null → aucune limite du jour ne la compte.
  const prepare = (await getUsageLimits(userId)).generations.prepare;
  const price = [
    prepare.costCredits > 0 ? `${prepare.costCredits} credit${prepare.costCredits === 1 ? "" : "s"}` : null,
    prepare.remaining !== null ? "one daily generation" : null,
  ].filter(Boolean).join(" and ");
  const cost = price
    ? `prepare_course reads its exam format: it costs ${price}, quoted before anything is charged.`
    : "prepare_course reads its exam format (nothing is charged or counted on this account).";
  return `Past exam stored for free. ${cost} Add the other materials first, then call prepare_course once.`;
}

/**
 * Compte gratuit : lance l'ingestion (gratuite) du support qui vient d'arriver ; une ingestion déjà
 * en cours le lira aussi (scripts/run-job relit les fichiers arrivés pendant). Rend la phrase dite
 * à l'assistant.
 */
async function startFreeIngest(courseId: string): Promise<string> {
  const note = "Free account: Cortex keeps only the text index of this material, not the file (Premium keeps originals in the cloud).";
  const { activeJob, createJobExclusive, startWorker } = await import("@/lib/jobs");
  const { transitHours } = await import("@/lib/originals/intake");
  if (await activeJob("ingest")) return `${note} It will be indexed by the ingestion already running.`;
  try {
    const { id } = await createJobExclusive("ingest");
    await startWorker(id, courseId);
    return `${note} Its indexing has started (free).`;
  } catch {
    return `${note} Indexing could not start now: call prepare_course within ${transitHours()} hours, or the material will have to be added again.`;
  }
}
