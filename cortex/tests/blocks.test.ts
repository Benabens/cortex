/**
 * QUESTIONS COMPOSÉES (lib/blocks) — le format mid-term de CS-290, le plus courant à
 * l'EPFL : chaque question est un court scénario (ou un extrait de code) suivi de 3 à 6
 * sous-questions mêlant choix unique, lecture de code et réponse courte. Verrouillé ici :
 *  - le nombre de questions demandé est tenu (une réponse mal formée est redemandée avec
 *    l'erreur, un bloc rejeté par le juge est régénéré), le manque éventuel est compté ;
 *  - fidélité au cours : extraits du cours dans le prompt, juge à l'aveugle (clé, sortie
 *    du code, définitions) ; la sortie d'un extrait de code est celle de son EXÉCUTION ;
 *  - rendu : vue en ligne sans les réponses, PDF énoncé + corrigé ;
 *  - correction : choix unique et sortie de code automatiques ; réponse courte corrigée
 *    critère par critère sur le barème FIXÉ à la génération.
 * Fournisseur LLM simulé (openai-compatible) : aucune dépense.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-blocks-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";
process.env.MAX_COURSES_PER_USER = "unlimited";

type Part = { kind: string; prompt: string; code: string; options: string[]; correct: number; answer: string; criteria: { label: string; points: number }[]; points: number; explanation: string };
const scq = (tag: string): Part => ({ kind: "scq", prompt: `Which phenomenon is at work (${tag})?`, code: "", options: ["Right: a reinforcing feedback loop", "A balancing loop", "Illusory truth effect", "Malinformation"], correct: 0, answer: "", criteria: [], points: 1, explanation: "The course: a reinforcing loop amplifies its own cause." });
const short = (tag: string): Part => ({ kind: "short", prompt: `Explain in two sentences why the feed narrows (${tag}).`, code: "", options: [], correct: -1, answer: "Engagement feeds the ranking, which feeds engagement: a reinforcing loop.", criteria: [{ label: "Names the reinforcing loop", points: 1 }, { label: "Explains the amplification", points: 1 }], points: 2, explanation: "" });
const code = (answer: string): Part => ({ kind: "code_output", prompt: "What does this code print?", code: "likes = [2, 1]\nprint(sorted(likes))", options: [], correct: -1, answer, criteria: [], points: 2, explanation: "sorted returns a new sorted list." });
const block = (tag: string, parts: Part[], scenario = `A video platform ranks posts by engagement (${tag}).`) => ({ title: `Recommendation (${tag})`, scenario, parts });

/** Réponses du générateur, par thème (dans l'ordre des appels). */
let script: Record<string, unknown[]> = {};
const prompts: string[] = [];
const judged: string[] = [];
let llm: http.Server;

