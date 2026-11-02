/**
 * FIABILITÉ DE LA GÉNÉRATION QCM — cas de prod du 01/11 (CS-290) : des énoncés
 * avec du code pandas faisaient échouer le parsing de chaque lot, d'où des
 * examens à 3 QCM sur 7, ou à 0 (« tous les lots ont échoué »).
 * Verrouillé, avec un faux modèle qui renvoie les sorties problématiques :
 *  - un lot enveloppé de ```json dont un énoncé contient un bloc ```python est lu ;
 *  - un lot illisible est redemandé avec l'erreur précise ;
 *  - les QCM manquants sont comblés jusqu'au nombre demandé, dans un budget borné ;
 *  - sinon l'examen DIT combien de questions il a sur combien demandées.
 * Fournisseur LLM simulé (openai-compatible) : aucune dépense.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-qcm-fiab-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";

const BT = "```";
const CODE_STEM = `Considérez le code suivant :\n${BT}python\nimport pandas as pd\ndf = pd.DataFrame({"sex": ["F", "M"], "income": [3, 5]})\nprint(df.groupby("sex")["income"].mean())\n${BT}\nQue fait la dernière ligne ?`;

function item(i: number, stem = `Que renvoie df.groupby("sex")["income"].mean() ? (Q${i})`) {
  return {
    topic: "pandas groupby",
    type: "scq",
    stem,
    options: [
      "La moyenne des revenus calculée séparément pour chaque modalité de sex.",
      "La moyenne des revenus calculée sur toutes les lignes, sans regroupement.",
      "Le nombre de lignes de chaque modalité de sex, sans calcul de moyenne.",
      "La somme des revenus calculée séparément pour chaque modalité de sex.",
    ],
    correct: [0],
    misconceptions: ["", "[sur-généralisation] ignore le regroupement", "[notion voisine] confond mean et count", "[notion voisine] confond mean et sum"],
    explanation: "groupby regroupe par modalité de sex, puis mean calcule la moyenne des revenus de chaque groupe.",
  };
}

/** Réponse du modèle à un appel de conception de lot : n = nombre de QCM demandés au lot. */
let design: (n: number, call: number, prompt: string) => string = (n) => JSON.stringify({ items: Array.from({ length: n }, (_, i) => item(i)) });
let designCalls = 0;
const designPrompts: string[] = [];
const designBodies: Record<string, unknown>[] = [];

function verifyReply(prompt: string): string {
  const blocks = prompt.split(/^(?=Q\d+\.)/m).filter((b) => /^Q\d+\./.test(b));
  const results = blocks.map((b) => {
    const i = Number(/^Q(\d+)\./.exec(b)![1]);
    const opt = [...b.matchAll(/^\s+\((\d+)\) (.*)$/gm)].find((m) => /moyenne des revenus calculée séparément/.test(m[2]));
    return { index: i, correct: [opt ? Number(opt[1]) : 0], ok: true, discrimination: 4, name_only: false, issue: "" };
  });
  return JSON.stringify({ results });
}

