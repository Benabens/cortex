/**
 * COUVERTURE DES CHAPITRES (lib/coverage) — CS-290 (02/11/2026) : sur 5
 * générations, les QCM portaient toujours sur Fairness 1. Les notions du cours
 * sont triées par poids et la tête l'emporte (60 % des questions) ; or trois
 * préparations successives avaient laissé 4 variantes de la même notion de
 * Fairness 1 en tête, sans aucun chapitre (plan_chapters vide).
 * Verrouillé : les questions se répartissent sur TOUS les chapitres (plan du
 * cours, sinon support du cours où la notion apparaît), au prorata de leur
 * poids, au moins une par chapitre quand le nombre le permet.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-coverage-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";

test("répartition : au moins une question par chapitre, le surplus au prorata du poids", async () => {
  const { spreadOverChapters } = await import("../lib/coverage");
  const t = (label: string, chapter: string | null, weight: number) => ({ label, method: null, weight, chapter });
  const topics = [
    ...["f1a", "f1b", "f1c", "f1d", "f1e", "f1f"].map((l) => t(l, "Fairness 1", 10)),
    t("intro", "Introduction", 2), t("s1", "Safety 1", 2), t("s2", "Safety 2", 2), t("f2", "Fairness 2", 2),
  ];
  const seven = spreadOverChapters(topics, 7)!;
  assert.equal(seven.length, 7);
  assert.equal(new Set(seven.map((x) => x.chapter)).size, 5, "les 5 chapitres sont touchés");
  assert.equal(seven.filter((x) => x.chapter === "Fairness 1").length, 3, "le chapitre le plus lourd prend le surplus");
  assert.equal(new Set(seven.map((x) => x.label)).size, 7, "aucun sujet répété tant qu'il en reste");
  const three = spreadOverChapters(topics, 3)!;
  assert.equal(new Set(three.map((x) => x.chapter)).size, 3, "moins de questions que de chapitres : un chapitre chacune");
  const twelve = spreadOverChapters(topics, 12)!;
  assert.ok(twelve.some((x) => x.repeat), "au-delà des sujets d'un chapitre, la reprise est marquée");
  // Variantes d'une même notion (trois préparations successives sur CS-290) : pas deux à la suite.
  const variants = [
    t("Sensitive / proxy / latent attributes", "F1", 11), t("Proxy attribute / latent attributes", "F1", 10.9),
    t("Simpson's paradox", "F1", 9), t("Keyword filtering", "S1", 5),
  ];
  const picked = spreadOverChapters(variants, 3)!.filter((x) => x.chapter === "F1").map((x) => x.label);
  assert.deepEqual(picked, ["Sensitive / proxy / latent attributes", "Simpson's paradox"], "une variante cède la place à une autre notion");
  // H — mock 4 de CS-290 : Q6/Q12 sur le paradoxe de Simpson, libellés en deux langues et dans deux chapitres.
  const bilingual = [
    t("Simpson's paradox / confounder", "F1", 9), t("Paradoxe de Simpson — Berkeley", "NB", 8),
    t("Sensitive / proxy / latent attributes", "F1", 11), t("Attributs sensibles / biais latents / GDPR", "F1", 10),
    t("Demographic parity judgment", "F1", 10), t("Groupby aggregation table", "NB", 9), t("Weighted score & normalization", "NB", 7),
  ];
  const five = spreadOverChapters(bilingual, 5)!.map((x) => x.label);
  assert.ok(!(five.includes("Simpson's paradox / confounder") && five.includes("Paradoxe de Simpson — Berkeley")), five.join(" | "));
  assert.ok(!(five.includes("Sensitive / proxy / latent attributes") && five.includes("Attributs sensibles / biais latents / GDPR")), five.join(" | "));
  // Notions des examens précédents de l'utilisateur : reprises seulement en dernier.
  const fresh = spreadOverChapters(bilingual, 3, { avoid: ["Sensitive, proxy and latent attributes", "Simpson paradox"] })!.map((x) => x.label);
  assert.ok(!fresh.some((l) => /Sensitive|Attributs sensibles|Simpson/.test(l)), fresh.join(" | "));
  assert.equal(spreadOverChapters([t("a", null, 1), t("b", null, 1)], 4), null, "sans chapitres : rien à répartir");
  assert.equal(spreadOverChapters([t("a", "X", 1), t("b", "X", 1)], 4), null, "un seul chapitre : rien à répartir");
});

// ─────────── intégration : 5 chapitres, notions de Fairness 1 en tête ───────────

const CHAPTERS: Record<string, string[]> = {
  "Introduction - ethics recap": ["Ethical theories utilitarianism deontology"],
  "Safety 1 - content moderation": ["Keyword filtering content moderation"],
  "Safety 2 - content recommendation": ["Filter bubble recommendation feedback loop"],
  "Fairness 1 - sources of unfairness": [
    "Demographic parity judgment", "Sensitive proxy latent attributes", "Proxy attribute indirect discrimination",
    "Simpson paradox confounder", "Sources of bias classification", "Admission score normalization",
  ],
  "Fairness 2 - fairness in ML": ["Disparate impact ratio impossibility result"],
};
const prompts: string[] = [];
let llm: http.Server;

before(async () => {
  delete process.env.CORTEX_USER;
  llm = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const content = (JSON.parse(body).messages as { content: unknown }[]).map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content)).join("\n");
      let text = "{}";
      if (/"results"/.test(content)) {
        // Le juge trouve la bonne option là où le mélange l'a mise (une clé contestée serait rejetée).
        const blocks = content.split(/^(?=Q\d+\.)/m).filter((b) => /^Q\d+\./.test(b));
        text = JSON.stringify({ results: blocks.map((b, i) => {
          const right = /^\s+\((\d+)\) Une proposition complète/m.exec(b);
          return { index: i, correct: [right ? Number(right[1]) : 0], ok: true, discrimination: 4, name_only: false, issue: "", course_terms: [], off_course: "" };
        }) });
      } else if (/"items"/.test(content)) {
        prompts.push(content);
        const n = Number(/\((\d+) QCM\)/.exec(content)?.[1] ?? 1);
        text = JSON.stringify({ items: Array.from({ length: n }, (_, i) => ({
          topic: "t", type: "scq", stem: `Question ${prompts.length}.${i} ?`,
          options: ["Une proposition complète de longueur moyenne.", "Une autre proposition de longueur moyenne.", "Une troisième proposition de longueur moyenne.", "Une quatrième proposition de longueur moyenne."],
          correct: [0], misconceptions: ["", "a", "b", "c"], explanation: "Parce que le cours le dit.",
        })) });
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
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MAX_RETRIES", "LLM_BASE_URL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("programme à 5 chapitres, notions de Fairness 1 en tête : 7 questions touchent au moins 4 chapitres", async () => {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const { runWithCourse, ensureFts } = await import("../db/client");
  const { q } = await import("../db/q");
  const { indexItemForSearch } = await import("../lib/search");
  const { generateQcmExam } = await import("../lib/qcm");
  const row = buildCourseRow({ name: "Responsible Software", code: "CS-290", language: "en", examFormat: { kind: "qcm", questionCount: 7 } }, "owner");
  await insertCourse(row);
  await reloadCourses();
  const chapterOf = new Map<string, string>();
  await runWithCourse(row.id, async () => {
    ensureFts();
    for (const t of ["sources", "items", "topics"]) await q.ensureTable(t);
    for (const [title, labels] of Object.entries(CHAPTERS)) {
      const text = `${title}. ${labels.map((l) => `${l}: the course explains ${l.toLowerCase()} in detail.`).join(" ")}`;
      const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "note", title, `note/${title}`, null, 1);
      const iid = await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "note", title, text);
      await indexItemForSearch(iid, sid, title, text);
      for (const label of labels) {
        chapterOf.set(label, title);
        await q.run(`INSERT INTO topics (label, method, exam_weight, exam_count) VALUES (?,?,?,?)`, label, null, title.startsWith("Fairness 1") ? 10 : 2, 1);
      }
    }
  });
  const r = await runWithCourse(row.id, () => generateQcmExam({ count: 7, openCount: 0 }));
  assert.equal(r.count, 7);
  const asked = prompts.flatMap((p) => [...p.matchAll(/^ {2}\d+\) (.+?)(?: \[|$)/gm)].map((m) => m[1].trim()));
  const touched = new Set(asked.map((l) => chapterOf.get(l)).filter(Boolean));
  assert.ok(touched.size >= 4, `${touched.size} chapitres : ${asked.join(" | ")}`);
});

// ─────────── A — non-régression : la forme du cours RS (CS-290, 02/11) ───────────
// Rattachement réel des 38 notions du cours aux supports (banc du dump, 02/11) : Fairness 1
// en porte 23 (trois préparations successives, variantes bilingues), Introduction deux,
// Safety 2 une seule, dont la méthode énumère quatre phénomènes. Avant : 7 QCM sur 12 en
// Fairness 1, rien sur Introduction, et les boucles de rétroaction jamais posées.
const LOOP = "reinforcing vs balancing loop";
const F1 = "Fairness 1";
const RS_SHAPE: [string, string, number, string | null][] = [
  ...([
    ["Attributs sensibles / biais latents / GDPR", 10], ["Proxy attribute / discrimination indirecte", 10], ["Score d'admission — normalisation et pondération", 10],
    ["Demographic parity judgment", 10.9], ["Sensitive / proxy / latent attributes", 10.9], ["Inclusive Design & Value Analysis (Schwartz Values)", 2],
    ["Simpson's Paradox / Confounding Variable (Berkeley-style)", 3], ["Inclusive design mismatch", 5.5], ["Value analysis / tension map", 5.5],
    ["Biais cognitifs et dette technique/éthique", 6], ["Bias Taxonomy (Pre-existing / Representation / Measurement / Population / Aggregation / Evaluation)", 6],
    ["Cognitive Biases & Debiasing Strategies", 6], ["Détection d'outliers / cas limites", 6], ["Fairness Metrics & Proxy/Latent Variables", 6],
    ["Value analysis (Schwartz) et conception inclusive", 6], ["Cognitive biases in design", 7.3], ["Fairness trade-offs & no free lunch", 7.3],
    ["Outlier / edge-case OR-logic", 7.3], ["Paradoxe de Simpson — Berkeley", 8], ["Groupby aggregation table", 9.1], ["Simpson's paradox / confounder", 9.1],
    ["Sources of bias classification", 9.1], ["Weighted score & normalization", 9.1],
  ] as [string, number][]).map(([l, w]) => [l, F1, w, null] as [string, string, number, string | null]),
  ["Disparate Impact Ratio, Impossibility Result & Fairness-Unawareness", "Fairness 2", 7, null],
  ["COMPAS-style fairness metrics", "Fairness 2", 9.1, null],
  ["Réflexion éthique ouverte (dilemme, critique)", "Introduction", 0, null],
  ["Stakeholder Analysis", "Introduction", 3, null],
  ["Moral Machine — analyse descriptive de données", "Notebooks 0-1", 10, null],
  ["Python/pandas code tracing", "Notebooks 0-1", 16, null],
  ["Code Reading — Python & Pandas Output Prediction", "Notebooks 0-1", 20, null],
  ["Analyse de sentiment — VADER", "Notebooks 0-1", 8, null],
  ["Confusion Matrix Metrics — Accuracy / FP / FN", "Notebooks 2-4", 9, null],
  ["Ethical Theory & Issue/Dilemma Classification", "Pièges (tout le semestre)", 6, null],
  ["Ethical/Fairness Trade-off Dilemma (Open-ended)", "Pièges (tout le semestre)", 6, null],
  ["Safety Terminology — Threat/Hazard & Malfunction/Abuse/Misuse", "Pièges (tout le semestre)", 9, null],
  ["Modération de contenu — filtrage par mots-clés", "Safety 1", 10, null],
  ["Content Moderation Techniques & Limits", "Safety 1", 8, "identifier la technique (keyword filtering, sentiment analysis, perceptual hashing, shadow banning) et ses limites (FP/FN)"],
  ["Misinformation & Recommendation Phenomena", "Safety 2", 9, `nommer le phénomène (filter bubble, illusory truth effect, mis/dis/malinformation, ${LOOP}) à partir d'un scénario`],
];

test("A — cas RS : sur 4 examens successifs de 12 QCM, chaque chapitre à chaque fois, Fairness 1 jamais majoritaire, les boucles de rétroaction atteintes", async () => {
  const { spreadOverChapters } = await import("../lib/coverage");
  const topics = RS_SHAPE.map(([label, chapter, weight, method]) => ({ label, chapter, weight, method }));
  const asked: string[] = [];
  const themes: string[] = [];
  for (let exam = 1; exam <= 4; exam++) {
    const picked = spreadOverChapters(topics, 12, { avoid: [...asked], asked: [...themes] })!;
    const per = (c: string) => picked.filter((x) => x.chapter === c).length;
    const show = picked.map((x) => `${x.label}${x.subTheme ? ` (${x.subTheme})` : ""}`).join(" | ");
    for (const c of ["Introduction", "Safety 1", "Safety 2", F1, "Fairness 2"]) assert.ok(per(c) >= 1, `examen ${exam} : rien sur ${c} — ${show}`);
    assert.ok(per(F1) <= 4, `examen ${exam} : ${per(F1)}/12 sur Fairness 1 — ${show}`);
    asked.push(...picked.map((x) => x.label));
    themes.push(...picked.map((x) => x.subTheme ?? "").filter(Boolean));
  }
  assert.ok(themes.includes(LOOP), `sous-thèmes posés : ${themes.join(" | ")}`);
  assert.equal(new Set(themes.filter((t) => /filter bubble|illusory|malinformation|loop/.test(t))).size, 4, "les quatre phénomènes de Safety 2, un par examen");
});

test("A — le sous-thème choisi atteint le générateur : la méthode n'est plus coupée avant les boucles de rétroaction", async () => {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses } = await import("../lib/courses");
  const { runWithCourse, ensureFts } = await import("../db/client");
  const { q } = await import("../db/q");
  const { indexItemForSearch } = await import("../lib/search");
  const { generateQcmExam, getQcmExam } = await import("../lib/qcm");
  const row = buildCourseRow({ name: "Responsible Software bis", code: "CS-290", language: "en", examFormat: { kind: "qcm", questionCount: 5 } }, "owner");
  await insertCourse(row);
  await reloadCourses();
  await runWithCourse(row.id, async () => {
    ensureFts();
    for (const t of ["sources", "items", "topics"]) await q.ensureTable(t);
    const five = ["Introduction", "Safety 1", "Safety 2", "Fairness 2"];
    for (const [label, chapter, weight, method] of RS_SHAPE.filter(([, c]) => five.includes(c)).concat(RS_SHAPE.filter(([, c]) => c === F1).slice(0, 3))) {
      const title = `${chapter} - notes`;
      const text = `${title}. ${label}: ${method ?? label}. The course explains ${label.toLowerCase()}.`;
      const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "note", `${title} ${label}`.slice(0, 80), `note/${label}`, null, 1);
      await q.run(`UPDATE sources SET title = ? WHERE id = ?`, title, sid);
      const iid = await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "note", title, text);
      await indexItemForSearch(iid, sid, title, text);
      await q.run(`INSERT INTO topics (label, method, exam_weight, exam_count) VALUES (?,?,?,?)`, label, method, weight, 1);
    }
    // Trois examens précédents ont déjà posé les trois premiers phénomènes.
    await getQcmExam(0);
    const prev = await q.insert(`INSERT INTO exams (format_template, status) VALUES ('qcm','ready')`);
    for (const [i, stem] of ["Which phenomenon is a filter bubble?", "Repeated exposure makes a claim feel true: which effect (illusory truth effect)?", "A true leak shared to harm someone is malinformation: which category?"].entries()) {
      await q.run(`INSERT INTO qcm_items (exam_id, idx, topic, type, stem, options_json, correct_json, misconceptions_json, explanation, verified) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        prev, i, "Misinformation & Recommendation Phenomena", "scq", stem, "[]", "[0]", "[]", "…", 1);
    }
  });
  prompts.length = 0;
  await runWithCourse(row.id, () => generateQcmExam({ count: 5, openCount: 0 }));
  const line = prompts.flatMap((p) => p.split("\n")).find((l) => /^ {2}\d+\) Misinformation & Recommendation Phenomena/.test(l)) ?? "";
  assert.ok(line, `Safety 2 absent des lots : ${prompts.join("\n---\n").slice(0, 600)}`);
  assert.match(line, new RegExp(`sous-thème[^\\n]*${LOOP}`), line);
});