before(async () => {
  delete process.env.CORTEX_USER;
  llm = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const content = (JSON.parse(body).messages as { content: unknown }[]).map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
      let text = "{}";
      if (/"verdicts"/.test(content)) {
        judged.push(content);
        // Juge à l'aveugle : retrouve la bonne option (« Right: »), prédit la sortie du code.
        const parts = [...content.matchAll(/^\(([a-z])\) \[(scq|short|code_output)\]/gm)];
        const verdicts = parts.map((m, i) => {
          const after = content.slice(m.index);
          const opts = [...after.split(/^\([a-z]\) \[/m)[1]?.matchAll(/^ {2}([A-D])\. (.*)$/gm) ?? []];
          return {
            index: i, ok: true, issue: "",
            answer: m[2] === "scq" ? String(Math.max(0, opts.findIndex((o) => o[2].startsWith("Right:")))) : m[2] === "code_output" ? "[1, 2]" : "Engagement feeds ranking: reinforcing loop.",
          };
        });
        text = JSON.stringify({
          // Juge muet : aucun verdict rendu.
          verdicts: /SILENT/.test(content) ? [] : verdicts,
          off_course: "",
          definition_mismatch: /NARROW/.test(content) ? "feedback loop : la question la réduit aux boucles positives ; le cours : renforçante OU équilibrante" : "",
          // Banc du 04/11 (CS-290 composite) : le juge a rendu les options en CHAÎNE, l'examen entier plantait.
          trivial_distractors: /STRINGOPTS/.test(content) ? [{ index: 0, options: "A, B — l'énoncé donne déjà la réponse" }]
            // Banc rs-composite du 22/11 : le juge nomme les options par leur LETTRE dans l'ordre mélangé.
            : /TRIVIAL/.test(content) && /^ {2}B\. /m.test(content) ? [{ index: 0, options: ["B"] }] : [],
        });
      } else if (/"parts"/.test(content) && /"scenario"/.test(content)) {
        prompts.push(content);
        const theme = /^THÈME : (.+)$/m.exec(content)?.[1] ?? "";
        const key = Object.keys(script).find((k) => theme.includes(k)) ?? "";
        const queue = script[key] ?? [];
        text = JSON.stringify(queue.length > 1 ? queue.shift() : queue[0] ?? block("default", [scq("d"), short("d"), code("[1, 2]")]));
      } else if (/BARÈME IMPOSÉ/.test(content)) {
        prompts.push(content);
        text = JSON.stringify({ verdict: "partial", feedback: "Explique l'amplification.", correct_solution: "…", criteria: [
          { label: "autre libellé", points: 5, achieved: true, essential: true, justification: "La boucle est nommée." },
          { label: "encore un autre", points: 5, achieved: false, essential: false, justification: "L'amplification manque." },
        ] });
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

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL", "MAX_COURSES_CREATED_PER_HOUR", "MAX_COURSES_PER_USER"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const CHAPTERS: Record<string, string> = {
  "Introduction - ethics": "Ethical theories",
  "Safety 1 - moderation": "Keyword filtering",
  "Safety 2 - recommendation": "Feedback loops",
};

/** Cours composite déclaré, trois chapitres d'une notion chacun (textes paraphrasés). */
async function compositeCourse(n: number): Promise<string> {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const { runWithCourse, ensureFts } = await import("../db/client");
  const { q } = await import("../db/q");
  const { indexItemForSearch } = await import("../lib/search");
  const row = buildCourseRow({ name: `Responsible Software ${Math.random().toString(36).slice(2, 7)}`, code: "CS-290", language: "en", examFormat: { kind: "composite", questionCount: n } }, "owner");
  await insertCourse(row);
  await reloadCourses();
  await runWithCourse(row.id, async () => {
    ensureFts();
    for (const t of ["sources", "items", "topics"]) await q.ensureTable(t);
    for (const [title, label] of Object.entries(CHAPTERS)) {
      const text = `${title}. ${label}: the course explains ${label.toLowerCase()} with examples. A feedback loop is reinforcing or balancing.`;
      const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "note", title, `note/${title}`, null, 1);
      const iid = await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "note", title, text);
      await indexItemForSearch(iid, sid, title, text);
      await q.run(`INSERT INTO topics (label, method, exam_weight, exam_count) VALUES (?,?,?,?)`, label, null, 5, 1);
    }
  });
  return row.id;
}

const texAvailable = () => ["tectonic", "pdflatex"].some((b) => { try { execFileSync("which", [b], { stdio: "ignore" }); return true; } catch { return false; } });

let examCourse = "";
let examId = 0;

test("C — 3 questions composées demandées, 3 livrées : réponse mal formée redemandée, bloc rejeté par le juge régénéré, sortie du code exécutée", async () => {
  examCourse = await compositeCourse(3);
  script = {
    "Ethical theories": [block("A", [scq("A"), short("A")]), block("A", [scq("A"), short("A"), code("[1, 2]")])],
    "Keyword filtering": [block("B", [scq("B"), short("B"), code("[1, 2]")], "NARROW: a feedback loop is always positive."), block("B", [scq("B"), short("B"), code("[1, 2]")])],
    "Feedback loops": [block("C", [scq("C"), short("C"), code("[2, 1]"), scq("C2")])],
  };
  const { runWithCourse } = await import("../db/client");
  const { generateMockExam } = await import("../lib/mock-exam");
  const { getBlockExam } = await import("../lib/blocks");
  const steps: string[] = [];
  prompts.length = 0;
  const r = await runWithCourse(examCourse, () => generateMockExam({ onStep: (s) => { steps.push(s); } }));
  examId = r.id;
  assert.equal(r.url, `/mock/${r.id}`);
  assert.deepEqual([r.produced, r.requested], [3, 3], steps.join("\n"));
  const exam = (await runWithCourse(examCourse, () => getBlockExam(r.id, true)))!;
  assert.equal(exam.blocks.length, 3);
  for (const b of exam.blocks) {
    assert.ok(b.parts.length >= 3 && b.parts.length <= 6, `${b.title} : ${b.parts.length} sous-questions`);
    assert.ok(b.parts.some((p) => p.kind === "scq") && b.parts.some((p) => p.kind === "short"), b.parts.map((p) => p.kind).join(","));
    assert.equal(b.points, b.parts.reduce((s, p) => s + p.points, 0));
  }
  assert.ok(!exam.blocks.some((b) => /NARROW/.test(b.scenario)), "le bloc à la définition trop étroite est remplacé");
  assert.ok(steps.some((s) => /rejet[ée][^\n]*définition/i.test(s)), steps.join("\n"));
  for (const b of exam.blocks) for (const p of b.parts.filter((x) => x.kind === "code_output")) assert.equal(p.answer, "[1, 2]", "la sortie attendue est celle du code");
  // Fidélité : règles du cours et extraits dans chaque demande de bloc.
  assert.ok(prompts.every((p) => /NOTIONS DU COURS SEULEMENT/.test(p) && /EXTRAITS DU COURS/.test(p)));
  assert.ok(prompts.some((p) => /3 à 6 sous-questions/.test(p)));
  // Le juge ne voit jamais la clé.
  assert.ok(judged.every((j) => !/Names the reinforcing loop/.test(j) && !/"correct"/.test(j)));
});

test("C — vue en ligne sans les réponses ; PDF énoncé + corrigé", async (t) => {
  const { runWithCourse } = await import("../db/client");
  const { getBlockExam } = await import("../lib/blocks");
  const view = (await runWithCourse(examCourse, () => getBlockExam(examId, false)))!;
  const json = JSON.stringify(view);
  assert.ok(!/Names the reinforcing loop|Right: a reinforcing|"answer"|"criteria"|"correct"/.test(json.replace(/"options":\[[^\]]*\]/g, "")), json.slice(0, 400));
  assert.ok(view.blocks[0].parts[0].options.length === 4);
  if (!texAvailable()) return t.skip("tectonic/pdflatex absent");
  assert.match(view.pdf ?? "", /\.pdf$/);
  const { examsDir } = await import("../lib/paths");
  const dir = await runWithCourse(examCourse, () => examsDir());
  const base = (view.pdf ?? "").replace(/\.pdf$/, "");
  assert.ok(fs.existsSync(path.join(dir, `${base}-corrige.pdf`)), "corrigé compilé");
  const statement = fs.readFileSync(path.join(dir, `${base}.tex`), "utf8");
  const key = fs.readFileSync(path.join(dir, `${base}-corrige.tex`), "utf8");
  assert.match(statement, /\(a\)[\s\S]*\(b\)[\s\S]*\(c\)/);
  assert.ok(!/Names the reinforcing loop/.test(statement), "l'énoncé ne contient pas le barème");
  assert.match(key, /Names the reinforcing loop/);
  assert.match(key, /\[1,\\ 2\]/, "la sortie exacte, espaces protégés dans le cadre de code");
});

