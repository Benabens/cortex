/**
 * SORTIE LONGUE DES QCM ET DES EXAMENS (prod du 13 au 15/11, HUM-285 et job 2 d'examen) : à l'effort
 * par défaut, Sonnet 5 facture 8 à 15 k tokens de sortie par appel pour 1 à 2,5 k de réponse visible,
 * et la réflexion butait sur la limite de 16 000 tokens : réponse coupée, facturée, refaite ou perdue.
 * Baisser l'effort partout a dégradé la justesse au banc du 15/11 (voir chaque test) : la conception
 * le garde ; seule la vérification à l'aveugle des QCM passe à effort moyen.
 * Verrouillé, contre un faux /v1/messages Anthropic (aucune dépense) : les étapes d'un job QCM et
 * les lots d'un examen écrit ont la place de finir leur réponse au-delà de 16 000 tokens.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-effort-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "anthropic";
process.env.LLM_API_KEY = "sk-ant-test";
process.env.LLM_MAX_RETRIES = "0";
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";
process.env.MAX_COURSES_PER_USER = "unlimited";

function item(i: number, trivial = false) {
  return {
    topic: "pandas groupby",
    type: "scq",
    stem: `Que renvoie df.groupby("sex")["income"].mean() ? (Q${i})`,
    options: [
      "La moyenne des revenus calculée séparément pour chaque modalité de sex.",
      "La moyenne des revenus calculée sur toutes les lignes, sans regroupement.",
      trivial ? "Une TypeError, car groupby n'existe pas en pandas." : "Le nombre de lignes de chaque modalité de sex, sans calcul de moyenne.",
      "La somme des revenus calculée séparément pour chaque modalité de sex.",
    ],
    correct: [0],
    misconceptions: ["", "[sur-généralisation] ignore le regroupement", "[notion voisine] confond mean et count", "[notion voisine] confond mean et sum"],
    explanation: "groupby regroupe par modalité de sex, puis mean calcule la moyenne des revenus de chaque groupe.",
  };
}

const qcmBlocks = (text: string) => [...text.matchAll(/^Q(\d+)\.[\s\S]*?(?=^Q\d+\.|$(?![\s\S]))/gm)];

/** Étape reconnue d'après la demande, et réponse que lui fait le faux modèle. */
function answer(text: string): { step: string; reply: string } {
  // En premier : le schéma d'un lot d'exercices contient lui aussi « items » (tableaux JSON).
  const exercises = /LES (\d+) EXERCICES À PRODUIRE/.exec(text);
  if (exercises) {
    return { step: "conception d'exercices", reply: JSON.stringify({ questions: Array.from({ length: Number(exercises[1]) }, (_, i) => ({
      category: "General", concept: `Exercice ${i + 1}`, statement_tex: String.raw`\subq{1.1}{Calcul}{10} Soit $A \in \mathbb{R}^{2\times 2}$, calculez $\det A$.`, solution_tex: "Réponse : 1.", points: 10,
    })) }) };
  }
  if (/"replacements"/.test(text)) {
    return { step: "remplacement de distracteurs", reply: JSON.stringify({ replacements: qcmBlocks(text).map((m) => ({
      index: Number(m[1]),
      distractors: [...m[0].matchAll(/^\s+\((\d+)\) .* ← À REMPLACER/gm)].map((x) => ({ option: Number(x[1]), text: "La médiane des revenus calculée séparément pour chaque modalité de sex.", misconception: "[quasi-synonyme] médiane pour moyenne" })),
      explanation: "groupby puis mean donne la moyenne par groupe ; la médiane et la somme sont d'autres agrégats.",
    })) }) };
  }
  // Revue finale : audit (verdicts) et doublons dans le même appel.
  if (/"offCourse"/.test(text)) {
    return { step: "revue finale", reply: JSON.stringify({ verdicts: qcmBlocks(text).map((m) => ({ index: Number(m[1]), key: true, offCourse: false, trivial: [] })), duplicates: [] }) };
  }
  if (/"results"/.test(text)) {
    return { step: "vérification QCM", reply: JSON.stringify({ results: qcmBlocks(text).map((m) => ({
      index: Number(m[1]), correct: [[...m[0].matchAll(/^\s+\((\d+)\) (.*)$/gm)].find((o) => /moyenne des revenus calculée séparément/.test(o[2]))?.[1]].map(Number), ok: true, discrimination: 4, name_only: false, issue: "", course_terms: ["groupby"], off_course: "", definition_mismatch: "",
      trivial_distractors: [...m[0].matchAll(/^\s+\((\d+)\) (.*)$/gm)].filter((o) => /TypeError/.test(o[2])).map((o) => Number(o[1])),
    })) }) };
  }
  if (/"items"/.test(text)) {
    const n = Number(/\((\d+) QCM\)/.exec(text)?.[1] ?? 1);
    designs++;
    // Tout le premier lot porte un distracteur trivial : une question propre passerait sinon devant, sans réparation.
    return { step: "conception QCM", reply: JSON.stringify({ items: Array.from({ length: n }, (_, i) => item(i, designs === 1)) }) };
  }
  return { step: "autre", reply: "{}" };
}

let designs = 0;
/** Effort demandé par étape, dans l'ordre des appels. */
const efforts = new Map<string, (string | undefined)[]>();
const maxTokens = new Map<string, (number | undefined)[]>();
let llm: http.Server;

