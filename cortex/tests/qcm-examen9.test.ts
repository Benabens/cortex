/**
 * JOB 23 REJOUÉ DE BOUT EN BOUT (lib/qcm, generateQcmExam) — examen QCM #9, livré le
 * 14/11/2026 avec trois questions dont la réponse était « le biais de disponibilité », neuf
 * explications qui réfutaient des options absentes, deux options identiques dans Q9 et Q10 livrée
 * « not_verified ». Les questions du concepteur simulé sont celles de l'examen (énoncés
 * paraphrasés, noms fictifs, cf. PR #84). Verrouillé, même quand le contrôle des doublons par le modèle échoue :
 *  - une seule question par notion de bonne réponse, les retirées remplacées (nombre tenu) ;
 *  - aucune option répétée : la seconde est remplacée, la question revérifiée ;
 *  - aucune explication livrée ne réfute une option absente ;
 *  - une question réparée que le nouvel audit écarte revient à sa version auditée (Q10), vérifiée.
 * Fournisseur LLM simulé (openai-compatible) : aucune dépense.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { duplicateOptionIndices, explanationIssues, keyNotion } from "../lib/qcm-checks";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-qcm-examen9-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";

type Item = { n: number; topic: string; stem: string; options: string[]; correct: number[]; explanation: string };
const EXAM9: Item[] = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "qcm-job23-examen9.json"), "utf8")).items;
const q = (n: number) => EXAM9.find((it) => it.n === n)!;
const keyText = new Map(EXAM9.map((it) => [it.stem, it.options[it.correct[0]]]));

/** Lots initiaux : les questions de l'examen #9 qui portent les défauts ; ensuite, des questions saines. */
const FIRST = [[1, 9, 14, 4], [10, 16, 17, 8]];
const SPARE = [2, 3, 5, 15, 7, 11, 6, 12];
let designCalls = 0;
let spareNext = 0;
const asItem = (it: Item) => ({ topic: it.topic, type: "scq", stem: it.stem, options: it.options, correct: it.correct, misconceptions: it.options.map((_, k) => (it.correct.includes(k) ? "" : "[notion voisine] x")), explanation: it.explanation });
function design(n: number) {
  designCalls++;
  const planned = FIRST[designCalls - 1];
  return Array.from({ length: n }, (_, i) => asItem(q(planned?.[i] ?? SPARE[spareNext++ % SPARE.length])));
}

const NEW_OPTION = "Le biais de cadrage, soit une présentation des choix qui oriente la décision sans rien interdire.";
const blocks = (prompt: string) => prompt.split(/^(?=Q\d+\.)/m).filter((b) => /^Q\d+\./.test(b));
const optionLines = (b: string) => [...b.matchAll(/^\s+\((\d+)\) (.*)$/gm)].map((m) => ({ k: Number(m[1]), text: m[2] }));
const stemOf = (b: string) => EXAM9.find((it) => b.includes(it.stem.slice(0, 80)));

let auditCalls = 0;
let dedupeCalls = 0;
const dedupePrompts: string[] = [];
const replacementPrompts: string[] = [];
const rewritePrompts: string[] = [];