test("C — correction : choix unique et sortie de code automatiques, réponse courte en attente avec son barème", async () => {
  const { NextRequest } = await import("next/server");
  const { POST } = await import("../app/api/qcm/[id]/grade/route");
  const { runWithCourse } = await import("../db/client");
  const { getBlockExam } = await import("../lib/blocks");
  const exam = (await runWithCourse(examCourse, () => getBlockExam(examId, true)))!;
  const parts = exam.blocks.flatMap((b) => b.parts);
  const s = parts.find((p) => p.kind === "scq")!;
  const c = parts.find((p) => p.kind === "code_output")!;
  const sh = parts.find((p) => p.kind === "short")!;
  const answers = { [s.id]: s.correct, [c.id]: "[1, 2]\n", [sh.id]: "a loop" };
  const res = await POST(new NextRequest(`http://cortex.test/api/qcm/${examId}/grade?course=${examCourse}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blockAnswers: answers }) }), { params: Promise.resolve({ id: String(examId) }) });
  const d = await res.json() as { kind: string; score: number; detail: { partId: number; ok: boolean | null; points: number; answer: string; criteria: { label: string }[] }[] };
  assert.equal(d.kind, "blocks");
  const of = (id: number) => d.detail.find((x) => x.partId === id)!;
  assert.deepEqual([of(s.id).ok, of(s.id).points], [true, s.points]);
  assert.deepEqual([of(c.id).ok, of(c.id).points], [true, c.points], "espaces de fin ignorés");
  assert.equal(of(sh.id).ok, null, "réponse courte : corrigée par critères, pas automatiquement");
  assert.deepEqual(of(sh.id).criteria.map((x) => x.label), ["Names the reinforcing loop", "Explains the amplification"]);
  assert.equal(d.score, s.points + c.points);
});

test("C — réponse courte : correction critère par critère sur le barème fixé à la génération", async () => {
  const { NextRequest } = await import("next/server");
  const { POST } = await import("../app/api/check-solution/route");
  const { runWithCourse } = await import("../db/client");
  const { getBlockExam } = await import("../lib/blocks");
  const exam = (await runWithCourse(examCourse, () => getBlockExam(examId, true)))!;
  const sh = exam.blocks.flatMap((b) => b.parts).find((p) => p.kind === "short")!;
  prompts.length = 0;
  const res = await POST(new NextRequest(`http://cortex.test/api/check-solution?course=${examCourse}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ examId, partId: sh.id, answer: "It is a reinforcing loop." }) }));
  const d = await res.json() as { result: { criteria: { label: string; points: number; achieved: boolean }[]; score: { earned: number; total: number }; verdict: string } };
  assert.match(prompts[0] ?? "", /BARÈME IMPOSÉ[\s\S]*Names the reinforcing loop \(1 pt\)[\s\S]*Explains the amplification \(1 pt\)/);
  assert.match(prompts[0] ?? "", /A video platform ranks posts/, "le scénario fait partie de l'énoncé");
  assert.deepEqual(d.result.criteria.map((x) => [x.label, x.points, x.achieved]), [["Names the reinforcing loop", 1, true], ["Explains the amplification", 1, false]]);
  assert.deepEqual(d.result.score, { earned: 1, total: 2 });
  assert.equal(d.result.verdict, "partial");
});

test("C — un bloc toujours rejeté : l'examen sort avec les autres, le manque est compté", async () => {
  const id = await compositeCourse(3);
  script = {
    "Ethical theories": [block("A", [scq("A"), short("A"), code("[1, 2]")])],
    "Keyword filtering": [block("B", [scq("B"), short("B"), code("[1, 2]")], "NARROW: always.")],
    "Feedback loops": [block("C", [scq("C"), short("C"), code("[1, 2]")])],
  };
  const { runWithCourse } = await import("../db/client");
  const { generateMockExam } = await import("../lib/mock-exam");
  const steps: string[] = [];
  const r = await runWithCourse(id, () => generateMockExam({ onStep: (s) => { steps.push(s); } }));
  assert.deepEqual([r.produced, r.requested], [2, 3], steps.join("\n"));
  assert.ok(steps.some((s) => /2\/3 questions composées/.test(s)), steps.join("\n"));
});

test("C — une sous-question se signale comme une question : contre-exemple des prochaines générations", async () => {
  const { runWithCourse } = await import("../db/client");
  const { getBlockExam } = await import("../lib/blocks");
  const { reportQuestion, counterExamplesBlock } = await import("../lib/question-reports");
  await runWithCourse(examCourse, async () => {
    const exam = (await getBlockExam(examId, true))!;
    const sh = exam.blocks[0].parts.find((p) => p.kind === "short")!;
    const r = await reportQuestion({ examId, kind: "part", itemId: sh.id, reason: "ambiguous", comment: "Deux réponses possibles." });
    assert.equal(r.status, "open");
    assert.match(await counterExamplesBlock(), /Énoncé ambigu[\s\S]*Explain in two sentences[\s\S]*Deux réponses possibles/);
  });
});

test("C — PDF : un extrait de code garde son indentation, et une ligne qui commence par « [ » compile", async (t) => {
  if (!texAvailable()) return t.skip("tectonic/pdflatex absent");
  try { execFileSync("which", ["pdftotext"], { stdio: "ignore" }); } catch { return t.skip("pdftotext absent"); }
  const { runWithCourse } = await import("../db/client");
  const { buildBlocksArtifact } = await import("../lib/blocks-latex");
  const { examsDir } = await import("../lib/paths");
  const part = { ...code("[1, 2]"), code: "[x for x in [0]]\ndef f(xs):\n    for x in xs:\n        print(x)\nf([1, 2])" };
  const r = await runWithCourse(examCourse, () => buildBlocksArtifact(4242, [{ ...block("T", [scq("T"), short("T"), part]), section: null, points: 5, verified: 1 }] as never, "2026-11-02"));
  assert.match(r.file, /\.pdf$/, r.texError ?? "");
  const dir = await runWithCourse(examCourse, () => examsDir());
  const txt = execFileSync("pdftotext", ["-layout", path.join(dir, r.file), "-"], { encoding: "utf8" });
  const indent = (re: RegExp) => /^(\s*)/.exec(txt.split("\n").find((l) => re.test(l)) ?? "")![1].length;
  assert.ok(indent(/for x in xs:/) > indent(/def f\(xs\):/), txt.slice(0, 600));
  assert.ok(indent(/print\(x\)/) > indent(/for x in xs:/));
});

test("C — un juge qui ne rend aucun verdict ne vaut pas vérification", async () => {
  const id = await compositeCourse(3);
  script = {
    "Ethical theories": [block("A", [scq("A"), short("A"), code("[1, 2]")])],
    "Keyword filtering": [block("B", [scq("B"), short("B"), code("[1, 2]")], "SILENT judge on this one.")],
    "Feedback loops": [block("C", [scq("C"), short("C"), code("[1, 2]")])],
  };
  const { runWithCourse } = await import("../db/client");
  const { generateMockExam } = await import("../lib/mock-exam");
  const { getBlockExam } = await import("../lib/blocks");
  const r = await runWithCourse(id, () => generateMockExam({}));
  assert.deepEqual([r.produced, r.requested], [3, 3]);
  const exam = (await runWithCourse(id, () => getBlockExam(r.id, false)))!;
  assert.match(exam.verifySummary ?? "", /^2\/3 /, exam.verifySummary ?? "");
});

test("C — garantie du nombre : une réponse restée illisible n'arrête pas l'emplacement, une section ratée est reprise sur une de ses notions", async () => {
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const { generateMockExam } = await import("../lib/mock-exam");
  const { getBlockExam } = await import("../lib/blocks");
  // Annale modèle à deux sections : la 2ᵉ section, prise telle quelle, est toujours rejetée.
  const id = await compositeCourse(2);
  await runWithCourse(id, async () => {
    for (const t of ["sources", "items", "format_profile"]) await q.ensureTable(t);
    const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "final", "Midterm model", "final/model", 2026, 1);
    await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "exercise", "Midterm model", "Question 1 and Question 2, each with sub-questions.");
    await q.run(`INSERT INTO format_profile (json) VALUES (?)`, JSON.stringify({
      format_summary: "2 questions, each a scenario followed by 3 to 5 sub-questions.", duration_min: 60, total_points: 20, has_mcq: true, scq_vs_mcq_convention: "",
      question_types: [{ type: "scq", approx_count: 4, share_pct: 40 }, { type: "open", approx_count: 4, share_pct: 60 }],
      sections: [{ name: "Q1 — Ethics", description: "ethical theories and stakeholders" }, { name: "Q2 — Moderation", description: "keyword filtering of posts" }],
      topics_emphasis: [],
    }));
  });
  const twoParts = block("bad", [scq("bad"), short("bad")]);
  script = {
    "centrée sur": [block("spare", [scq("S"), short("S"), code("[1, 2]")])],
    // Trois réponses mal formées d'affilée (completeJson abandonne), puis une bonne.
    "Q1 — Ethics": [twoParts, twoParts, twoParts, block("Q1", [scq("Q1"), short("Q1"), code("[1, 2]")])],
    "Q2 — Moderation": [block("Q2", [scq("Q2"), short("Q2"), code("[1, 2]")], "NARROW: always.")],
  };
  const steps: string[] = [];
  const r = await runWithCourse(id, () => generateMockExam({ onStep: (s) => { steps.push(s); } }));
  assert.deepEqual([r.produced, r.requested], [2, 2], steps.join("\n"));
  const exam = (await runWithCourse(id, () => getBlockExam(r.id, false)))!;
  assert.deepEqual(exam.blocks.map((b) => b.section), ["Q1 — Ethics", "Q2 — Moderation"], "la reprise garde sa section");
});

