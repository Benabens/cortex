/**
 * CONTRÔLE « HORS COURS » DU CORRECTEUR (lib/qcm verifyQcmBatch) — banc HUM-285 du 02/11/2026 :
 * 22 à 27 questions justes rejetées par examen, parce que le correcteur ne voyait que deux
 * extraits de 700 caractères par sujet (« Svenson (1981) n'apparaît dans aucun extrait », « le
 * texte s'arrête à “Thaler et Sunstei” »). Examens plus lents, parfois incomplets.
 * Verrouillé, avec un faux modèle :
 *  - le correcteur voit les passages du cours où se trouve le fait que la question teste ;
 *  - une question jugée hors cours n'est rejetée qu'après une recherche dans TOUT le cours ;
 *  - un vrai hors-cours reste rejeté, y compris quand ce second regard échoue.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-qcm-preuve-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";

/** Le fait de l'étude de Svenson, loin des mots du sujet dans un long support (comme au banc). */
const SVENSON = "Svenson (1981) : 93 % des conducteurs américains s'estiment plus habiles que la moyenne, signe de supériorité illusoire.";
const LONG_SUPPORT = [
  "Biais cognitifs et prise de décision. Les biais cognitifs sont des raccourcis de jugement qui faussent nos décisions.",
  ...Array.from({ length: 40 }, (_, i) => `Paragraphe ${i + 1} : l'intuition décide vite, la raison vérifie lentement, et la méthode explicite aide à repérer ce que l'intuition laisse passer.`),
  SVENSON,
  "Conclusion : connaître ces effets ne suffit pas à les éviter.",
].join(" ");

type Raw = { topic: string; type: string; stem: string; options: string[]; correct: number[]; misconceptions: string[]; explanation: string; source_fact?: string };

function svensonItem(n: number, distractor = "Les conducteurs américains s'estiment en majorité moins habiles que la moyenne."): Raw {
  const options = [
    "Une large majorité des conducteurs américains s'estiment plus habiles que la moyenne.",
    distractor,
    "Les conducteurs américains s'estiment en moyenne exactement aussi habiles que les autres.",
    "Seuls les conducteurs novices s'estiment plus habiles que la moyenne.",
  ];
  return {
    topic: "Biais cognitifs",
    type: "scq",
    stem: `Selon l'étude de Svenson (1981), que pensent les conducteurs de leur habileté ? (s${n})`,
    options,
    correct: [0],
    misconceptions: ["", "[inversion] résultat inversé", "[sur-généralisation] aucune différence", "[mauvaise condition] restreint aux novices"],
    explanation: "Svenson (1981) : 93 % des conducteurs américains s'estiment plus habiles que la moyenne, ce qui est impossible pour une majorité.",
    source_fact: SVENSON,
  };
}

let design: (n: number, call: number) => Raw[] = (n, call) => Array.from({ length: n }, (_, i) => svensonItem(call * 10 + i));
let designCalls = 0;
const verifyPrompts: string[] = [];
const secondLookPrompts: string[] = [];
/** Ce que le correcteur signale hors cours pour une question, d'après le prompt qu'il reçoit. */
let flag: (block: string, prompt: string) => { off: string; terms: string[] } | null = (block, prompt) => (
  /Svenson/.test(block) && !prompt.includes("93 % des conducteurs") ? { off: "L'étude de Svenson (1981) n'apparaît dans aucun extrait du cours.", terms: ["Svenson (1981)"] } : null
);
/** Définition jugée différente de celle du cours (PR #55), d'après le bloc de la question. */
let mismatch: (block: string) => string = () => "";
/** Notions dont dépend la clé, telles que le correcteur les recopie (parfois paraphrasées). */
let courseTerms: (block: string) => string[] = () => [];
/** Ce que répond le second regard (recherche dans tout le cours) ; null = réponse illisible. */
let secondLook: (prompt: string) => { index: number; off_course: string }[] | null = (prompt) => {
  const blocks = prompt.split(/^(?=Q\d+\.)/m).filter((b) => /^Q\d+\./.test(b));
  return blocks.map((b) => ({ index: Number(/^Q(\d+)\./.exec(b)![1]), off_course: /négativité/.test(b) && !/biais de négativité/.test(prompt.split("═══ QUESTIONS")[0]) ? "Le biais de négativité n'est présenté nulle part dans le cours." : "" }));
};