function reply(content: string): string | null {
  if (/"replacements"/.test(content)) {
    replacementPrompts.push(content);
    return JSON.stringify({ replacements: blocks(content).map((b) => ({
      index: Number(/^Q(\d+)\./.exec(b)![1]),
      distractors: optionLines(b).filter((o) => /À REMPLACER/.test(o.text)).map((o) => ({ option: o.k, text: NEW_OPTION, misconception: "[notion voisine] cadrage" })),
    })) });
  }
  if (/"explanations"/.test(content)) {
    rewritePrompts.push(content);
    return JSON.stringify({ explanations: blocks(content.split("═══ QCM ═══")[1] ?? "").map((b) => {
      const wrong = optionLines(b).filter((o) => !/\(bonne réponse\)/.test(o.text)).map((o) => o.text.split(",")[0]);
      return { index: Number(/^Q(\d+)\./.exec(b)![1]), explanation: `La bonne réponse est celle que le cours établit. ${wrong.map((w) => `L'option qui dit « ${w} » est fausse.`).join(" ")}` };
    }) });
  }
  // Le contrôle des doublons par le modèle tombe en panne : les plafonds doivent suffire.
  if (/"duplicates"/.test(content)) { dedupeCalls++; dedupePrompts.push(content); return null; }
  if (/"offCourse"/.test(content)) {
    auditCalls++;
    return JSON.stringify({ verdicts: blocks(content).map((b) => {
      const index = Number(/^Q(\d+)\./.exec(b)![1]);
      const n = stemOf(b)?.n;
      // Premier audit : un distracteur de Q10 jugé trivial → réparé ; le nouvel audit écarte la version réparée.
      const trivial = n === 10 && auditCalls === 1 ? optionLines(b).filter((o) => /uniquement si les données sont traitées/.test(o.text)).map((o) => o.k) : [];
      // Audit des questions arrivées après coup (complément) : la clé de Q3 est contestée.
      return { index, key: !(n === 10 && auditCalls > 1) && !(n === 3 && auditCalls > 2), offCourse: false, trivial };
    }) });
  }
  if (/"results"/.test(content)) {
    return JSON.stringify({ results: blocks(content).map((b) => {
      const key = keyText.get(stemOf(b)?.stem ?? "");
      const k = optionLines(b).find((o) => o.text === key)?.k ?? 0;
      return { index: Number(/^Q(\d+)\./.exec(b)![1]), correct: [k], ok: true, discrimination: 4, name_only: false, issue: "", course_terms: [], off_course: "", off_course_terms: [], off_matter: "", trivial_distractors: [], definition_mismatch: "" };
    }) });
  }
  if (/"items"/.test(content)) return JSON.stringify({ items: design(Number(/\((\d+) QCM\)/.exec(content)?.[1] ?? 1)) });
  return "{}";
}

let llm: http.Server;
before(async () => {
  delete process.env.CORTEX_USER;
  llm = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const parsed = JSON.parse(body) as { messages: { content: unknown }[] };
      const content = parsed.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
      const text = reply(content);
      res.setHeader("content-type", "application/json");
      if (text === null) { res.statusCode = 500; res.end(JSON.stringify({ error: { message: "panne simulée" } })); return; }
      res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  process.env.QCM_BATCH_CONCURRENCY = "1";
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL", "MAX_COURSES_CREATED_PER_HOUR", "QCM_BATCH_CONCURRENCY"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Quatre notions pour huit questions : deux questions au plus par notion, sous des angles distincts. */
async function course(): Promise<string> {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const { runWithCourse, ensureFts } = await import("../db/client");
  const { q: db } = await import("../db/q");
  const { indexItemForSearch } = await import("../lib/search");
  const row = buildCourseRow({ name: "Cours fictif examen 9", code: "FIC-101", language: "fr", examFormat: { kind: "qcm" } }, "owner");
  await insertCourse(row);
  await reloadCourses();
  await runWithCourse(row.id, async () => {
    ensureFts();
    for (const t of ["sources", "items", "topics"]) await db.ensureTable(t);
    const text = "Biais de disponibilité, biais de négativité, excès de confiance, réalité partagée, confiance, nudges, souveraineté des données.";
    const sid = await db.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "course_pdf", "Séances 1 à 6", "course_pdf/s1", null, 1);
    const iid = await db.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "course_pdf", "Séances 1 à 6", text);
    await indexItemForSearch(iid, sid, "Séances 1 à 6", text);
    for (const label of ["Biais cognitifs", "Désinformation", "Nudges", "Souveraineté des données"]) {
      await db.run(`INSERT INTO topics (label, method, exam_weight, exam_count) VALUES (?,?,?,?)`, label, null, 3, 1);
    }
  });
  return row.id;
}

test("job 23 rejoué, contrôle des doublons du modèle en panne : examen livré sans doublon de réponse, sans option répétée, explications justes, tout vérifié", async () => {
  const id = await course();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  const steps: string[] = [];
  const { r, view } = await runWithCourse(id, async () => {
    const r = await generateQcmExam({ count: 8, openCount: 0, onStep: (s) => { steps.push(s); } });
    return { r, view: (await getQcmExam(r.id, true))! };
  });
  const items = view.items as unknown as (Item & { verified: 0 | 1 | null })[];
  const delivered = (n: number) => items.find((it) => it.stem === q(n).stem);

  assert.equal(r.count, 8, steps.join("\n"));
  // Le contrôle du modèle a échoué (réessayé une fois) et le job le dit ; les plafonds ont tenu.
  assert.ok(dedupeCalls >= 2, `contrôle des doublons appelé ${dedupeCalls} fois`);
  assert.ok(steps.some((s) => /Contrôle des doublons en échec/.test(s)), steps.join("\n"));
  assert.ok(steps.some((s) => /plafonds par notion appliqués seuls/.test(s)), steps.join("\n"));
  // Le contrôle voit la bonne réponse de chaque question et les paires à trancher en priorité.
  assert.match(dedupePrompts[0], /Bonne réponse : Le biais de disponibilité, car/);
  // Après le complément, Q5 (confiance, avec « réalité partagée » en distracteur) croise Q4 : paire à trancher.
  assert.ok(dedupePrompts.some((p) => /Paires à trancher en priorité[^\n]*Q\d+–Q\d+/.test(p)), "une paire à trancher est soumise");
  // Une notion de bonne réponse = une question : Q1 reste, Q14 et Q16 (biais de disponibilité) et Q17 (réalité partagée) partent.
  assert.ok(delivered(1) && delivered(4), "les premières occurrences restent");
  for (const n of [14, 16, 17]) assert.ok(!delivered(n), `Q${n} retirée`);
  const keys = items.map((it) => keyNotion(it)).filter(Boolean);
  assert.equal(new Set(keys).size, keys.length, `notions de bonne réponse : ${keys.join(", ")}`);
  // Q9 : l'option répétée a été remplacée (le remplacement savait pourquoi), la question revérifiée.
  assert.ok(replacementPrompts.some((p) => /répète une autre option/.test(p)), "le remplacement dit que l'option répète une autre option");
  for (const it of items) assert.deepEqual(duplicateOptionIndices(it.options, it.correct), [], `options répétées : ${it.stem.slice(0, 60)}`);
  assert.ok(delivered(9)?.options.includes(NEW_OPTION), "Q9 gardée, son option répétée remplacée");
  // Aucune explication livrée ne réfute une option absente, ni plus d'options qu'il n'y en a.
  assert.ok(rewritePrompts.length >= 1, "les explications fautives sont réécrites sur les options réelles");
  for (const it of items) assert.equal(explanationIssues(it.explanation, it.options, it.correct, it.stem), null, `${it.stem.slice(0, 60)} :\n${it.explanation}`);
  // Q10 : réparée puis écartée par le nouvel audit → sa version auditée revient, vérifiée, options d'origine.
  const q10 = delivered(10);
  assert.ok(q10, "Q10 livrée");
  assert.deepEqual([...q10!.options].sort(), [...q(10).options].sort());
  assert.ok(auditCalls >= 2, "la version réparée a été ré-auditée");
  // Les questions du complément passent l'audit final elles aussi : Q3, clé contestée, est écartée,
  // et la place est recomblée par un nouveau complément au lieu d'être abandonnée.
  assert.ok(steps.some((s) => /QCM tardif\(s\) écarté\(s\) par l'audit/.test(s)), steps.join("\n"));
  assert.ok(!delivered(3), "Q3 écartée par l'audit tardif");
  assert.equal(steps.filter((s) => /complément final/.test(s)).length, 2, steps.join("\n"));
  // Jamais de « not_verified » quand la vérification est possible.
  assert.deepEqual(items.filter((it) => it.verified !== 1).map((it) => it.stem.slice(0, 60)), []);
});

test("job 23 : Q8/Q19 (nudge) et Q10/Q20 (risque extraterritorial), que les plafonds laissent passer à deux par notion, sont soumises en priorité au contrôle des doublons", async () => {
  const { suspectPairs } = await import("../lib/qcm");
  // En prod, la notion d'une question est celle du programme qui l'a demandée (son « topic »).
  const pairs = suspectPairs(EXAM9.map((it) => ({ ...it, notion: it.topic }))).map(([a, b]) => `${EXAM9[a].n}-${EXAM9[b].n}`);
  for (const p of ["8-19", "10-20", "1-14", "1-16", "14-16", "4-17", "5-18"]) assert.ok(pairs.includes(p), `paire ${p} absente : ${pairs.join(", ")}`);
});
