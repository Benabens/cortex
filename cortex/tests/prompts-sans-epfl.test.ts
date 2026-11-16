/**
 * PROMPTS SANS EPFL (audit du 16/11/2026, défauts 3, 4, 18 et 24).
 *
 * Avant : tout cours sans profil curaté recevait « indiscernable d'un vrai final EPFL »,
 * « niveau d'un vrai final EPFL », « ~180 points au total, 3 h » et le guide de style d'une
 * enseignante de CS-202, quel que soit son établissement ou sa durée. Verrouillé ici : la cible
 * est l'examen réel du cours (ses annales), le barème et la durée viennent de son format, et
 * aucun style d'enseignant ne s'applique sans profil qui le déclare. Cours fictifs uniquement.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-prompts-sans-epfl-"));
process.env.CORTEX_DATA_DIR = tmp;
// Faux fournisseur local (aucun appel payant) : il enregistre les prompts et rend des réponses fixes.
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";
process.env.MAX_COURSES_PER_USER = "unlimited";

const DRILL = { concept: "Arbres", statement_html: "<p>Insérez 7, 3, 9.</p>", hints: ["a", "b", "c", "d", "e"], solution_html: "<p>Racine 7.</p>", course_terms: [] };
const DESIGN = { misconception: "m", edge_case: "e", reasoning_chain: ["a"], bookkeeping: "b", discriminator: "d", awkward_numbers: "37", subquestion_plan: ["a"] };
const WRITTEN = { category: "General", concept: "Arbres", statement_tex: "Énoncé.", solution_tex: "Corrigé.", points: 20 };
const AUDIT = { pattern_matcher_answer: "x", pattern_matcher_correct: false, strong_student_answer: "y", strong_student_stuck: false, rubric_misses: [], trap_present: true, hardening: "", verdict: "good" };
let prompts: string[] = [];
let llm: http.Server;

before(async () => {
  delete process.env.CORTEX_USER;
  llm = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { messages: { content: unknown }[] };
      const content = parsed.messages.map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
      prompts.push(content);
      const reply = /"hints"/.test(content) ? DRILL : /"edge_case"/.test(content) ? DESIGN : /"pattern_matcher_answer"/.test(content) ? AUDIT : /"statement_tex"/.test(content) ? WRITTEN : {};
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

beforeEach(() => { prompts = []; });

after(() => {
  llm.close();
  delete process.env.CORTEX_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Prompt de drill puis prompt de conception de l'architecte (première passe), pour un cours. */
async function drillAndDesignPrompts(course: string): Promise<{ drill: string; design: string }> {
  const { runWithCourse } = await import("../db/client");
  const { generateDrill } = await import("../lib/drill");
  const { architectQuestion } = await import("../lib/architect");
  const { getProfile } = await import("../lib/course-profile");
  return runWithCourse(course, async () => {
    await generateDrill("arbres binaires de recherche");
    const drill = prompts.find((p) => /"hints"/.test(p))!;
    const a = getProfile(course).archetypes[0];
    await architectQuestion(a, "arbres binaires de recherche", 20, { maxRounds: 1 });
    const design = prompts.find((p) => /"edge_case"/.test(p))!;
    return { drill, design };
  });
}

let seq = 0;
async function newCourse(over: Record<string, unknown> = {}): Promise<string> {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const row = buildCourseRow({ name: `Structures fictives ${++seq}`, code: "DS 201", university: "Northbridge University", language: "en", ...over }, "owner");
  await insertCourse(row);
  await reloadCourses();
  return row.id;
}

/** Résout le format (comme le worker avant de générer), puis rend le profil du cours. */
async function profileOf(course: string) {
  const { runWithCourse } = await import("../db/client");
  const { resolveExamFormat } = await import("../lib/exam-format");
  const { getProfile } = await import("../lib/course-profile");
  return runWithCourse(course, async () => {
    await resolveExamFormat();
    const p = getProfile(course);
    return { p, slots: await p.buildBlueprint(), directives: p.directivesBlock(), intro: p.promptIntroFull().join("\n") };
  });
}

test("hors EPFL : aucune consigne ne prend un final EPFL pour cible, l'examen réel du cours la remplace", async () => {
  const id = await newCourse();
  const { directives, intro } = await profileOf(id);
  assert.doesNotMatch(intro, /EPFL/, intro);
  assert.doesNotMatch(directives, /EPFL/, directives);
  assert.match(intro, /annales/, "la cible est l'examen réel du cours, ses annales");
  assert.match(directives, /annales/, "le niveau est celui des annales du cours");
});

test("hors EPFL : ni le drill ni l'architecte ne visent un final EPFL ni le style d'une enseignante", async () => {
  const id = await newCourse();
  const { drill, design } = await drillAndDesignPrompts(id);
  assert.doesNotMatch(drill, /EPFL/, drill);
  assert.match(drill, /annales/, "le drill vise le niveau des annales du cours");
  assert.doesNotMatch(design, /STYLE DE [A-Z]|IMITE-LE|Katerina|execvp|store-and-forward/, design);
});

/**
 * Empreintes relevées sur main (48274e9), avant ce correctif : les morceaux de prompt de cs-202 qui
 * ne dépendent pas du corpus (intro, lots, contraintes, style, difficulté), et les prompts complets du
 * drill et de la conception de l'architecte sur un corpus vide. Toute dérive doit être voulue.
 */
const CS202_PROMPTS = {
  intro: "37fb3a7a6e2ddc70", batch: "ac53fea0f4d5fa62", directives: "c3fa97a32f85bba3", qa: "8de728d4852bf582",
  exam: "e95a9f80adb7a779", style: "83f76ef5fc705507", drill: "f1ef72a37fe700b9", design: "8bde0427880a5b3f",
};

test("cs-202 : ses prompts restent identiques (style de l'enseignante et cible « final EPFL » compris)", async () => {
  const { DEFAULT_COURSE } = await import("../lib/courses");
  const { runWithCourse } = await import("../db/client");
  const { getProfile } = await import("../lib/course-profile");
  const { difficultyBlockForExam, styleFor } = await import("../lib/difficulty");
  const { drill, design } = await drillAndDesignPrompts(DEFAULT_COURSE);
  assert.match(drill, /vrai final EPFL/);
  assert.match(design, /STYLE DE KATERINA/);
  const p = getProfile(DEFAULT_COURSE);
  const got = await runWithCourse(DEFAULT_COURSE, async () => ({
    intro: sha(p.promptIntroFull().join("\n")), batch: sha(p.promptIntroBatch(3).join("\n")), directives: sha(p.directivesBlock()), qa: sha(p.qaIntro()),
    exam: sha(difficultyBlockForExam()), style: sha(["Networking", "OS", "C", "Labs"].map((c) => styleFor(c).join("\n")).join("\n")),
    drill: sha(drill), design: sha(design),
  }));
  assert.deepEqual(got, CS202_PROMPTS);
});
