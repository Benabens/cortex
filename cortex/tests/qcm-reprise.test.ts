/**
 * REPRISE D'UN EXAMEN QCM — constat prod du 14-15/11/2026 : un job QCM tué par un redéploiement
 * (jobs 23 et 25, à 99 %) était repris par la pompe depuis zéro, faute de point de reprise : le
 * job 25 a duré 70 min et coûté deux fois. Le point de reprise (lib/qcm-checkpoint) garde les QCM
 * construits et vérifiés après chaque groupe de lots, puis l'ensemble passé par la porte de sortie.
 * La coupure est simulée en rejouant un point de reprise enregistré par un premier run : tout ce
 * que ce run a fait après lui est perdu, comme pour un worker tué à cet instant.
 * Fournisseur LLM simulé (openai-compatible) : aucune dépense.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-qcm-reprise-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";
process.env.MAX_COURSES_PER_USER = "unlimited";
// Un lot par groupe : un point de reprise après chaque lot conçu et vérifié.
process.env.QCM_BATCH_CONCURRENCY = "1";

const KEY = "Une affirmation juste, tirée du cours.";

/** Numérotation continue d'un run à l'autre : un QCM reconçu a un énoncé neuf, jamais celui d'un QCM repris. */
let designed = 0;
const calls = { design: 0, verify: 0, repair: 0, audit: 0, dedup: 0, other: 0 };
const designedStems: string[] = [];
const auditedStems: string[] = [];

function blocks(prompt: string): { index: number; body: string }[] {
  return [...prompt.matchAll(/^Q(\d+)\.([\s\S]*?)(?=^Q\d+\.|$(?![\s\S]))/gm)].map((m) => ({ index: Number(m[1]), body: m[0] }));
}

function design(prompt: string): string {
  const subjects = [...prompt.matchAll(/^ {2}(\d+)\) (.+?)(?: \[|$)/gm)].map((m) => m[2].trim());
  const n = Number(/\((\d+) QCM\)/.exec(prompt)?.[1] ?? 1);
  return JSON.stringify({ items: Array.from({ length: n }, (_, i) => {
    const g = ++designed;
    const stem = `Question ${g} : que dit le cours sur ${subjects[i] ?? "la notion"} ?`;
    designedStems.push(stem);
    return {
      topic: subjects[i] ?? `Notion ${g}`, type: "scq", stem,
      options: [KEY, "Une affirmation inversée par rapport au cours.", "Une affirmation proche du cours, fausse à une condition près.", "Une affirmation attribuée à la mauvaise étude."],
      correct: [0], misconceptions: ["", "[inversion] x", "[mauvaise condition] x", "[mauvaise attribution] x"],
      explanation: "La bonne réponse reprend le cours ; l'inversion et la mauvaise attribution le déforment.",
      source_fact: "Équité des modèles, taux de faux positifs, impact disparate, modération de contenus.",
    };
  }) });
}

function verify(prompt: string): string {
  return JSON.stringify({ results: blocks(prompt).map(({ index, body }) => {
    const opts = [...body.matchAll(/^\s+\((\d+)\) (.*)$/gm)];
    return {
      index, correct: [Number(opts.find((m) => m[2].startsWith(KEY))?.[1] ?? 0)], ok: true, discrimination: 4, name_only: false, issue: "",
      course_terms: [], off_course: "", off_course_terms: [], off_course_options: [], off_course_key: false, off_matter: "",
      trivial_distractors: [], definition_mismatch: "",
    };
  }) });
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
      let text = "{}";
      if (/"replacements"/.test(content)) { calls.repair++; text = JSON.stringify({ replacements: [] }); }
      else if (/"duplicates"/.test(content)) { calls.dedup++; text = JSON.stringify({ notions: [], duplicates: [] }); }
      else if (/"offCourse"/.test(content)) {
        calls.audit++;
        const bs = blocks(content);
        auditedStems.push(...bs.map((b) => b.body.split("\n")[0]));
        text = JSON.stringify({ verdicts: bs.map(({ index }) => ({ index, key: true, offCourse: false, trivial: [] })) });
      }
      else if (/"results"/.test(content)) { calls.verify++; text = verify(content); }
      else if (/"items"/.test(content)) { calls.design++; text = design(content); }
      else calls.other++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

beforeEach(() => resetCalls());

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL", "MAX_COURSES_CREATED_PER_HOUR", "MAX_COURSES_PER_USER", "QCM_BATCH_CONCURRENCY"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

function resetCalls() {
  for (const k of Object.keys(calls) as (keyof typeof calls)[]) calls[k] = 0;
  designedStems.length = 0;
  auditedStems.length = 0;
}
const llmCalls = () => Object.values(calls).reduce((s, n) => s + n, 0);

const NOTIONS = Array.from({ length: 24 }, (_, i) => `Notion fictive ${String.fromCharCode(65 + i)}`);

let courseN = 0;
async function course(): Promise<string> {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const { runWithCourse, ensureFts } = await import("../db/client");
  const { q } = await import("../db/q");
  const { indexItemForSearch } = await import("../lib/search");
  const row = buildCourseRow({ name: `Cours fictif reprise ${++courseN}`, code: "FIC-102", language: "fr", examFormat: { kind: "qcm" } }, "owner");
  await insertCourse(row);
  await reloadCourses();
  await runWithCourse(row.id, async () => {
    ensureFts();
    for (const t of ["sources", "items", "topics"]) await q.ensureTable(t);
    const text = "Équité des modèles, taux de faux positifs, impact disparate, modération de contenus.";
    const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "course_pdf", "Séances", "course_pdf/s1", null, 1);
    const iid = await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "course_pdf", "Séances", text);
    await indexItemForSearch(iid, sid, "Séances", text);
    for (const label of NOTIONS) await q.run(`INSERT INTO topics (label, method, exam_weight, exam_count) VALUES (?,?,?,?)`, label, null, 3, 1);
  });
  return row.id;
}