let llm: http.Server;
before(async () => {
  delete process.env.CORTEX_USER;
  llm = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { messages: { content: unknown }[] };
      const content = parsed.messages.map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
      let text = "{}";
      if (/"results"/.test(content)) text = verifyReply(content);
      else if (/"items"/.test(content)) {
        designCalls++;
        designPrompts.push(content);
        designBodies.push(parsed as unknown as Record<string, unknown>);
        text = design(Number(/\((\d+) QCM\)/.exec(content)?.[1] ?? 1), designCalls, content);
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

beforeEach(() => { designCalls = 0; designPrompts.length = 0; designBodies.length = 0; });

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

let courseN = 0;
async function codeCourse(): Promise<string> {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const { runWithCourse, ensureFts } = await import("../db/client");
  const { q } = await import("../db/q");
  const { indexItemForSearch } = await import("../lib/search");
  const row = buildCourseRow({ name: `Responsible Software ${++courseN}`, code: "CS-290", language: "fr", examFormat: { kind: "qcm", questionCount: 7 } }, "owner");
  await insertCourse(row);
  await reloadCourses();
  await runWithCourse(row.id, async () => {
    ensureFts();
    for (const t of ["sources", "items", "topics"]) await q.ensureTable(t);
    const text = "Notebook 3 : df.groupby('sex')['income'].mean() calcule la moyenne des revenus par groupe.";
    const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "course_pdf", "Notebook pandas", "course_pdf/nb3", null, 1);
    const iid = await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "course_pdf", "Notebook pandas", text);
    await indexItemForSearch(iid, sid, "Notebook pandas", text);
    for (const label of ["pandas groupby", "Biais des données", "Équité algorithmique"]) {
      await q.run(`INSERT INTO topics (label, method, exam_weight, exam_count) VALUES (?,?,?,?)`, label, null, 3, 1);
    }
  });
  return row.id;
}

test("sorties problématiques du modèle → 7 QCM sur 7, code des énoncés intact", async () => {
  const id = await codeCourse();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  design = (n, call) => {
    // 1ᵉʳ lot : enveloppé de ```json, un énoncé avec un bloc ```python (cas de prod).
    if (call === 1) return `${BT}json\n${JSON.stringify({ items: Array.from({ length: n }, (_, i) => item(i, i === 0 ? CODE_STEM : undefined)) }, null, 2)}\n${BT}`;
    // 2ᵉ lot : prose sans JSON, puis, redemandé, un QCM de moins que demandé.
    if (call === 2) return "Voici les QCM demandés, conformes au format du cours.";
    if (call === 3) return JSON.stringify({ items: Array.from({ length: n - 1 }, (_, i) => item(10 + i)) });
    return JSON.stringify({ items: Array.from({ length: n }, (_, i) => item(20 + i)) });
  };
  const r = await runWithCourse(id, () => generateQcmExam({ count: 7, openCount: 0 }));
  assert.equal(r.count, 7, "le QCM manquant est comblé");
  assert.equal(r.requested, 7);
  const retry = designPrompts.find((p) => /n'était pas un JSON valide/.test(p));
  assert.ok(retry, "le lot illisible est redemandé avec l'erreur");
  assert.match(retry!, /sans JSON/);
  assert.ok(designBodies.every((b) => b.response_format), "la conception demande une sortie structurée");
  const exam = await runWithCourse(id, () => getQcmExam(r.id));
  assert.equal(exam!.items.length, 7);
  assert.ok(exam!.items.some((it) => it.stem.includes(`${BT}python\nimport pandas as pd`)), "le bloc de code de l'énoncé est gardé tel quel");
  assert.doesNotMatch(exam!.verifySummary ?? "", /sur 7/, "un examen complet ne signale rien");
});

test("le modèle ne rend jamais assez de QCM : comblement borné, et l'examen dit « n sur 7 »", async () => {
  const id = await codeCourse();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  design = (_n, call) => JSON.stringify({ items: [item(call)] });
  const r = await runWithCourse(id, () => generateQcmExam({ count: 7, openCount: 0 }));
  assert.ok(r.count > 0 && r.count < 7, `count=${r.count}`);
  assert.equal(r.requested, 7);
  assert.ok(designCalls <= 4, `budget de comblement borné (${designCalls} lots demandés pour 2 prévus)`);
  const exam = await runWithCourse(id, () => getQcmExam(r.id));
  assert.match(exam!.verifySummary ?? "", new RegExp(`${r.count} sur 7`));
});

test("aucun lot lisible : erreur claire qui dit pourquoi, jamais « unknown »", async () => {
  const id = await codeCourse();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam } = await import("../lib/qcm");
  design = () => "Je ne peux pas produire ce JSON.";
  await assert.rejects(
    runWithCourse(id, () => generateQcmExam({ count: 4, openCount: 0 })),
    (e: unknown) => e instanceof Error && /Aucun QCM généré/.test(e.message) && /illisible/.test(e.message),
  );
  assert.ok(designCalls <= 6, `essais bornés (${designCalls})`);
});

test("un item mal formé au milieu d'un lot : c'est SON sujet qui est comblé", async () => {
  const id = await codeCourse();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam } = await import("../lib/qcm");
  design = (n, call) => {
    const items = Array.from({ length: n }, (_, i) => item(call * 10 + i));
    if (call === 1) items[1] = { ...items[1], options: [] }; // 2ᵉ QCM du 1ᵉʳ lot inutilisable
    return JSON.stringify({ items });
  };
  const r = await runWithCourse(id, () => generateQcmExam({ count: 3, openCount: 0 }));
  assert.equal(r.count, 3);
  const subjects = (p: string) => [...p.matchAll(/^ {2}(\d+)\) (.+?)(?: \[|$)/gm)].map((m) => m[2].trim());
  const first = subjects(designPrompts[0]);
  const topup = subjects(designPrompts[1]);
  assert.deepEqual(topup, [first[1]], `comblé : ${topup.join(" | ")} ; lot : ${first.join(" | ")}`);
});