test("C × temps restant — l'avancement des questions composées ne recule qu'à l'ajout d'une version ou d'une reprise", async () => {
  const id = await compositeCourse(3);
  script = {
    "Ethical theories": [block("A", [scq("A"), short("A"), code("[1, 2]")])],
    "Keyword filtering": [block("B", [scq("B"), short("B"), code("[1, 2]")], "NARROW: a feedback loop is always positive."), block("B", [scq("B"), short("B"), code("[1, 2]")])],
    "Feedback loops": [block("C", [scq("C"), short("C"), code("[1, 2]")])],
  };
  const { runWithCourse } = await import("../db/client");
  const { generateMockExam } = await import("../lib/mock-exam");
  const seq: { s: string; p: number }[] = [];
  await runWithCourse(id, () => generateMockExam({ onStep: (s, p) => { seq.push({ s, p }); } }));
  const back = seq.filter((x, i) => i > 0 && x.p < seq[i - 1].p).map((x) => `${x.p} % — ${x.s}`);
  assert.ok(back.every((x) => /rejetée|inutilisable|reprise/.test(x)), `recul hors réessai :\n${back.join("\n")}\n---\n${seq.map((x) => `${x.p} ${x.s}`).join("\n")}`);
  assert.ok(seq.filter((x) => x.p >= 100).length === 1 && seq.at(-1)!.p === 100, "100 % une seule fois, à la fin");
});

test("C — un verdict du juge mal typé (options en chaîne) rejette le bloc sans faire planter l'examen", async () => {
  const id = await compositeCourse(3);
  script = {
    "Ethical theories": [block("A", [scq("A"), short("A"), code("[1, 2]")])],
    "Keyword filtering": [block("B", [scq("B"), short("B"), code("[1, 2]")], "STRINGOPTS: a filter."), block("B2", [scq("B2"), short("B2"), code("[1, 2]")])],
    "Feedback loops": [block("C", [scq("C"), short("C"), code("[1, 2]")])],
  };
  const { runWithCourse } = await import("../db/client");
  const { generateMockExam } = await import("../lib/mock-exam");
  const steps: string[] = [];
  const r = await runWithCourse(id, () => generateMockExam({ onStep: (s) => { steps.push(s); } }));
  assert.deepEqual([r.produced, r.requested], [3, 3], steps.join("\n"));
  assert.ok(steps.some((s) => /distracteurs éliminables sans le cours : A, B/.test(s)), steps.join("\n"));
});

