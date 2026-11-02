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
