/**
 * QUALITÉ DES QCM (lib/qcm) — ce que le cas HUM-285 a révélé : options d'un mot,
 * mauvaises réponses évidentes, « classe ce cas dans la notion X ». Verrouillé :
 *  - la conception reçoit une taxonomie explicite de distracteurs, la langue de
 *    l'examen, des passages PRÉCIS du cours à tester, et les questions d'exemple
 *    officielles comme modèle de style quand il n'y a pas d'annale ;
 *  - le juge à l'aveugle note le pouvoir discriminant (« un étudiant qui ne connaît
 *    que les noms des notions réussit-il ? ») et les items faibles sont régénérés ;
 *  - la bonne réponse ne se trahit ni par sa longueur ni par sa position.
 * Fournisseur LLM simulé : aucune dépense, prompts enregistrés.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-qcm-quality-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";

const prompts: string[] = [];
let verifyCalls = 0;

/** Un QCM bien construit : propositions complètes, longueurs comparables. */
function item(i: number, regen = false) {
  return {
    topic: "Désinformation",
    type: "scq",
    stem: `${regen ? "REGEN " : ""}Selon l'étude de Vosoughi et al. (2018) sur Twitter, laquelle de ces affirmations est exacte ? (Q${i})`,
    options: [
      "Les fausses nouvelles se diffusent environ six fois plus vite que les vraies.",
      "Les vraies nouvelles se diffusent environ six fois plus vite que les fausses.",
      "Les fausses nouvelles se diffusent plus vite, mais uniquement grâce aux robots.",
      "Les deux types de nouvelles se diffusent à la même vitesse sur Twitter.",
    ],
    correct: [0],
    misconceptions: ["", "[inversion] résultat inversé", "[mauvaise condition] l'étude montre l'inverse pour les robots", "[sur-généralisation] aucune différence"],
    explanation: "Vosoughi et al. (2018) : les fausses nouvelles vont six fois plus vite, et ce sont les humains, pas les robots, qui les propagent.",
    mold: "applied_scenario",
  };
}

function reply(prompt: string): unknown {
  if (/"results"/.test(prompt)) {
    verifyCalls++;
    // Le juge résout chaque question d'après ses options (mélangées) : la bonne est celle de l'étude.
    const blocks = prompt.split(/^(?=Q\d+\.)/m).filter((b) => /^Q\d+\./.test(b));
    const solved = blocks.map((b) => {
      const i = Number(/^Q(\d+)\./.exec(b)![1]);
      const opt = [...b.matchAll(/^\s+\((\d+)\) (.*)$/gm)].find((m) => /fausses nouvelles se diffusent environ six fois plus vite que les vraies/.test(m[2]));
      return { i, key: opt ? Number(opt[1]) : 0 };
    });
    // Première vérification : la question 1 se résout avec les seuls noms des notions → faible.
    return { results: solved.map(({ i, key }) => verifyCalls === 1 && i === 1
      ? { index: i, correct: [key], ok: true, discrimination: 1, name_only: true, issue: "options = noms de notions, réussie sans connaître l'étude" }
      : { index: i, correct: [key], ok: true, discrimination: 4, name_only: false, issue: "" }) };
  }
  if (/"items"/.test(prompt)) {
    const n = Number(/\((\d+) QCM\)/.exec(prompt)?.[1] ?? 1);
    const regen = /À CORRIGER/.test(prompt);
    return { items: Array.from({ length: n }, (_, i) => item(i, regen)) };
  }
  return {};
}

let llm: http.Server;
before(async () => {
  delete process.env.CORTEX_USER;
  llm = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const content = (JSON.parse(body).messages as { content: unknown }[]).map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
      prompts.push(content);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply(content)) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const FACT = "Vosoughi, Roy et Aral (2018) : sur Twitter, les fausses nouvelles se propagent environ six fois plus vite que les vraies ; ce sont les humains, pas les robots, qui les diffusent.";
const SAMPLE = "Question modèle : Laquelle est un nudge ? A) Une taxe B) Un mode éco activé par défaut, désactivable en un clic C) Une interdiction D) Un mode éco imposé sans désactivation.";

async function humCourse(): Promise<string> {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const { runWithCourse, ensureFts } = await import("../db/client");
  const { q } = await import("../db/q");
  const { indexItemForSearch } = await import("../lib/search");
  const row = buildCourseRow({ name: "Enjeux mondiaux", code: "HUM-285", language: "fr", examFormat: { kind: "qcm", questionCount: 4 } }, "owner");
  await insertCourse(row);
  await reloadCourses();
  await runWithCourse(row.id, async () => {
    ensureFts();
    for (const t of ["sources", "items", "topics"]) await q.ensureTable(t);
    for (const [type, title, text] of [["course_pdf", "Vérifier et entreprendre", FACT], ["sample_questions", "Questions modèles", SAMPLE]] as const) {
      const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, type, title, `${type}/${title}`, null, 1);
      const iid = await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, type, title, text);
      await indexItemForSearch(iid, sid, title, text);
    }
    await q.run(`INSERT INTO topics (label, method, exam_weight, exam_count) VALUES (?,?,?,?)`, "Désinformation : fausses nouvelles sur Twitter", null, 3, 1);
  });
  return row.id;
}