test("C × forme de l'annale — lectures de code Java et réponses courtes : ni choix unique imposé, ni Python (audit 3, P1-12)", async () => {
  const id = await compositeCourse(1);
  const java = (tag: string): Part => ({ ...code("[1, 2]"), code: `int[] likes = {2, 1};\nArrays.sort(likes);\nSystem.out.println(Arrays.toString(likes)); // ${tag}` });
  script = { "Ethical theories": [block("J", [short("J"), java("J"), short("J2")])], "Keyword filtering": [block("K", [short("K"), java("K"), short("K2")])], "Feedback loops": [block("L", [short("L"), java("L"), short("L2")])] };
  const { runWithCourse } = await import("../db/client");
  const { generateBlockExam, getBlockExam } = await import("../lib/blocks");
  const steps: string[] = [];
  prompts.length = 0;
  const plan = { blockCount: 1, partsMin: 3, partsMax: 3, sections: [], totalPoints: null, kinds: ["short", "code_output"] as ("short" | "code_output")[], codeLanguage: "java" };
  const r = await runWithCourse(id, () => generateBlockExam(plan, { onStep: (s) => { steps.push(s); } }));
  assert.equal(r.count, 1, steps.join("\n"));
  const p = prompts[0];
  assert.match(p, /extrait Java AUTONOME/);
  assert.doesNotMatch(p, /"scq" — choix unique|Python|pandas/);
  assert.match(p, /ceux de l'annale/);
  const exam = (await runWithCourse(id, () => getBlockExam(r.id, true)))!;
  assert.deepEqual(exam.blocks[0].parts.map((x) => x.kind), ["short", "code_output", "short"]);
  assert.equal(exam.blocks[0].parts[1].answer, "[1, 2]", "la sortie d'un extrait Java reste celle que le juge a vérifiée");
});

/** Plan d'une annale modèle à sections (lib/exam-format blocksOf) : « Question N — description ». */
const sectionPlan = (descriptions: string[]) => ({
  blockCount: descriptions.length, partsMin: 3, partsMax: 4, totalPoints: null,
  sections: descriptions.map((description, i) => ({ name: `Question ${i + 1}`, description })),
});

test("C × section de forme (prod 22/11 : « vrai/faux justifiés » perdue) : elle reçoit une notion du cours libre, et une reprise", async () => {
  const id = await compositeCourse(3);
  // La 2ᵉ section décrit une FORME, aucun mot commun avec les notions : sans notion, ni reprise, elle tombait.
  const plan = sectionPlan(["ethical theories and stakeholders", "True or false statements, each one justified", "feedback loops of a recommender"]);
  script = {
    // Section de vrai/faux : sa reprise est un vrai/faux (2 options).
    "centrée sur": [block("spare", [{ ...scq("S"), options: ["Right: True", "False"], correct: 0 }, short("S"), code("[1, 2]")])],
    // Clé fausse : le juge la conteste, avec ou sans extraits du cours.
    "True or false": [block("TF", [{ ...scq("TF"), correct: 1 }, short("TF"), code("[1, 2]")])],
    "ethical": [block("A", [scq("A"), short("A"), code("[1, 2]")])],
    "feedback": [block("C", [scq("C"), short("C"), code("[1, 2]")])],
  };
  const { runWithCourse } = await import("../db/client");
  const { generateBlockExam, getBlockExam } = await import("../lib/blocks");
  const steps: string[] = [];
  prompts.length = 0;
  const r = await runWithCourse(id, () => generateBlockExam(plan, { onStep: (s) => { steps.push(s); } }));
  assert.deepEqual([r.count, r.requested], [3, 3], steps.join("\n"));
  const tf = prompts.filter((p) => /^THÈME : Question 2/m.test(p));
  // La notion prêtée est celle qu'aucune autre section ne prend : « Keyword filtering ».
  assert.ok(tf.length && tf.every((p) => /Notions du cours à mobiliser[^\n]*Keyword filtering/.test(p)), tf.map((p) => /THÈME.*$/m.exec(p)?.[0]).join("\n"));
  const exam = (await runWithCourse(id, () => getBlockExam(r.id, false)))!;
  assert.deepEqual(exam.blocks.map((b) => b.section), ["Question 1", "Question 2", "Question 3"], "la reprise garde sa section");
});

test("C × manque dit clairement : une question tombée est annoncée sur l'examen, avec le total ajusté", async () => {
  const id = await compositeCourse(2);
  const plan = sectionPlan(["ethical theories and stakeholders", "keyword filtering of posts"]);
  script = {
    "Question 2": [block("B", [{ ...scq("B"), correct: 1 }, short("B"), code("[1, 2]")])],
    "ethical": [block("A", [scq("A"), short("A"), code("[1, 2]")])],
  };
  const { runWithCourse } = await import("../db/client");
  const { generateBlockExam, getBlockExam } = await import("../lib/blocks");
  const r = await runWithCourse(id, () => generateBlockExam(plan, {}));
  assert.deepEqual([r.count, r.requested], [1, 2]);
  const exam = (await runWithCourse(id, () => getBlockExam(r.id, false)))!;
  assert.equal(exam.requested, 2, "le nombre demandé reste lisible sur l'examen");
  assert.deepEqual(exam.missing, ["Question 2"], "la question tombée est nommée");
  assert.equal(exam.blocks.length, 1);
  assert.match(exam.verifySummary ?? "", /^1 question composée sur 2 demandées/);
});

test("C × numérotation : le nom d'une section qui n'est qu'un numéro de l'annale ne double pas celui de l'examen", async () => {
  const { sectionLabel } = await import("../lib/section-label");
  assert.equal(sectionLabel("Question 4"), null);
  assert.equal(sectionLabel("Q4"), null);
  assert.equal(sectionLabel("Exercice 3 :"), null);
  assert.equal(sectionLabel("Problem IV"), null);
  assert.equal(sectionLabel("Question 4 — Fermentation"), "Fermentation");
  assert.equal(sectionLabel("Q2: Moderation"), "Moderation");
  assert.equal(sectionLabel("Aufgabe 2. Gärung"), "Gärung");
  assert.equal(sectionLabel("Blending of wines"), "Blending of wines");
  assert.equal(sectionLabel("Questions about yeast"), "Questions about yeast");
  assert.equal(sectionLabel(null), null);
});

test("C × non-recouvrement (prod 22/11) : chaque question connaît les sujets des autres, une sous-question qui en reprend une est retirée", async () => {
  const id = await compositeCourse(3);
  const titled = (title: string, parts: Part[]) => ({ ...block(title, parts), title });
  script = {
    "Ethical theories": [titled("Ethical theories of platforms", [scq("A"), short("A"), code("[1, 2]")])],
    // (d) refait la question sur les théories éthiques : retirée, (a)-(c) suffisent (3 sous-questions au moins).
    "Keyword filtering": [titled("Keyword filtering of posts", [scq("B"), short("B"), code("[1, 2]"), { ...short("B2"), prompt: "Which ethical theories justify the platform's choice?" }])],
    "Feedback loops": [titled("Feedback loops in feeds", [scq("C"), short("C"), code("[1, 2]")])],
  };
  const { runWithCourse } = await import("../db/client");
  const { generateMockExam } = await import("../lib/mock-exam");
  const { getBlockExam } = await import("../lib/blocks");
  const steps: string[] = [];
  prompts.length = 0;
  const r = await runWithCourse(id, () => generateMockExam({ onStep: (s) => { steps.push(s); } }));
  assert.deepEqual([r.produced, r.requested], [3, 3], steps.join("\n"));
  const exam = (await runWithCourse(id, () => getBlockExam(r.id, true)))!;
  const filtering = exam.blocks.find((b) => /Keyword/.test(b.title))!;
  assert.equal(filtering.parts.length, 3, filtering.parts.map((p) => p.prompt).join(" | "));
  assert.ok(!filtering.parts.some((p) => /ethical theories/i.test(p.prompt)));
  assert.equal(filtering.points, filtering.parts.reduce((s, p) => s + p.points, 0), "les points suivent");
  assert.ok(steps.some((s) => /sous-question \(d\) retirée[^\n]*question/.test(s)), steps.join("\n"));
  // Prévention, sans appel de plus : chaque demande nomme les sujets des AUTRES questions.
  const asks = prompts.filter((p) => /^QUESTION \d\/3/m.test(p));
  assert.ok(asks.length >= 3 && asks.every((p) => /AUTRES QUESTIONS DE CET EXAMEN/.test(p)), "prévention absente");
  const first = asks.find((p) => /THÈME : Ethical theories/.test(p))!;
  const others = first.slice(first.indexOf("AUTRES QUESTIONS")).split("\n\n")[0];
  assert.match(others, /Keyword filtering/);
  assert.doesNotMatch(others, /Ethical theories/, "pas sa propre question");
});

test("C × non-recouvrement : deux questions entières sur le même sujet → la plus tardive est refaite une fois", async () => {
  const id = await compositeCourse(3);
  const titled = (title: string, tag: string) => ({ ...block(tag, [scq(tag), short(tag), code("[1, 2]")]), title });
  script = {
    "Ethical theories": [titled("Moral luck dilemmas", "A"), titled("Ethical theories of platforms", "A2")],
    "Keyword filtering": [titled("Keyword filtering of posts", "B")],
    "Feedback loops": [titled("Moral luck dilemmas", "C"), titled("Ranking fairness audits", "C2")],
  };
  const { runWithCourse } = await import("../db/client");
  const { generateMockExam } = await import("../lib/mock-exam");
  const { getBlockExam } = await import("../lib/blocks");
  const steps: string[] = [];
  const r = await runWithCourse(id, () => generateMockExam({ onStep: (s) => { steps.push(s); } }));
  assert.deepEqual([r.produced, r.requested], [3, 3], steps.join("\n"));
  const titles = (await runWithCourse(id, () => getBlockExam(r.id, false)))!.blocks.map((b) => b.title);
  assert.equal(titles.filter((t) => /Moral luck/.test(t)).length, 1, titles.join(" | "));
  assert.ok(steps.some((s) => /refaite : elle reprenait la question/.test(s)), steps.join("\n"));
});

test("C × options (prod 22/11) : 2 options relevées sur un vrai/faux de l'annale → vrai/faux dans sa section seulement, 4 options ailleurs", async () => {
  const id = await compositeCourse(2);
  const plan = { ...sectionPlan(["ethical theories and stakeholders", "True/false statements, each one justified"]), options: 2 };
  const tf: Part = { ...scq("TF"), prompt: "True or false: a filter never blocks legitimate posts.", options: ["False", "Right: True"], correct: 1 };
  script = {
    "True/false": [block("TF", [tf, short("TF"), code("[1, 2]")])],
    "ethical": [block("A", [scq("A"), short("A"), code("[1, 2]")])],
  };
  const { runWithCourse } = await import("../db/client");
  const { generateBlockExam, getBlockExam } = await import("../lib/blocks");
  const steps: string[] = [];
  prompts.length = 0;
  const r = await runWithCourse(id, () => generateBlockExam(plan, { onStep: (s) => { steps.push(s); } }));
  assert.deepEqual([r.count, r.requested], [2, 2], steps.join("\n"));
  const exam = (await runWithCourse(id, () => getBlockExam(r.id, true)))!;
  const counts = exam.blocks.map((b) => b.parts.filter((p) => p.kind === "scq").map((p) => p.options.length));
  assert.deepEqual(counts, [[4], [2]]);
  const ask = (n: number) => prompts.find((p) => new RegExp(`^THÈME : Question ${n}`, "m").test(p))!;
  assert.match(ask(1), /exactement 4 options/);
  assert.match(ask(2), /VRAI\/FAUX/);
});

test("revue : 2 options relevées mais aucune section de vrai/faux → 4 options partout, aucun vrai/faux imposé", async () => {
  const id = await compositeCourse(2);
  const plan = { ...sectionPlan(["ethical theories and stakeholders", "short answers on content moderation"]), options: 2 };
  script = {
    "content moderation": [block("M", [scq("M"), short("M"), code("[1, 2]")])],
    "ethical": [block("A", [scq("A"), short("A"), code("[1, 2]")])],
  };
  const { runWithCourse } = await import("../db/client");
  const { generateBlockExam, getBlockExam } = await import("../lib/blocks");
  prompts.length = 0;
  const r = await runWithCourse(id, () => generateBlockExam(plan));
  const exam = (await runWithCourse(id, () => getBlockExam(r.id, true)))!;
  assert.deepEqual(exam.blocks.map((b) => b.parts.filter((p) => p.kind === "scq").map((p) => p.options.length)), [[4], [4]]);
  assert.ok(!prompts.some((p) => /VRAI\/FAUX/.test(p)), "vrai/faux imposé sans section qui en décrive un");
});

test("revue : vrai/faux d'une annale sans réponse courte → pas de justification « short » exigée", async () => {
  const id = await compositeCourse(2);
  const plan = { ...sectionPlan(["ethical theories and stakeholders", "True/false statements"]), options: 2, kinds: ["scq", "code_output"] as ("scq" | "code_output")[] };
  const tf: Part = { ...scq("TF"), prompt: "True or false: a filter never blocks legitimate posts.", options: ["False", "Right: True"], correct: 1 };
  script = {
    "True/false": [block("TF", [tf, { ...tf, prompt: "True or false: logs are anonymous." }, code("[1, 2]")])],
    "ethical": [block("A", [scq("A"), { ...scq("A2"), prompt: "Which stakeholder bears the risk?" }, code("[1, 2]")])],
  };
  const { runWithCourse } = await import("../db/client");
  const { generateBlockExam } = await import("../lib/blocks");
  prompts.length = 0;
  const steps: string[] = [];
  const r = await runWithCourse(id, () => generateBlockExam(plan, { onStep: (s) => { steps.push(s); } }));
  assert.deepEqual([r.count, r.requested], [2, 2], steps.join("\n"));
  const tfAsk = prompts.find((p) => /^THÈME : Question 2/m.test(p))!;
  const line = tfAsk.split("\n").find((l) => l.startsWith("VRAI/FAUX"))!;
  assert.ok(line, "consigne vrai/faux absente");
  assert.doesNotMatch(line, /short/);
});

test("revue : retirer une sous-question décalerait un renvoi « (c) » → la question est refaite, pas amputée", async () => {
  const id = await compositeCourse(3);
  const titled = (title: string, parts: Part[]) => ({ ...block(title, parts), title });
  script = {
    "Ethical theories": [titled("Ethical theories of platforms", [scq("A"), short("A"), code("[1, 2]")])],
    // (b) reprend la question 1 ; (d) renvoie à (c), qui deviendrait (b) après le retrait.
    "Keyword filtering": [
      titled("Keyword filtering of posts", [scq("B"), { ...short("B2"), prompt: "Which ethical theories justify the platform's choice?" }, short("B"), { ...short("B3"), prompt: "Using your answer to (c), estimate the false positive rate." }]),
      titled("Keyword filtering of posts", [scq("B4"), short("B4"), code("[1, 2]")]),
    ],
    "Feedback loops": [titled("Feedback loops in feeds", [scq("C"), short("C"), code("[1, 2]")])],
  };
  const { runWithCourse } = await import("../db/client");
  const { generateMockExam } = await import("../lib/mock-exam");
  const { getBlockExam } = await import("../lib/blocks");
  const steps: string[] = [];
  const r = await runWithCourse(id, () => generateMockExam({ onStep: (s) => { steps.push(s); } }));
  assert.deepEqual([r.produced, r.requested], [3, 3], steps.join("\n"));
  const filtering = (await runWithCourse(id, () => getBlockExam(r.id, true)))!.blocks.find((b) => /Keyword/.test(b.title))!;
  assert.ok(!filtering.parts.some((p) => /answer to \(c\)|ethical theories/i.test(p.prompt)), filtering.parts.map((p) => p.prompt).join(" | "));
  assert.ok(steps.some((s) => /refaite : elle reprenait la question/.test(s)), steps.join("\n"));
});

test("C × total du format (22/11 : 6 questions sur 7, 42 pts au lieu de 50) : une question tombée, ses points vont aux autres, barème des sous-questions inclus", async () => {
  const id = await compositeCourse(2);
  const plan = { ...sectionPlan(["ethical theories and stakeholders", "keyword filtering of posts"]), totalPoints: 10 };
  script = {
    // Clé fausse à chaque version : la question 2 tombe.
    "Question 2": [block("B", [{ ...scq("B"), correct: 1 }, short("B"), code("[1, 2]")])],
    // 1 + 2 (critères 1 + 1) + 2 = 5 points sur les 10 du format.
    "ethical": [block("A", [scq("A"), short("A"), code("[1, 2]")])],
  };
  const { runWithCourse } = await import("../db/client");
  const { generateBlockExam, getBlockExam } = await import("../lib/blocks");
  const r = await runWithCourse(id, () => generateBlockExam(plan, {}));
  assert.deepEqual([r.count, r.requested], [1, 2]);
  const exam = (await runWithCourse(id, () => getBlockExam(r.id, true)))!;
  const [b] = exam.blocks;
  assert.equal(b.points, 10, "le total livré est celui du format");
  assert.deepEqual(b.parts.map((p) => p.points), [2, 4, 4], "proportionnel : 1-2-2 devient 2-4-4");
  const sq = b.parts.find((p) => p.kind === "short")!;
  assert.deepEqual(sq.criteria!.map((c) => c.points), [2, 2], "les critères de la réponse courte suivent son barème");
});

test("C × total du format : examen complet dont la somme s'écarte du format → somme exacte, points entiers, aucun à zéro", async () => {
  const id = await compositeCourse(2);
  const plan = { ...sectionPlan(["ethical theories and stakeholders", "keyword filtering of posts"]), totalPoints: 12 };
  script = {
    "ethical": [block("A", [scq("A"), short("A"), code("[1, 2]")])],
    "keyword": [block("B", [scq("B"), short("B"), code("[1, 2]")])],
  };
  const { runWithCourse } = await import("../db/client");
  const { generateBlockExam, getBlockExam } = await import("../lib/blocks");
  const r = await runWithCourse(id, () => generateBlockExam(plan, {}));
  assert.deepEqual([r.count, r.requested], [2, 2]);
  const exam = (await runWithCourse(id, () => getBlockExam(r.id, true)))!;
  assert.equal(exam.blocks.reduce((s, x) => s + x.points, 0), 12);
  for (const x of exam.blocks) {
    assert.equal(x.parts.reduce((s, p) => s + p.points, 0), x.points, "points de la question = somme de ses sous-questions");
    for (const p of x.parts) {
      assert.ok(Number.isInteger(p.points) && p.points >= 1, `sous-question à ${p.points} pt`);
      if (p.kind === "short") assert.equal(p.criteria!.reduce((s, c) => s + c.points, 0), p.points);
    }
  }
  const { gradeBlocks } = await import("../lib/blocks");
  const g = (await runWithCourse(id, () => gradeBlocks(r.id, {})))!;
  assert.equal(g.total + g.pending, 12, "la correction compte sur le même total (corrigé automatiquement + en attente)");
});

test("C × extraits (banc rs-composite 22/11, Q4/Q5/Q7 « hors cours ») : chaque notion de la section est cherchée dans le cours, même loin dans un support déjà cité", async () => {
  const id = await compositeCourse(1);
  // Un support long : l'en-tête (notebook, code pandas) reprend le nom de la section, la théorie
  // demandée par sa description n'arrive qu'après 900 caractères.
  const notebook = Array.from({ length: 14 }, (_, i) => `Cell ${i}: df.sort_values("likes").head(${i + 2}) prints the ${i + 2} least liked memes of the Memeverse feed.`).join(" ");
  const theory = "Malinformation is genuine content shared out of context to cause harm, unlike disinformation (false and deliberate).";
  const title = "Safety 2 - content recommendation";
  const text = `${title}. Notebook Memeverse recommendation: ${notebook} Theory. ${theory}`;
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const { indexItemForSearch } = await import("../lib/search");
  await runWithCourse(id, async () => {
    const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "note", title, `note/${title}`, null, 1);
    const iid = await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "note", title, text);
    await indexItemForSearch(iid, sid, title, text);
  });
  const plan = {
    blockCount: 1, partsMin: 3, partsMax: 4, totalPoints: null,
    sections: [{ name: "Q4 — Safety 2: content recommendation", description: "Pandas code reading (sort_values, head), malinformation versus disinformation" }],
  };
  script = { "Safety 2": [block("Q4", [scq("Q4"), short("Q4"), code("[1, 2]")])] };
  const { generateBlockExam } = await import("../lib/blocks");
  prompts.length = 0;
  judged.length = 0;
  const r = await runWithCourse(id, () => generateBlockExam(plan, {}));
  assert.equal(r.count, 1);
  const asked = prompts.find((p) => /^THÈME : Q4/m.test(p))!;
  assert.match(asked, /Malinformation is genuine content/, "le générateur voit la définition demandée par la section");
  assert.ok(judged.some((p) => /Malinformation is genuine content/.test(p)), "le juge voit la même définition (sinon : « hors cours »)");
});

