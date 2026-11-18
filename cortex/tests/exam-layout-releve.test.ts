/**
 * LA MISE EN PAGE DE L'ANNALE, RELEVÉE À LA PRÉPARATION : detectFormat (lib/format) lit les PDF de
 * l'annale une fois, sans appel au modèle de plus, et stocke le relevé avec le profil de format ;
 * les examens du cours le lisent ensuite (lib/exam-layout examLayout) sans rien relire.
 * Annale FICTIVE (tests/fixtures/annales/us-mcq.pdf, compilée depuis us-mcq.tex). Faux fournisseur
 * LLM local : aucun appel payant.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-exam-layout-releve-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "openai-compatible";
process.env.LLM_API_KEY = "test";
process.env.LLM_MODEL_OPUS = "claude-sonnet-5";
process.env.LLM_MAX_RETRIES = "0";

const PROFILE = {
  format_summary: "40 single-choice questions with five options (A)–(E).", has_mcq: true,
  question_types: [{ type: "scq", approx_count: 40, share_pct: 100, points_each: 1, note: "" }],
  duration_min: 75, total_points: 40, sections: [], topics_emphasis: [],
};
let calls = 0;
let llm: http.Server;

before(async () => {
  delete process.env.CORTEX_USER;
  llm = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      calls++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(PROFILE) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
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

/** Un cours hors EPFL, avec une annale ingérée (texte) et son PDF dans refs/. */
async function courseWithAnnale(pdf: string | null): Promise<string> {
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const { reloadCourses, coursePaths } = await import("../lib/courses");
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const row = buildCourseRow({ name: `Toy Probability ${Math.random().toString(36).slice(2, 6)}`, university: "Imaginary State University", language: "en" } as never, "owner");
  await insertCourse(row);
  await reloadCourses();
  await runWithCourse(row.id, async () => {
    await q.ensureTable("sources");
    await q.ensureTable("items");
    const sid = await q.insert(`INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`, "final", "Midterm 1", "final/midterm-1.pdf", 2025, 1);
    await q.insert(`INSERT INTO items (source_id, type, title, text) VALUES (?,?,?,?)`, sid, "final", "Midterm 1", "1. A fair toy die is rolled once. (A) 1/6 (B) 1/3 (C) 1/2 (D) 2/3 (E) 1");
  });
  if (pdf) {
    const refs = coursePaths(row.id).refsDir;
    fs.mkdirSync(refs, { recursive: true });
    fs.copyFileSync(pdf, path.join(refs, "midterm-1.pdf"));
  }
  return row.id;
}

const FIXTURE = path.join(__dirname, "fixtures", "annales", "us-mcq.pdf");

test("préparation : la mise en page de l'annale est relevée et stockée, sans appel au modèle de plus ; les examens la lisent", async (t) => {
  if (spawnSync("pdftotext", ["-v"]).error) return t.skip("pdftotext absent");
  const id = await courseWithAnnale(FIXTURE);
  const { runWithCourse } = await import("../db/client");
  const { detectFormat } = await import("../lib/format");
  const { readStoredProfile } = await import("../lib/exam-format");
  const { examLayout } = await import("../lib/exam-layout");
  const { renderQcmExamTex } = await import("../lib/qcm-latex");
  const { QCM_DATA, DATE } = await import("./helpers/gabarits");
  calls = 0;
  await runWithCourse(id, () => detectFormat());
  assert.equal(calls, 1, "le relevé ne coûte aucun appel");
  await runWithCourse(id, async () => {
    const stored = await readStoredProfile();
    assert.deepEqual(stored?.layout?.choices, { label: "(A)", mark: "bubble", columns: 1 });
    const layout = await examLayout();
    assert.equal(layout.source, "annale");
    assert.deepEqual(layout.cover.idFields.map((f) => f.label), ["Name:", "NetID:", "Signature:"]);
    const tex = await renderQcmExamTex(QCM_DATA, DATE, false);
    assert.match(tex, /\$\\bigcirc\$~\\textbf\{\(A\)\}~/);
    assert.match(tex, /NetID:~/);
    assert.match(tex, /\\renewcommand\{\\familydefault\}\{\\sfdefault\}/);
    assert.match(tex, /\\documentclass\[10pt,a4paper\]/);
  });
});

test("préparation sans PDF d'annale (originaux purgés) : profil sans mise en page, défaut neutre", async () => {
  const id = await courseWithAnnale(null);
  const { runWithCourse } = await import("../db/client");
  const { detectFormat } = await import("../lib/format");
  const { readStoredProfile } = await import("../lib/exam-format");
  const { examLayout, NEUTRAL_LAYOUT } = await import("../lib/exam-layout");
  await runWithCourse(id, () => detectFormat());
  await runWithCourse(id, async () => {
    assert.equal((await readStoredProfile())?.layout, undefined);
    assert.deepEqual(await examLayout(), NEUTRAL_LAYOUT);
  });
});

test("consignes de l'annale : seulement sur un examen de leur langue", async () => {
  const { annaleLayout } = await import("../lib/exam-layout");
  const s = { cover: { instructions: ["Les calculatrices sont interdites."] }, language: "fr" as const };
  assert.deepEqual(annaleLayout(s, "fr").cover.instructions, ["Les calculatrices sont interdites."]);
  assert.deepEqual(annaleLayout(s, "en").cover.instructions, []);
  assert.deepEqual(annaleLayout({ cover: { instructions: ["Phones off."] } }, "en").cover.instructions, [], "langue inconnue : rien");
});