test("la longueur ou la position ne trahissent plus la bonne réponse", async () => {
  const { qcmLengthCue, shuffleQcmOptions } = await import("../lib/qcm");
  assert.equal(qcmLengthCue(["Oui.", "Non.", "Parfois, selon les conditions précises de la définition donnée en cours.", "Jamais."], [2]), true);
  assert.equal(qcmLengthCue(["Les fausses nouvelles vont plus vite.", "Les vraies nouvelles vont plus vite.", "Les deux vont à la même vitesse.", "Seuls les robots les diffusent."], [0]), false);
  const it = { options: ["a juste", "b faux", "c faux", "d faux"], correct: [0], misconceptions: ["", "mb", "mc", "md"] };
  const moved = new Set<number>();
  for (let seed = 0; seed < 12; seed++) {
    const s = shuffleQcmOptions(it, seed);
    assert.equal(s.options[s.correct[0]], "a juste", "la clé suit sa proposition");
    assert.equal(s.misconceptions[s.correct[0]], "");
    assert.equal(s.misconceptions[s.options.indexOf("b faux")], "mb");
    moved.add(s.correct[0]);
  }
  assert.ok(moved.size >= 3, "la bonne réponse change de position d'un item à l'autre");
});

test("une explication qui renvoie à une option par sa lettre ou son numéro est repérée, pas une tournure française", async () => {
  const { citesOptionLabel } = await import("../lib/qcm");
  for (const t of ["L'option 3 confond corrélation et causalité.", "La réponse B inverse le résultat.", "(C) sur-généralise.", "A) est faux car…", "Option b : mauvaise attribution."]) {
    assert.equal(citesOptionLabel(t), true, t);
  }
  for (const t of ["L'option d'interdire supprime la liberté de choix.", "Une option de sortie existe.", "Le choix d'un défaut change tout.", "A nudge preserves freedom of choice."]) {
    assert.equal(citesOptionLabel(t), false, t);
  }
});

test("conception : taxonomie de distracteurs, langue, faits précis du cours, exemples officiels, pas de « classe ce cas »", async () => {
  const id = await humCourse();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam } = await import("../lib/qcm");
  prompts.length = 0;
  verifyCalls = 0;
  const r = await runWithCourse(id, () => generateQcmExam({ count: 4, openCount: 0 }));
  assert.equal(r.count, 4);
  const gen = prompts.find((p) => /"items"/.test(p))!;
  for (const marker of [/inversion/i, /mauvaise condition/i, /mauvaise attribution/i, /sur-g[ée]n[ée]ralisation/i, /quasi-synonyme|notion voisine/i]) assert.match(gen, marker);
  assert.match(gen, /propositions? compl[èe]tes?/i);
  assert.match(gen, /LANGUE[^\n]*fran[çc]ais/i);
  assert.match(gen, /six fois plus vite/, "le passage du cours à tester est fourni");
  assert.match(gen, /mode éco activé par défaut/, "les questions d'exemple officielles servent de modèle de style");
  assert.match(gen, /classe[r]? ce cas|classification/i);
});

test("juge à l'aveugle : un item réussi avec les seuls noms des notions est régénéré, les autres gardés", async () => {
  const id = await humCourse();
  const { runWithCourse } = await import("../db/client");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  prompts.length = 0;
  verifyCalls = 0;
  const r = await runWithCourse(id, () => generateQcmExam({ count: 4, openCount: 0 }));
  const verify = prompts.find((p) => /"results"/.test(p))!;
  assert.match(verify, /noms des notions/i, "le juge mesure le pouvoir discriminant");
  const regen = prompts.find((p) => /À CORRIGER/.test(p));
  assert.ok(regen, "un lot de régénération a été demandé");
  assert.match(regen!, /noms de notions, réussie sans connaître l'étude/);
  const exam = await runWithCourse(id, () => getQcmExam(r.id, true));
  const stems = exam!.items.map((x) => x.stem);
  assert.equal(stems.filter((s) => s.startsWith("REGEN")).length, 1, stems.join("\n"));
  for (const it of exam!.items as (NonNullable<typeof exam>["items"][number] & { correct: number[] })[]) {
    assert.match(it.options[it.correct[0]], /six fois plus vite que les vraies/, "la clé suit sa proposition après mélange");
  }
});
