/**
 * FORMULES À LA SOURCE (22/11/2026) : le modèle écrivait « x_{t+1} = 2x_t » en texte nu, que le PDF
 * ne peut composer que si c'est sûr (lib/tex-rich). Chaque prompt qui écrit un énoncé, une option,
 * un corrigé ou une sous-question demande donc ses formules entre $…$ (ou \[…\] détachées). Lus sur
 * les prompts eux-mêmes : un faux fournisseur local les enregistre, aucun appel au modèle. Cours fictif.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-prompts-formules-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";

let prompts: string[] = [];
let llm: http.Server;
let course = "";

before(async () => {
  delete process.env.CORTEX_USER;
  // réponse vide : chaque appel échoue après avoir envoyé son prompt, seul le prompt compte ici
  llm = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { messages: { content: unknown }[] };
      prompts.push(parsed.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n"));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  const { ensureCoursesLoaded, reloadCourses } = await import("../lib/courses");
  await ensureCoursesLoaded();
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const row = buildCourseRow({ name: "Optimisation fictive", code: "FIC-412", university: "Université fictive", language: "fr" }, "owner");
  await insertCourse(row);
  course = row.id;
  await reloadCourses();
});

beforeEach(() => { prompts = []; });

after(() => {
  llm.close();
  delete process.env.CORTEX_DATA_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Texte simple (QCM, composées, correction) : formules entre $…$ ou \[…\], jamais en texte nu. */
const PLAIN = /FORMULES : chaque formule[^\n]*entre \$…\$[^\n]*entre \\\[…\\\][^\n]*jamais en texte nu/;
/** LaTeX libre (ouvertes, corrigés d'examen écrit) : même consigne, la compilation en dépend. */
const LATEX = /Toute formule[^\n]*est entre \$\.\.\.\$ ou \\\[ \.\.\. \\\][^\n]*hors des maths/;

async function sent(run: () => Promise<unknown>): Promise<string[]> {
  const { runWithCourse } = await import("../db/client");
  await runWithCourse(course, () => run().catch(() => null));
  assert.ok(prompts.length, "aucun prompt envoyé");
  return prompts;
}

const ITEM = { topic: "Gradient", type: "scq" as const, stem: "Quel pas ?", options: ["petit", "grand", "nul"], correct: [0], misconceptions: ["", "a", "b"], explanation: "Le petit.", verified: 1 as const };

test("QCM : la conception, le remplacement des distracteurs, la revue finale et les réécritures d'explication demandent les formules entre $…$", async () => {
  const qcm = await import("../lib/qcm");
  const ev = await import("../lib/qcm-evidence");
  const step = () => {};
  const runs: [string, () => Promise<unknown>][] = [
    ["conception", () => qcm.generateQcmBatch([{ label: "Descente de gradient", method: null }], 1, step)],
    ["distracteurs", () => qcm.replaceTrivialDistractorsBatch([{ ...ITEM, trivialDistractors: [2] } as never], step, "fr")],
    ["revue finale", () => qcm.finalReview([{ ...ITEM, rationale: { key: "", wrong: ["", "", ""] } } as never], { strict: false, step })],
    ["explications", () => ev.rewriteExplanations([{ ...ITEM, reason: "hors cours", passages: [{ src: "c", text: "Le pas est petit." }] }], "fr")],
    ["explications sur les options", () => ev.rewriteExplanationsOnOptions([{ ...ITEM, issue: "option nommée" }], "fr")],
    ["justifications", () => ev.writeJustifications([{ ...ITEM, key: "", wrong: ["", "", ""], want: { key: true, options: [1] } }], "fr")],
  ];
  for (const [name, run] of runs) {
    prompts = [];
    const p = await sent(run).catch((e) => { throw new Error(`${name} : ${(e as Error).message}`); });
    assert.ok(p.some((x) => PLAIN.test(x)), `${name} : consigne des formules absente`);
  }
});

test("question composée : le prompt système demande les formules entre $…$", async () => {
  const { runWithCourse } = await import("../db/client");
  const { blockSystemPrompt } = await import("../lib/blocks");
  const plan = { blockCount: 1, partsMin: 2, partsMax: 3, kinds: null, points: null, totalPoints: 20, sections: [], codeLanguage: null };
  const sys = await runWithCourse(course, async () => blockSystemPrompt(plan as never, 1, ""));
  assert.match(sys, PLAIN);
});

test("correction d'une réponse : feedback et corrigé avec les formules entre $…$", async () => {
  const { checkSolution } = await import("../lib/check-solution");
  const p = await sent(() => checkSolution({ statement: "Calculez x_{t+1}.", answer: "x_{t+1} = 2x_t" }));
  assert.ok(p.some((x) => PLAIN.test(x)), p[0].slice(0, 300));
});

test("question ouverte et corrigé réécrit (LaTeX libre) : formules entre $…$ ou \\[…\\], jamais hors des maths", async () => {
  const { runWithCourse } = await import("../db/client");
  const { profile } = await import("../lib/course-profile");
  assert.match(await runWithCourse(course, async () => profile().latexContract()), LATEX);
  const { verifyAndHarden } = await import("../lib/verify");
  const spec = { questions: [{ concept: "Pas", statement_tex: "Calculez $x_1$.", solution_tex: "$x_1 = 0$.", points: 10 }] };
  const p = await sent(() => verifyAndHarden(spec as never, async (q) => q, 1));
  assert.ok(p.some((x) => LATEX.test(x)), "vérification : consigne absente du corrigé réécrit");
});

test("drill : son HTML s'affiche sans rendu des maths, indices et exposants en <sub>/<sup>, jamais dans ses indices en texte brut", async () => {
  const { generateDrill } = await import("../lib/drill");
  const p = await sent(() => generateDrill("descente de gradient"));
  assert.ok(p.some((x) => /FORMULES : dans statement_html et solution_html, indices et exposants en <sub> et <sup>[^\n]*dans hints \(texte brut, aucune balise\)[^\n]*Jamais en texte nu/.test(x)), p[0].slice(0, 300));
  assert.ok(p.every((x) => !PLAIN.test(x)), "drill : pas de $…$, la vue ne les rend pas");
});
