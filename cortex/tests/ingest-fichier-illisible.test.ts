/**
 * Un fichier illisible (PDF abîmé, chiffré, scanné sans texte) est isolé : l'ingestion lit tous
 * les autres, et le rapport du job le signale fichier par fichier (audit ingestion du 16/11/2026,
 * P0 : une seule annale illisible faisait échouer toutes les ingestions suivantes du cours, avec
 * « } » pour tout message). Le vrai script d'ingestion, sur un cours fictif.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { corruptPdf, encryptedPdf, textPdf } from "./helpers/pdf";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-ingest-illisible-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  delete process.env.MAX_COURSES_CREATED_PER_HOUR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function newCourse(name: string): Promise<{ id: string; refsDir: string; contentRoot: string }> {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded, reloadCourses, coursePaths } = await import("../lib/courses");
  await ensureCoursesLoaded();
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const row = buildCourseRow({ name, language: "fr" }, "owner");
  await insertCourse(row);
  await reloadCourses();
  const { refsDir, contentRoot } = coursePaths(row.id);
  fs.mkdirSync(refsDir, { recursive: true });
  fs.mkdirSync(path.join(contentRoot, "lectures"), { recursive: true });
  return { id: row.id, refsDir, contentRoot };
}

function ingest(course: string) {
  const report = path.join(tmp, `rapport-${course}.json`);
  const r = spawnSync(path.join(process.cwd(), "node_modules", ".bin", "tsx"), ["scripts/ingest.ts", `--course=${course}`], {
    env: { ...process.env, CORTEX_COURSE: course, CORTEX_INGEST_REPORT: report },
    encoding: "utf8",
  });
  const files = fs.existsSync(report) ? (JSON.parse(fs.readFileSync(report, "utf8")).files as { path: string; status: string; items: number }[]) : null;
  return { status: r.status, output: r.stdout + r.stderr, files };
}

async function sourcePaths(course: string): Promise<string[]> {
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  return runWithCourse(course, async () => (await q.all<{ path: string }>(`SELECT DISTINCT path FROM sources ORDER BY path`)).map((s) => s.path));
}

test("une annale abîmée n'empêche pas les autres d'être lues, et le rapport la nomme", async () => {
  const c = await newCourse("Orvelle annales");
  fs.writeFileSync(path.join(c.refsDir, "final-2022.pdf"), textPdf("Exercice 1 du final 2022"));
  fs.writeFileSync(path.join(c.refsDir, "final-2023.pdf"), corruptPdf());
  fs.writeFileSync(path.join(c.refsDir, "final-2024.pdf"), textPdf("Exercice 1 du final 2024"));

  const r = ingest(c.id);
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(await sourcePaths(c.id), ["refs/final-2022.pdf", "refs/final-2024.pdf"]);
  assert.deepEqual(r.files?.find((f) => f.path === "refs/final-2023.pdf")?.status, "unreadable", JSON.stringify(r.files));
  assert.equal(r.files?.find((f) => f.path === "refs/final-2024.pdf")?.status, "indexed");
});

test("contenu : un PDF abîmé, un chiffré et un scan sans texte sont nommés chacun avec leur raison", async () => {
  const c = await newCourse("Orvelle supports");
  const lectures = path.join(c.contentRoot, "lectures");
  fs.writeFileSync(path.join(lectures, "chapitre-1.pdf"), textPdf("Les ondes de Orvelle et leur amortissement"));
  fs.writeFileSync(path.join(lectures, "chapitre-2.pdf"), corruptPdf());
  fs.writeFileSync(path.join(lectures, "chapitre-3.pdf"), encryptedPdf());
  fs.writeFileSync(path.join(lectures, "chapitre-4.pdf"), textPdf(null));
  fs.writeFileSync(path.join(c.refsDir, "final-2021.pdf"), encryptedPdf());

  const r = ingest(c.id);
  assert.equal(r.status, 0, r.output);
  const status = Object.fromEntries((r.files ?? []).map((f) => [f.path, f.status]));
  assert.deepEqual(status, {
    "lectures/chapitre-1.pdf": "indexed",
    "lectures/chapitre-2.pdf": "unreadable",
    "lectures/chapitre-3.pdf": "encrypted",
    "lectures/chapitre-4.pdf": "no_text",
    "refs/final-2021.pdf": "encrypted",
  });
});

test("job d'ingestion : terminé, et son rapport par fichier est lisible par l'interface", async () => {
  const c = await newCourse("Orvelle job");
  fs.writeFileSync(path.join(c.refsDir, "final-2022.pdf"), textPdf("Exercice 1 du final 2022"));
  fs.writeFileSync(path.join(c.refsDir, "final-2023.pdf"), corruptPdf());
  const { runWithCourse } = await import("../db/client");
  const jobs = await import("../lib/jobs");
  const { id } = await runWithCourse(c.id, () => jobs.createJobExclusive("ingest"));
  const r = spawnSync(path.join(process.cwd(), "node_modules", ".bin", "tsx"), ["scripts/run-job.ts", String(id), c.id], {
    env: { ...process.env, CORTEX_COURSE: c.id },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const job = await runWithCourse(c.id, () => jobs.getJob(id));
  assert.equal(job?.status, "done");
  assert.deepEqual(job?.report?.files.map((f) => [f.path, f.status]), [["refs/final-2022.pdf", "indexed"], ["refs/final-2023.pdf", "unreadable"]]);
});

test("échec de l'ingestion : le message du job est la ligne lisible, jamais la fin d'une pile d'erreur", async () => {
  const { ingestFailureMessage } = await import("../lib/ingest-report");
  const output = [
    "Cours : orvelle",
    "Error: relation \"vocab\" does not exist",
    "    at Object.run (db/q.ts:12:3) {",
    "  code: '42P01'",
    "}",
    "Échec ingestion : relation \"vocab\" does not exist",
    "• refs         : 2 examen(s) de référence",
  ];
  assert.equal(ingestFailureMessage(output, 1), "L’ingestion a échoué : relation \"vocab\" does not exist");
  assert.equal(ingestFailureMessage(["Cours : orvelle", "}"], 1), "L’ingestion a échoué (code 1).");
});

test("l'interface reçoit, pour chaque fichier non lu, son nom et une consigne claire", async () => {
  const { ingestProblems } = await import("../lib/ingest-report");
  const problems = ingestProblems({
    files: [
      { path: "lectures/chapitre-1.pdf", status: "indexed", items: 4 },
      { path: "refs/final-2023.pdf", status: "unreadable", items: 0 },
      { path: "lectures/chapitre-3.pdf", status: "encrypted", items: 0 },
      { path: "lectures/chapitre-4.pdf", status: "no_text", items: 0 },
    ],
  });
  assert.deepEqual(problems.map((p) => p.name), ["final-2023.pdf", "chapitre-3.pdf", "chapitre-4.pdf"]);
  assert.match(problems[0].message, /abîmé/);
  assert.match(problems[1].message, /mot de passe/);
  assert.match(problems[2].message, /scann/);
  assert.deepEqual(ingestProblems(null), []);
});

test("une ingestion qui échoue en route laisse le corpus d'avant intact (réécriture en une transaction)", { skip: process.getuid?.() === 0 ? "root lit un dossier sans droits" : false }, async () => {
  const c = await newCourse("Orvelle transaction");
  const lectures = path.join(c.contentRoot, "lectures");
  fs.writeFileSync(path.join(lectures, "chapitre-1.pdf"), textPdf("Les ondes de Orvelle"));
  fs.writeFileSync(path.join(c.refsDir, "final-2022.pdf"), textPdf("Exercice 1 du final 2022"));
  assert.equal(ingest(c.id).status, 0);
  const before = await sourcePaths(c.id);
  assert.deepEqual(before, ["lectures/chapitre-1.pdf", "refs/final-2022.pdf"]);

  // Un sous-dossier illisible fait échouer le parcours du contenu, après le début de la réécriture.
  const locked = path.join(lectures, "verrou");
  fs.mkdirSync(locked);
  fs.chmodSync(locked, 0o000);
  try {
    const r = ingest(c.id);
    assert.notEqual(r.status, 0, r.output);
    assert.match(r.output, /Échec ingestion : .*verrou/);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
  assert.deepEqual(await sourcePaths(c.id), before);
});
