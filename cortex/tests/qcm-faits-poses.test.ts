/**
 * FAITS DÉJÀ POSÉS (lib/qcm-facts, askedFacts) — banc rs-qcm15 du 17/11/2026 : une question d'un
 * examen précédent (le paradoxe de Simpson, sous un décor d'embauche) n'était rattachée à aucun
 * fait, faute de mots communs avec l'énoncé du fait (seuil lexical de 60 %), et les questions
 * OUVERTES n'étaient pas lues du tout. Le fait, cru jamais posé, revenait au comblement : la
 * reprise était gardée « faute de remplaçant ». Fournisseur LLM simulé : aucune dépense.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-faits-poses-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";

const prompts: string[] = [];
/** Réponse du modèle simulé : chaque question nommée par le test → son fait. */
let reply: (prompt: string) => unknown = () => ({ matches: [] });
let fail = false;

let llm: http.Server;
before(async () => {
  delete process.env.CORTEX_USER;
  llm = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { messages: { content: unknown }[] };
      const content = parsed.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
      prompts.push(content);
      if (fail) { res.statusCode = 500; res.end("{}"); return; }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply(content)) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

beforeEach(() => { prompts.length = 0; fail = false; reply = () => ({ matches: [] }); });

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL", "MAX_COURSES_CREATED_PER_HOUR"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

let courseN = 0;
/** Un cours fictif et ses examens précédents : `qcm` (énoncé, clé) et `open` (notion, énoncé LaTeX). */
async function course(prev: { qcm?: [string, string][]; open?: [string, string][] }): Promise<string> {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const row = buildCourseRow({ name: `Cours fictif faits posés ${++courseN}`, code: "FIC-301", language: "fr", examFormat: { kind: "qcm" } }, "owner");
  await insertCourse(row);
  await reloadCourses();
  await runWithCourse(row.id, async () => {
    for (const t of ["exams", "qcm_items", "exam_questions"]) await q.ensureTable(t);
    const examId = await q.insert(`INSERT INTO exams (format_template, status) VALUES ('qcm','ready')`);
    for (const [i, [stem, key]] of (prev.qcm ?? []).entries()) {
      await q.run(`INSERT INTO qcm_items (exam_id, idx, topic, type, stem, options_json, correct_json, misconceptions_json, explanation, verified) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        examId, i, "Fictif", "scq", stem, JSON.stringify([key, "Autre chose."]), "[0]", "[]", "", 1);
    }
    for (const [concept, tex] of prev.open ?? []) {
      await q.run(`INSERT INTO exam_questions (exam_id, concept, statement_html, solution_html, source_inspiration) VALUES (?,?,?,?,?)`, examId, concept, tex, "", "qcm-open");
    }
  });
  return row.id;
}

const FACTS = async () => {
  const { factId } = await import("../lib/qcm-facts");
  const f = (notion: string, statement: string) => ({ id: factId(statement), notion, statement, passage: statement });
  return [
    f("Paradoxe de Simpson", "Une variable confondante peut inverser l'écart global entre deux groupes quand on compare sous-groupe par sous-groupe."),
    f("Biais de confirmation", "Le biais de confirmation pousse à chercher les indices qui confirment une croyance déjà formée."),
    f("Option par défaut", "Une option par défaut gardée sans retirer le choix constitue un incitatif doux."),
  ];
};

async function asked(id: string) {
  const { runWithCourse } = await import("../db/client");
  const { askedFacts } = await import("../lib/qcm-facts");
  const facts = await FACTS();
  return { facts, asked: await runWithCourse(id, () => askedFacts(facts)) };
}

test("banc rs-qcm15 du 17/11 : une question paraphrasée et une ouverte précédentes sont rattachées à leur fait par le modèle", async () => {
  const id = await course({
    qcm: [["Une entreprise embauche 44 % des hommes et 35 % des femmes ; département par département, les taux sont égaux. Que conclure ?", "Le département masque l'effet : à l'échelle de chaque service, l'avantage disparaît."]],
    open: [["Biais en équipe", String.raw`\callout{This question is \textbf{\large FOR ALL STUDENTS.}} Une équipe ne retient que les retours d'utilisateurs qui vont dans son sens. Explique.`]],
  });
  reply = (prompt) => {
    const qs = [...prompt.matchAll(/^• \(Q(\d+)\) (.*)$/gm)].map((m) => ({ i: Number(m[1]), text: m[2] }));
    return { matches: qs.map(({ i, text }) => ({ question: i, fact: /embauche/.test(text) ? 0 : /retours/.test(text) ? 1 : -1 })) };
  };
  const { facts, asked: got } = await asked(id);
  assert.equal(prompts.length, 1, "un seul appel pour toutes les questions non rattachées");
  assert.ok(got.has(facts[0].id), "le paradoxe de Simpson, posé sous un décor d'embauche, est déjà posé");
  assert.ok(got.has(facts[1].id), "le fait de la question ouverte est déjà posé");
  assert.ok(!got.has(facts[2].id), "un fait jamais posé ne l'est pas");
  assert.doesNotMatch(prompts[0], /FOR ALL STUDENTS|callout/, "l'ouverte en texte, sans l'encadré de section");
});

test("toutes les questions rattachées par leurs mots : aucun appel au modèle", async () => {
  const id = await course({ qcm: [["Que dit le cours ?", "Une option par défaut gardée sans retirer le choix constitue un incitatif doux."]] });
  const { facts, asked: got } = await asked(id);
  assert.equal(prompts.length, 0);
  assert.ok(got.has(facts[2].id));
});

test("modèle indisponible : les rattachements par les mots restent, rien n'échoue", async () => {
  const id = await course({
    qcm: [["Que dit le cours ?", "Une option par défaut gardée sans retirer le choix constitue un incitatif doux."], ["Une entreprise embauche 44 % des hommes ; que conclure ?", "Le département masque l'effet."]],
  });
  fail = true;
  const { facts, asked: got } = await asked(id);
  assert.deepEqual([...got.keys()], [facts[2].id]);
});
