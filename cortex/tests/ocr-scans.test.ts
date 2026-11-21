/**
 * OCR des PDF scannés (suite de l'audit ingestion du 16/11/2026, P1-4, décision du 21/11) : un PDF
 * sans couche texte est rendu en image (pdftoppm) et lu par tesseract, en local et sans appel
 * payant, dans le job d'ingestion. Le texte lu est indexé comme le reste, marqué « ocr ».
 * Les scans sont fabriqués ici : texte écrit, rendu en image, remis seul dans un PDF.
 *
 * Sans tesseract ni pdftoppm (poste de dev), la suite est sautée ; la CI les installe et la rend
 * obligatoire (CI=true).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { imagePdf, noiseImage, scanImage, scannedPdf, textPdf } from "./helpers/pdf";
import { ingest, newCourse } from "./helpers/ingest-course";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-ocr-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";
// Opt-in, comme dans l'image Docker : hérité par le script d'ingestion et par le worker.
process.env.CORTEX_OCR = "1";

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  delete process.env.MAX_COURSES_CREATED_PER_HOUR;
  delete process.env.CORTEX_OCR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function has(bin: string, arg: string): boolean {
  try { execFileSync(bin, [arg], { stdio: "ignore" }); return true; } catch { return false; }
}
const tools = has("tesseract", "--version") && (has("pdftoppm", "-v") || fs.existsSync("/opt/homebrew/bin/pdftoppm"));
if (!tools && process.env.CI) throw new Error("CI : tesseract et pdftoppm sont requis par la suite OCR");
const skip = tools ? false : "tesseract ou pdftoppm absent";

const SCAN = ["Exercise 1. Orvelle waves and their damping.", "Compute the decay rate of the amplitude."];

async function itemsOf(course: string, file: string): Promise<{ text: string; tags: string | null }[]> {
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  return runWithCourse(course, () => q.all<{ text: string; tags: string | null }>(
    `SELECT i.text, i.tags FROM items i JOIN sources s ON s.id = i.source_id WHERE s.path = ? ORDER BY i.id`, file,
  ));
}

test("un support scanné est lu par OCR, indexé, et ses passages sont marqués ocr", { skip }, async () => {
  const c = await newCourse("Orvelle scan support");
  fs.writeFileSync(path.join(c.contentRoot, "lectures", "chapitre-scanne.pdf"), scannedPdf([SCAN]));

  const r = ingest(c.id);
  assert.equal(r.status, 0, r.output);
  assert.equal(r.files?.find((f) => f.path === "lectures/chapitre-scanne.pdf")?.status, "indexed", r.output);
  const items = await itemsOf(c.id, "lectures/chapitre-scanne.pdf");
  assert.equal(items.length, 1);
  assert.match(items[0].text, /Orvelle waves/);
  assert.match(items[0].text, /decay rate/);
  assert.deepEqual(JSON.parse(items[0].tags ?? "null"), ["ocr"]);

  // Et la recherche du cours le trouve, comme tout passage indexé.
  const { runWithCourse } = await import("../db/client");
  const { rankedHits } = await import("../lib/search");
  const hits = await runWithCourse(c.id, () => rankedHits("amplitude decay", 5));
  assert.ok(hits.some((h) => h.sourcePath === "lectures/chapitre-scanne.pdf"), JSON.stringify(hits));
});

test("une annale scannée est lue et comptée comme annale", { skip }, async () => {
  const c = await newCourse("Orvelle scan annale");
  fs.writeFileSync(path.join(c.refsDir, "final-2021.pdf"), scannedPdf([SCAN]));
  fs.writeFileSync(path.join(c.refsDir, "final-2022.pdf"), textPdf("Final 2022, exercice 1"));

  const r = ingest(c.id);
  assert.equal(r.status, 0, r.output);
  assert.equal(r.files?.find((f) => f.path === "refs/final-2021.pdf")?.status, "indexed", r.output);
  const { runWithCourse } = await import("../db/client");
  const { pastExamCount, listExamSources } = await import("../lib/sources");
  assert.equal(await runWithCourse(c.id, () => pastExamCount()), 2);
  const scan = (await runWithCourse(c.id, () => listExamSources())).find((e) => e.path === "refs/final-2021.pdf");
  assert.equal(scan?.items, 1);
  assert.deepEqual(JSON.parse((await itemsOf(c.id, "refs/final-2021.pdf"))[0].tags ?? "null"), ["ocr"]);
});

test("seule la page sans texte d'un PDF passe par l'OCR ; une page de texte garde sa couche texte", { skip }, async () => {
  const c = await newCourse("Orvelle scan mixte");
  // Deux pages : la première a une couche texte, la seconde est un scan.
  fs.writeFileSync(path.join(c.contentRoot, "lectures", "mixte.pdf"), imagePdf([{ text: "Typed introduction to Orvelle systems" }, scanImage(SCAN)]));
  const r = ingest(c.id);
  assert.equal(r.status, 0, r.output);
  const items = await itemsOf(c.id, "lectures/mixte.pdf");
  assert.deepEqual(items.map((i) => [i.text, JSON.parse(i.tags ?? "null")]), [
    ["Typed introduction to Orvelle systems", null],
    [items[1]?.text, ["ocr"]],
  ]);
  assert.match(items[1].text, /decay rate/);
});

test("un scan qui ne rend que du bruit garde l'alerte « sans texte »", { skip }, async () => {
  const c = await newCourse("Orvelle scan bruit");
  fs.writeFileSync(path.join(c.contentRoot, "lectures", "bruit.pdf"), imagePdf([noiseImage(600, 780)]));
  fs.writeFileSync(path.join(c.contentRoot, "lectures", "blanc.pdf"), scannedPdf([null]));

  const r = ingest(c.id);
  assert.equal(r.status, 0, r.output);
  const status = Object.fromEntries((r.files ?? []).map((f) => [f.path, f.status]));
  assert.deepEqual(status, { "lectures/blanc.pdf": "no_text", "lectures/bruit.pdf": "no_text" });
});

test("bornes : au-delà du nombre de pages permis, l'OCR s'arrête et le dit", { skip }, async () => {
  const c = await newCourse("Orvelle scan long");
  fs.writeFileSync(path.join(c.contentRoot, "lectures", "long.pdf"), scannedPdf([SCAN, ["Second page about Orvelle resonance frequencies here."]]));

  const r = ingest(c.id, { CORTEX_OCR_MAX_PAGES: "1" });
  assert.equal(r.status, 0, r.output);
  const items = await itemsOf(c.id, "lectures/long.pdf");
  assert.equal(items.length, 1, JSON.stringify(items));
  assert.match(items[0].text, /decay rate/);
  assert.match(r.output, /OCR.*1 page/);
});

test("sans CORTEX_OCR=1 (hors de l'image), l'OCR reste éteint : le scan reste signalé sans texte", { skip }, async () => {
  const c = await newCourse("Orvelle scan coupe");
  fs.writeFileSync(path.join(c.refsDir, "final-2021.pdf"), scannedPdf([SCAN]));
  const r = ingest(c.id, { CORTEX_OCR: "" });
  assert.equal(r.status, 0, r.output);
  assert.equal(r.files?.find((f) => f.path === "refs/final-2021.pdf")?.status, "no_text");
});

test("zone Annales : une annale scannée déposée lance le job d'ingestion, qui la lit par OCR et la compte", { skip }, async () => {
  const c = await newCourse("Orvelle scan déposé");
  const { postForm } = await import("./helpers/route");
  const r = await postForm("refs/upload", `course=${c.id}`, [[scannedPdf([SCAN]), "final-2021.pdf"]]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.files, ["final-2021.pdf"]);
  // La requête ne fait pas l'OCR : le scan est encore sans texte, et le job est lancé.
  assert.equal(typeof r.json.jobId, "number", JSON.stringify(r.json));
  const { runWithCourse } = await import("../db/client");
  const jobs = await import("../lib/jobs");
  const { pastExamCount } = await import("../lib/sources");
  let job = null;
  for (let t = 0; t < 120; t++) {
    job = await runWithCourse(c.id, () => jobs.getJob(r.json.jobId));
    if (job && !["queued", "running", "verifying", "compiling"].includes(job.status)) break;
    await new Promise((res) => setTimeout(res, 250));
  }
  assert.equal(job?.status, "done", JSON.stringify(job));
  assert.deepEqual(job?.report?.files.map((f) => [f.path, f.status]), [["refs/final-2021.pdf", "indexed"]]);
  assert.equal(await runWithCourse(c.id, () => pastExamCount()), 1);
});

test("zone Annales : une annale au texte lisible ne lance aucun job", async () => {
  const c = await newCourse("Orvelle texte déposé");
  const { postForm } = await import("./helpers/route");
  const r = await postForm("refs/upload", `course=${c.id}`, [[textPdf("Final 2022, exercice 1"), "final-2022.pdf"]]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.jobId, undefined);
});