function sse(res: http.ServerResponse, text: string) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event: string, data: object) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", { type: "message_start", message: { id: "msg_t", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
  send("message_stop", { type: "message_stop" });
  res.end();
}

before(async () => {
  delete process.env.CORTEX_USER;
  delete process.env.CORTEX_TEST_STUB_BATCH;
  llm = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { max_tokens?: number; system?: { text: string }[]; messages: { content: { type: string; text?: string }[] }[]; output_config?: { effort?: string; format?: unknown } };
      const text = [
        ...(body.system ?? []).map((s) => s.text),
        ...body.messages.flatMap((m) => m.content.map((c) => c.text ?? "")),
        JSON.stringify(body.output_config?.format ?? {}),
      ].join("\n");
      const { step, reply } = answer(text);
      efforts.set(step, [...(efforts.get(step) ?? []), body.output_config?.effort]);
      maxTokens.set(step, [...(maxTokens.get(step) ?? []), body.max_tokens]);
      sse(res, reply);
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

beforeEach(() => { efforts.clear(); maxTokens.clear(); designs = 0; });

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MAX_RETRIES", "LLM_BASE_URL", "MAX_COURSES_CREATED_PER_HOUR", "MAX_COURSES_PER_USER"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function pandasCourse(): Promise<string> {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const { runWithCourse, ensureFts } = await import("../db/client");
  const { q } = await import("../db/q");
  const { indexItemForSearch } = await import("../lib/search");
  const row = buildCourseRow({ name: "Responsible Software", code: "CS-290", language: "fr", examFormat: { kind: "qcm", questionCount: 4 } }, "owner");
  await insertCourse(row);
  await reloadCourses();
  await runWithCourse(row.id, async () => {
    ensureFts();
    for (const t of ["sources", "items", "topics"]) await q.ensureTable(t);
    const text = "Notebook 3 : df.groupby('sex')['income'].mean() calcule la moyenne des revenus par groupe ; count compte les lignes, sum additionne.";
    const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "course_pdf", "Notebook pandas", "course_pdf/nb3", null, 1);
    const iid = await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "course_pdf", "Notebook pandas", text);
    await indexItemForSearch(iid, sid, "Notebook pandas", text);
    for (const label of ["pandas groupby", "Agrégats pandas", "Regroupement"]) {
      await q.run(`INSERT INTO topics (label, method, exam_weight, exam_count) VALUES (?,?,?,?)`, label, null, 3, 1);
    }
  });
  return row.id;
}

test("job QCM : vérification à effort moyen, les autres étapes à l'effort par défaut, avec la place de finir", async () => {
  // Banc du 15/11 (hum-285-job14, codex-cli) : à effort moyen et bas PARTOUT, 3 clés fausses, 3
  // explications incohérentes et 2 doublons sur 20 QCM, contre 0, 0 et 0 à l'effort par défaut. La
  // conception, la réparation et la revue finale le gardent (à effort moyen, la revue sur-signalait
  // les doublons : boucle moteur, itération 3) ; la vérification, dont la réflexion faisait 88 % de
  // la sortie, passe à effort moyen (itération 4). La limite de sortie reste au-dessus des 16 000
  // tokens où la réflexion coupait la réponse.
  const id = await pandasCourse();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam } = await import("../lib/qcm");
  const r = await runWithCourse(id, () => generateQcmExam({ count: 4, openCount: 0 }));
  assert.equal(r.count, 4);
  assert.deepEqual(efforts.get("autre"), undefined, `appel non reconnu : ${[...efforts.keys()].join(", ")}`);
  const expected: Record<string, string | undefined> = { "conception QCM": undefined, "vérification QCM": "medium", "revue finale": undefined, "remplacement de distracteurs": undefined };
  for (const [step, effort] of Object.entries(expected)) {
    const got = efforts.get(step);
    assert.ok(got?.length, `l'étape « ${step} » a tourné`);
    assert.deepEqual([...new Set(got)], [effort], `effort de « ${step} »`);
    assert.ok((maxTokens.get(step) ?? []).every((m) => (m ?? 0) >= 32_000), `max_tokens de « ${step} » : ${maxTokens.get(step)}`);
  }
});

test("examen écrit (voie des cours sans architecte) : un lot d'exercices garde l'effort par défaut, avec la place de finir", async () => {
  // Banc du 15/11 (cs-202-ecrit, codex-cli) : à effort moyen, 2 clés fausses et 3 explications
  // incohérentes sur 10 exercices, contre 0 sur 5 à l'effort par défaut. La réflexion reste
  // donc entière ; ce qui coûtait (prod du 13/11, job 2), c'étaient les lots coupés à 16 000 tokens.
  const { runWithCourse } = await import("../db/client");
  const { generateExamViaClaudeCode } = await import("../lib/exam");
  const r = await runWithCourse("ml", () => generateExamViaClaudeCode({ count: 2, verify: false }));
  assert.equal(r.produced, 2);
  assert.deepEqual([...new Set(efforts.get("conception d'exercices"))], [undefined]);
  assert.ok((maxTokens.get("conception d'exercices") ?? []).every((m) => (m ?? 0) >= 32_000), `max_tokens : ${maxTokens.get("conception d'exercices")}`);
});