function verifyReply(prompt: string): string {
  const blocks = prompt.split(/^(?=Q\d+\.)/m).filter((b) => /^Q\d+\./.test(b));
  const results = blocks.map((b) => {
    const index = Number(/^Q(\d+)\./.exec(b)![1]);
    const opt = [...b.matchAll(/^\s+\((\d+)\) (.*)$/gm)].find((m) => /^Une large majorité/.test(m[2]));
    const f = flag(b, prompt);
    return { index, correct: [opt ? Number(opt[1]) : 0], ok: true, discrimination: 4, name_only: false, issue: "", course_terms: courseTerms(b), off_course: f?.off ?? "", off_course_terms: f?.terms ?? [], off_matter: "", trivial_distractors: [], definition_mismatch: mismatch(b) };
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
      const content = parsed.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
      let text = "{}";
      if (/"second_look"/.test(content)) {
        secondLookPrompts.push(content);
        const r = secondLook(content);
        text = r ? JSON.stringify({ second_look: r }) : "pas du JSON";
      } else if (/"results"/.test(content)) { verifyPrompts.push(content); text = verifyReply(content); }
      else if (/"items"/.test(content)) {
        designCalls++;
        text = JSON.stringify({ items: design(Number(/\((\d+) QCM\)/.exec(content)?.[1] ?? 1), designCalls) });
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

const defaults = { design, flag, secondLook, mismatch, courseTerms };
beforeEach(() => {
  designCalls = 0;
  verifyPrompts.length = 0;
  secondLookPrompts.length = 0;
  ({ design, flag, secondLook, mismatch, courseTerms } = defaults);
});

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL", "MAX_COURSES_CREATED_PER_HOUR"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

let courseN = 0;
async function course(): Promise<string> {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const { runWithCourse, ensureFts } = await import("../db/client");
  const { q } = await import("../db/q");
  const { indexItemForSearch } = await import("../lib/search");
  const row = buildCourseRow({ name: `Enjeux mondiaux preuve ${++courseN}`, code: "HUM-285", language: "fr", examFormat: { kind: "qcm" } }, "owner");
  await insertCourse(row);
  await reloadCourses();
  await runWithCourse(row.id, async () => {
    ensureFts();
    for (const t of ["sources", "items", "topics"]) await q.ensureTable(t);
    const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "course_pdf", "Prise de décision", "course_pdf/decision", null, 1);
    const iid = await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "course_pdf", "Prise de décision", LONG_SUPPORT);
    await indexItemForSearch(iid, sid, "Prise de décision", LONG_SUPPORT);
    for (const label of ["Biais cognitifs", "Intuition et raison"]) {
      await q.run(`INSERT INTO topics (label, method, exam_weight, exam_count) VALUES (?,?,?,?)`, label, null, 3, 1);
    }
  });
  return row.id;
}

async function exam(id: string, count: number) {
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  const steps: string[] = [];
  return runWithCourse(id, async () => {
    const r = await generateQcmExam({ count, openCount: 0, onStep: (s) => { steps.push(s); } });
    return { r, steps, view: (await getQcmExam(r.id, true))! };
  });
}

test("le correcteur voit le passage où se trouve le fait testé, même loin des mots du sujet : rien n'est rejeté", async () => {
  const id = await course();
  const { r, steps } = await exam(id, 2);
  assert.equal(r.count, 2);
  assert.match(verifyPrompts[0], /93 % des conducteurs/, "le fait de Svenson est dans les extraits du correcteur");
  assert.ok(!steps.some((s) => /hors cours/.test(s)), steps.filter((s) => /rejeté/.test(s)).join("\n"));
  assert.equal(designCalls, 1, "aucune régénération");
  assert.match(verifyPrompts[0], /affirmation fausse/, "un distracteur faux par construction n'est pas « hors cours »");
});

test("jugé hors cours sur des extraits partiels, mais présent dans le cours : gardé après une recherche dans tout le cours", async () => {
  const id = await course();
  flag = (block) => (/Svenson/.test(block) ? { off: "L'étude de Svenson (1981) n'apparaît dans aucun extrait.", terms: ["Svenson (1981)"] } : null);
  secondLook = (prompt) => {
    assert.match(prompt, /93 % des conducteurs/, "le second regard montre le passage trouvé dans le cours");
    const blocks = prompt.split(/^(?=Q\d+\.)/m).filter((b) => /^Q\d+\./.test(b));
    return blocks.map((b) => ({ index: Number(/^Q(\d+)\./.exec(b)![1]), off_course: "" }));
  };
  const { r, steps } = await exam(id, 2);
  assert.equal(r.count, 2);
  assert.equal(secondLookPrompts.length, 1, "un seul second regard pour le lot");
  assert.ok(!steps.some((s) => /QCM rejeté/.test(s)), steps.filter((s) => /rejeté/.test(s)).join("\n"));
  assert.equal(designCalls, 1);
});

test("vrai hors-cours (une notion que le cours ne présente pas) : confirmé par le second regard, rejeté et remplacé", async () => {
  const id = await course();
  design = (n, call) => Array.from({ length: n }, (_, i) => (call === 1 && i === 0 ? svensonItem(0, "Le biais de négativité pousse les conducteurs à sous-estimer leur habileté.") : svensonItem(call * 10 + i)));
  flag = (block) => (/négativité/.test(block) ? { off: "Le « biais de négativité » n'apparaît pas dans les extraits.", terms: ["biais de négativité"] } : null);
  const { r, steps, view } = await exam(id, 2);
  assert.equal(r.count, 2);
  assert.ok(view.items.every((it) => !it.options.some((o) => /négativité/.test(o))), "la question hors cours n'est pas gardée");
  assert.ok(steps.some((s) => /QCM rejeté — hors cours[^\n]*négativité/.test(s)), steps.join("\n"));
});

test("second regard impossible (réponse illisible) : le rejet du correcteur tient", async () => {
  const id = await course();
  design = (n, call) => Array.from({ length: n }, (_, i) => (call === 1 && i === 0 ? svensonItem(0, "Le biais de négativité pousse les conducteurs à sous-estimer leur habileté.") : svensonItem(call * 10 + i)));
  flag = (block) => (/négativité/.test(block) ? { off: "Le « biais de négativité » n'apparaît pas dans les extraits.", terms: ["biais de négativité"] } : null);
  secondLook = () => null;
  const { r, view } = await exam(id, 2);
  assert.equal(r.count, 2);
  assert.ok(view.items.every((it) => !it.options.some((o) => /négativité/.test(o))));
});

test("fenêtre de preuve : le mot cherché reste dedans après calage, et deux mots écartés tiennent ensemble s'ils le peuvent", async () => {
  const { densestWindow } = await import("../lib/course-grounding");
  const filler = (n: number) => "intuition raison méthode ".repeat(Math.ceil(n / 25)).slice(0, n);
  // Cas de la revue : une fin de phrase juste avant la fenêtre la décalait, et « Svenson » en sortait.
  const a = `${filler(1100)}. ${filler(1848)} Svenson (1981) conclut.`;
  assert.match(densestWindow(a, "Svenson", 1800), /Svenson/);
  // Deux mots à 1 611 caractères l'un de l'autre : une fenêtre de 1 800 les contient tous les deux.
  const b = `${filler(500)} Thaler ${filler(1600)} Sunstein ${filler(2000)}`;
  const w = densestWindow(b, "Thaler Sunstein", 1800);
  assert.match(w, /Thaler/);
  assert.match(w, /Sunstein/);
  assert.ok(w.length <= 1800 + 200, `fenêtre bornée (${w.length})`);
});

test("rien dans tout le cours sur la notion signalée : rejet sans second regard (rien pour la blanchir)", async () => {
  const id = await course();
  design = (n, call) => Array.from({ length: n }, (_, i) => (call === 1 && i === 0 ? svensonItem(0, "Le cadre SMACIT pousse les conducteurs à sous-estimer leur habileté.") : svensonItem(call * 10 + i)));
  flag = (block) => (/SMACIT/.test(block) ? { off: "SMACIT n'apparaît nulle part dans les extraits.", terms: ["SMACIT"] } : null);
  secondLook = (prompt) => {
    const blocks = prompt.split(/^(?=Q\d+\.)/m).filter((b) => /^Q\d+\./.test(b));
    return blocks.map((b) => ({ index: Number(/^Q(\d+)\./.exec(b)![1]), off_course: "" }));
  };
  const { r, view } = await exam(id, 2);
  assert.equal(r.count, 2);
  assert.ok(view.items.every((it) => !it.options.some((o) => /SMACIT/.test(o))), "la question n'est pas blanchie");
  assert.equal(secondLookPrompts.length, 0, "aucun appel : aucun passage ne parle de la notion");
});

test("définition jugée différente sur des extraits partiels (#55), mais conforme au cours entier : gardée après le second regard", async () => {
  const id = await course();
  flag = () => null;
  mismatch = (b) => (/Svenson/.test(b) ? "« supériorité illusoire » : la question la réduit aux conducteurs ; les extraits ne la définissent pas" : "");
  secondLook = (prompt) => {
    assert.match(prompt, /définition différente du cours/);
    const blocks = prompt.split(/^(?=Q\d+\.)/m).filter((b) => /^Q\d+\./.test(b));
    return blocks.map((b) => ({ index: Number(/^Q(\d+)\./.exec(b)![1]), off_course: "" }));
  };
  const { r, steps } = await exam(id, 2);
  assert.equal(r.count, 2);
  assert.ok(!steps.some((s) => /QCM rejeté/.test(s)), steps.filter((s) => /rejeté/.test(s)).join("\n"));
  assert.equal(designCalls, 1);
});

test("banc du 04/11 : une notion de la clé recopiée en paraphrase (introuvable mot pour mot) passe au second regard, pas au rejet immédiat", async () => {
  const id = await course();
  // CS-290 : « keyword filter false positive », « mask booléen combiné avec & » (cours en anglais) :
  // le correcteur paraphrase ou traduit ; le contrôle mot pour mot rejetait des questions justes.
  courseTerms = (block) => (/\(s10\)/.test(block) ? ["supériorité illusoire des automobilistes"] : []);
  const { r, view, steps } = await exam(id, 2);
  assert.equal(r.count, 2);
  assert.ok(view.items.some((it) => /\(s10\)/.test(it.stem)), `la question est gardée :\n${steps.join("\n")}`);
  assert.ok(secondLookPrompts.length >= 1, "le second regard a cherché dans tout le cours");
});