test("C × distracteurs éliminables (banc rs-composite 22/11, 68 choix uniques sur 124) : la relance cite le texte de l'option, et la consigne dit comment construire un distracteur", async () => {
  const id = await compositeCourse(3);
  script = {
    "Ethical theories": [block("A", [scq("A"), short("A"), code("[1, 2]")], "TRIVIAL: a moderation team."), block("A2", [scq("A2"), short("A2"), code("[1, 2]")])],
    "Keyword filtering": [block("B", [scq("B"), short("B"), code("[1, 2]")])],
    "Feedback loops": [block("C", [scq("C"), short("C"), code("[1, 2]")])],
  };
  const { runWithCourse } = await import("../db/client");
  const { generateMockExam } = await import("../lib/mock-exam");
  prompts.length = 0;
  judged.length = 0;
  const r = await runWithCourse(id, () => generateMockExam({ onStep: () => {} }));
  assert.deepEqual([r.produced, r.requested], [3, 3]);
  // Le juge a lu « B. <texte> » ; le générateur n'a jamais vu cet ordre (options mélangées après lui).
  const shown = /TRIVIAL[\s\S]*?^ {2}B\. (.+)$/m.exec(judged.find((j) => /TRIVIAL/.test(j))!)![1];
  const retry = prompts.find((p) => /VERSION PRÉCÉDENTE REJETÉE/.test(p) && /^THÈME : .*Ethical theories/m.test(p))!;
  assert.ok(retry.includes(shown), `la relance nomme l'option par son texte : ${/VERSION PRÉCÉDENTE REJETÉE.*$/m.exec(retry)?.[0]}`);
  // Consigne de génération des options : les défauts relevés par le juge sur le corpus réel.
  const system = prompts[0];
  for (const rule of [/autre chapitre/, /contredit jamais un fait/, /critère/, /absolu/]) assert.match(system, rule);
});