type Snapshot = import("../lib/qcm-checkpoint").QcmCheckpoint;

/** Point de reprise en mémoire : `saves` garde une copie de chaque écriture, dans l'ordre. */
function store(initial: unknown = null) {
  let current: unknown = initial;
  const saves: Snapshot[] = [];
  return {
    saves,
    load: async () => current,
    save: async (data: unknown) => {
      current = data;
      if (data) saves.push(JSON.parse(JSON.stringify(data)) as Snapshot);
    },
  };
}

async function generate(courseId: string, opts: { count: number; openCount: number; checkpoint: ReturnType<typeof store> }) {
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  const steps: string[] = [];
  return runWithCourse(courseId, async () => {
    const r = await generateQcmExam({ ...opts, onStep: (s) => { steps.push(s); } });
    return { r, steps, exam: (await getQcmExam(r.id, true))! };
  });
}

test("coupure après le premier lot : la reprise ne reconçoit que les lots restants, les QCM acquis passent la porte de sortie", async () => {
  const id = await course();
  const first = store();
  const run1 = await generate(id, { count: 12, openCount: 0, checkpoint: first });
  assert.equal(run1.r.count, 12);
  assert.equal(calls.design, 3, "12 QCM = 3 lots");
  const cut = first.saves.find((s) => s.loop && s.loop.round === 0 && s.loop.next === 1);
  assert.ok(cut, `point de reprise après le premier lot : ${JSON.stringify(first.saves.map((s) => Object.keys(s)))}`);
  const acquired = cut.loop!.selected;
  assert.equal(acquired.length, 4, "le premier lot : 4 QCM construits et vérifiés");

  resetCalls();
  const run2 = await generate(id, { count: 12, openCount: 0, checkpoint: store(cut) });
  const detail = `${JSON.stringify(calls)}\n${run2.steps.join("\n")}`;
  assert.equal(run2.r.count, 12, detail);
  assert.equal(calls.design, 2, `seuls les 2 lots restants sont conçus : ${detail}`);
  assert.ok(!designedStems.some((st) => acquired.includes(st)), "aucun QCM acquis n'est reconçu");
  const delivered = run2.exam.items.map((it) => it.stem);
  for (const st of acquired) assert.ok(delivered.includes(st), `QCM acquis livré : ${st}`);
  // #90 : dédoublonnage et audit de sortie portent sur l'ENSEMBLE, repris compris.
  assert.ok(calls.dedup >= 1, `dédoublonnage sur l'ensemble : ${detail}`);
  for (const st of acquired) assert.ok(auditedStems.some((a) => a.includes(st)), `QCM repris audité à la sortie : ${st}`);
  assert.ok(run2.steps.some((s) => /Reprise après interruption : 4 QCM/.test(s)), detail);
});

test("coupure après l'enregistrement de l'examen : la reprise le complète sans un seul appel au modèle ni doublon en base", async () => {
  const id = await course();
  const first = store();
  const run1 = await generate(id, { count: 8, openCount: 0, checkpoint: first });
  const cut = first.saves.find((s) => s.final?.examId != null);
  assert.ok(cut, "point de reprise après l'enregistrement");
  assert.equal(cut.final!.examId, run1.r.id);

  resetCalls();
  const run2 = await generate(id, { count: 8, openCount: 0, checkpoint: store(cut) });
  assert.equal(llmCalls(), 0, `aucun appel : ${JSON.stringify(calls)}`);
  assert.equal(run2.r.id, run1.r.id, "le même examen est complété, pas un second");
  assert.equal(run2.exam.items.length, 8, "les QCM ne sont pas réinsérés");
  assert.deepEqual(run2.exam.items.map((it) => it.stem), run1.exam.items.map((it) => it.stem));
  assert.equal(run2.exam.status, "ready");
});

test("questions ouvertes déjà construites : reprises telles quelles, l'architecte n'est pas rappelé", async () => {
  const id = await course();
  const first = store();
  await generate(id, { count: 4, openCount: 0, checkpoint: first });
  const done = first.saves.find((s) => s.final && s.final.examId == null)!;
  // Même examen avec une question ouverte, coupé après la porte de sortie des QCM et la première ouverte.
  const { qcmCheckpointKey } = await import("../lib/qcm-checkpoint");
  const cut: Snapshot = {
    ...done,
    key: qcmCheckpointKey({ count: 4, openCount: 1 }),
    open: [[0, { concept: "Notion fictive A", statement_tex: "Énoncé ouvert fictif.", solution_tex: "Corrigé fictif.", points: 15 }]],
  };
  resetCalls();
  const run2 = await generate(id, { count: 4, openCount: 1, checkpoint: store(cut) });
  assert.equal(llmCalls(), 0, `aucun appel : ${JSON.stringify(calls)}`);
  assert.equal(run2.r.open, 1);
  assert.equal(run2.exam.open.length, 1);
  assert.equal(run2.exam.open[0].concept, "Notion fictive A");
});

test("point de reprise d'une autre composition : ignoré, l'examen est conçu à neuf", async () => {
  const id = await course();
  const first = store();
  await generate(id, { count: 4, openCount: 0, checkpoint: first });
  const other = first.saves.find((s) => s.final)!;
  resetCalls();
  const run2 = await generate(id, { count: 8, openCount: 0, checkpoint: store(other) });
  assert.equal(run2.r.count, 8);
  assert.equal(calls.design, 2, "8 QCM conçus à neuf");
});
