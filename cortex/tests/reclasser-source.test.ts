/**
 * Reclasser un fichier mal rangé (suite de l'audit ingestion du 16/11/2026, P1-2 ; décision du
 * 21/11) : une annale déposée en support de cours, ou l'inverse, est reclassée par l'étudiant
 * depuis la liste des sources. La catégorie change en base, le fichier est rangé dans sa nouvelle
 * catégorie, et le job d'ingestion du cours (gratuit) le réindexe, sans doublon. L'année et le
 * type d'épreuve choisis survivent aux ingestions suivantes. Vraie route, vrai job, cours fictif.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { NextRequest } from "next/server";
import { textPdf } from "./helpers/pdf";
import { ingest, newCourse, sourcePaths } from "./helpers/ingest-course";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-reclasser-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";
process.env.STORAGE_MIN_FREE_PERCENT ??= "0";

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  delete process.env.MAX_COURSES_CREATED_PER_HOUR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function classify(course: string, body: Record<string, unknown>, acceptLanguage = "fr"): Promise<{ status: number; json: any }> {
  const mod = await import("../app/api/sources/classify/route");
  const url = `http://cortex.test/api/sources/classify?course=${course}`;
  const res: Response = await mod.POST(new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", "accept-language": acceptLanguage },
    body: JSON.stringify(body),
  }));
  return { status: res.status, json: await res.json() };
}

async function waitJob(course: string, id: number) {
  const { runWithCourse } = await import("../db/client");
  const jobs = await import("../lib/jobs");
  for (let t = 0; t < 160; t++) {
    const job = await runWithCourse(course, () => jobs.getJob(id));
    if (job && !["queued", "running", "verifying", "compiling"].includes(job.status)) return job;
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`job ${id} jamais terminé`);
}

async function sourcesOf(course: string) {
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  return runWithCourse(course, () => q.all<{ path: string; type: string; year: number | null }>(`SELECT path, type, year FROM sources ORDER BY path, id`));
}

async function examCount(course: string): Promise<number> {
  const { runWithCourse } = await import("../db/client");
  const { pastExamCount } = await import("../lib/sources");
  return runWithCourse(course, () => pastExamCount());
}

test("un support classé comme annale devient une annale (année, partiel), réindexée par le job, sans doublon", async () => {
  const c = await newCourse("Orvelle reclasser annale");
  fs.writeFileSync(path.join(c.contentRoot, "lectures", "revision-orvelle.pdf"), textPdf("Partiel Orvelle, exercice 1 : amortissement"));
  assert.equal(ingest(c.id).status, 0);
  assert.equal(await examCount(c.id), 0);

  const r = await classify(c.id, { path: "lectures/revision-orvelle.pdf", as: "exam", kind: "midterm", year: 2020 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.path, "refs/revision-orvelle.pdf");
  assert.equal(typeof r.json.jobId, "number");
  const job = await waitJob(c.id, r.json.jobId);
  assert.equal(job.status, "done", JSON.stringify(job));
  assert.equal(job.type, "ingest");
  // Gratuit : le job ne porte aucun débit de crédits (référence de réservation payante).
  const { q } = await import("../db/q");
  const { runWithCourse: inCourse } = await import("../db/client");
  const row = await inCourse(c.id, () => q.get<{ credit_ref: string | null }>(`SELECT credit_ref FROM jobs WHERE id = ?`, r.json.jobId));
  assert.equal(row?.credit_ref, null);

  assert.deepEqual(await sourcesOf(c.id), [{ path: "refs/revision-orvelle.pdf", type: "midterm", year: 2020 }]);
  assert.equal(await examCount(c.id), 1);
  assert.ok(fs.existsSync(path.join(c.refsDir, "revision-orvelle.pdf")));
  assert.ok(!fs.existsSync(path.join(c.contentRoot, "lectures", "revision-orvelle.pdf")));

  // L'année et le type choisis tiennent à l'ingestion suivante (le nom du fichier n'en dit rien).
  assert.equal(ingest(c.id).status, 0);
  assert.deepEqual(await sourcesOf(c.id), [{ path: "refs/revision-orvelle.pdf", type: "midterm", year: 2020 }]);
  const { runWithCourse } = await import("../db/client");
  const { listExamSources } = await import("../lib/sources");
  const exams = await runWithCourse(c.id, () => listExamSources());
  assert.deepEqual(exams.map((e) => [e.path, e.kind, e.year, e.isReference]), [["refs/revision-orvelle.pdf", "midterm", 2020, true]]);
});

test("une annale classée comme support quitte les annales et devient un support de cours", async () => {
  const c = await newCourse("Orvelle reclasser support");
  fs.writeFileSync(path.join(c.refsDir, "final-2022.pdf"), textPdf("Chapitre 3 : les ondes de Orvelle"));
  fs.writeFileSync(path.join(c.refsDir, "final-2023.pdf"), textPdf("Final 2023, exercice 1"));
  assert.equal(ingest(c.id).status, 0);
  assert.equal(await examCount(c.id), 2);

  const r = await classify(c.id, { path: "refs/final-2022.pdf", as: "support" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.path, "lectures/final-2022.pdf");
  assert.equal((await waitJob(c.id, r.json.jobId)).status, "done");

  assert.deepEqual(await sourcesOf(c.id), [
    { path: "lectures/final-2022.pdf", type: "course_pdf", year: null },
    { path: "refs/final-2023.pdf", type: "final", year: 2023 },
  ]);
  assert.equal(await examCount(c.id), 1);
  const { runWithCourse } = await import("../db/client");
  const { referencePaths } = await import("../lib/sources");
  assert.deepEqual(await runWithCourse(c.id, () => referencePaths()), ["refs/final-2023.pdf"]);
});

test("une annale déjà rangée : seule son année et son type changent, au même chemin", async () => {
  const c = await newCourse("Orvelle reclasser année");
  fs.writeFileSync(path.join(c.refsDir, "final-2022.pdf"), textPdf("Final 2022, exercice 1"));
  assert.equal(ingest(c.id).status, 0);

  const r = await classify(c.id, { path: "refs/final-2022.pdf", as: "exam", kind: "midterm", year: 2019 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.path, "refs/final-2022.pdf");
  assert.equal((await waitJob(c.id, r.json.jobId)).status, "done");
  assert.deepEqual(await sourcesOf(c.id), [{ path: "refs/final-2022.pdf", type: "midterm", year: 2019 }]);
});

test("même nom déjà pris dans la catégorie visée : le fichier reclassé prend un nom libre, rien n'est écrasé", async () => {
  const c = await newCourse("Orvelle reclasser nom");
  fs.writeFileSync(path.join(c.refsDir, "serie.pdf"), textPdf("Final 2021, exercice 1"));
  fs.writeFileSync(path.join(c.contentRoot, "lectures", "serie.pdf"), textPdf("Partiel 2020 Orvelle"));
  assert.equal(ingest(c.id).status, 0);

  const r = await classify(c.id, { path: "lectures/serie.pdf", as: "exam", kind: "midterm", year: 2020 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.path, "refs/serie-2.pdf");
  assert.equal((await waitJob(c.id, r.json.jobId)).status, "done");
  assert.deepEqual((await sourcePaths(c.id)), ["refs/serie-2.pdf", "refs/serie.pdf"]);
});

test("refus : chemin inconnu, catégorie ou année invalide, chemin hors du cours", async () => {
  const c = await newCourse("Orvelle reclasser refus");
  fs.writeFileSync(path.join(c.contentRoot, "lectures", "cours.pdf"), textPdf("Cours Orvelle"));
  assert.equal(ingest(c.id).status, 0);

  assert.equal((await classify(c.id, { path: "lectures/absent.pdf", as: "exam", kind: "final", year: 2020 })).status, 404);
  assert.equal((await classify(c.id, { path: "lectures/cours.pdf", as: "poster" })).status, 400);
  assert.equal((await classify(c.id, { path: "lectures/cours.pdf", as: "exam", kind: "quiz", year: 2020 })).status, 400);
  assert.equal((await classify(c.id, { path: "lectures/cours.pdf", as: "exam", kind: "final", year: 1700 })).status, 400);
  assert.equal((await classify(c.id, { path: "../../secret.pdf", as: "exam", kind: "final", year: 2020 })).status, 404);
  const en = await classify(c.id, { path: "lectures/absent.pdf", as: "support" }, "en");
  assert.equal(en.status, 404);
  assert.match(en.json.error, /file/i);
  // Rien n'a bougé.
  assert.deepEqual(await sourcePaths(c.id), ["lectures/cours.pdf"]);
});

test("cours au contenu en lecture seule (cs-202) : rien n'est reclassé (409)", async () => {
  const r = await classify("cs-202", { path: "refs/final-2023.pdf", as: "support" });
  assert.equal(r.status, 409, JSON.stringify(r.json));
});

test("une ingestion déjà en cours : le reclassement attend (409), rien ne bouge", async () => {
  const c = await newCourse("Orvelle reclasser occupé");
  fs.writeFileSync(path.join(c.contentRoot, "lectures", "cours.pdf"), textPdf("Cours Orvelle"));
  assert.equal(ingest(c.id).status, 0);
  const { runWithCourse } = await import("../db/client");
  const jobs = await import("../lib/jobs");
  await runWithCourse(c.id, () => jobs.createJobExclusive("ingest"));

  const r = await classify(c.id, { path: "lectures/cours.pdf", as: "exam", kind: "final", year: 2020 });
  assert.equal(r.status, 409, JSON.stringify(r.json));
  assert.ok(fs.existsSync(path.join(c.contentRoot, "lectures", "cours.pdf")));
});

test("compte gratuit, original resté sur l'ordinateur : l'index est reclassé sur place et survit au job", async () => {
  const c = await newCourse("Orvelle reclasser local");
  const file = path.join(c.contentRoot, "lectures", "partiel-scan.pdf");
  fs.writeFileSync(file, textPdf("Partiel Orvelle 2018, exercice 2"));
  assert.equal(ingest(c.id).status, 0);
  // L'original part du serveur : Cortex n'en garde que l'index (lib/originals).
  const { runWithCourse } = await import("../db/client");
  const { recordLocal } = await import("../lib/originals/registry");
  await runWithCourse(c.id, () => recordLocal({ path: "lectures/partiel-scan.pdf", name: "partiel-scan.pdf", sha256: "0".repeat(64), size: 10, origin: "upload" }));
  fs.rmSync(file);

  const r = await classify(c.id, { path: "lectures/partiel-scan.pdf", as: "exam", kind: "midterm", year: 2018 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.path, "refs/partiel-scan.pdf");
  assert.equal((await waitJob(c.id, r.json.jobId)).status, "done");
  assert.deepEqual(await sourcesOf(c.id), [{ path: "refs/partiel-scan.pdf", type: "midterm", year: 2018 }]);
  assert.equal(await examCount(c.id), 1);
  const { localOriginal } = await import("../lib/originals/registry");
  assert.equal((await runWithCourse(c.id, () => localOriginal("refs/partiel-scan.pdf")))?.state, "local");
});
