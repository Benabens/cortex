/**
 * COMPTE GRATUIT, ORIGINAUX SUR L'ORDINATEUR (décision de Ben du 17/11/2026) — l'ingestion.
 *
 * Un support déposé par un gratuit transite sur le serveur le temps d'en extraire le texte, puis
 * il est supprimé : seul l'index reste. Une annale PDF attend la préparation du cours (lecture
 * des pages en image), 24 h au plus. La ré-ingestion reconstruit le corpus depuis le disque :
 * les sources dont l'original est resté sur l'ordinateur y sont recopiées depuis l'index, jamais
 * perdues. Le vrai script d'ingestion, sur un cours fictif, facturation active (compte gratuit).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { textPdf } from "./helpers/pdf";
import { ingest, newCourse, sourcePaths } from "./helpers/ingest-course";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-originaux-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";
process.env.BILLING_ENABLED = "1";
process.env.STORAGE_QUOTA_MB = "unlimited";
delete process.env.CORTEX_OWNER_EMAIL;
delete process.env.CORTEX_OWNER_USER_ID;

after(() => {
  for (const k of ["CORTEX_DATA_DIR", "MAX_COURSES_CREATED_PER_HOUR", "BILLING_ENABLED", "STORAGE_QUOTA_MB"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

let intake: typeof import("../lib/originals/intake");
let registry: typeof import("../lib/originals/registry");
before(async () => {
  intake = await import("../lib/originals/intake");
  registry = await import("../lib/originals/registry");
});

async function inCourse<T>(course: string, fn: () => Promise<T>): Promise<T> {
  const { runWithCourse } = await import("../db/client");
  return runWithCourse(course, fn);
}

async function itemTexts(course: string): Promise<string[]> {
  const { q } = await import("../db/q");
  return inCourse(course, async () => (await q.all<{ text: string }>(`SELECT text FROM items ORDER BY text`)).map((r) => r.text));
}

test("gratuit : le texte du support est indexé, l'original supprimé ; la ré-ingestion garde l'index sans lui", async () => {
  const c = await newCourse("Orvelle gratuit");
  const lectures = path.join(c.contentRoot, "lectures");
  const saved = await inCourse(c.id, () => intake.storeOriginal(c.id, lectures, "Cours_1.pdf", textPdf("Les ondes de Orvelle amorties"), { originalName: "Cours 1.pdf", rel: "Semaine 1/Cours 1.pdf" }));
  assert.equal(saved?.home, "local");
  assert.equal(saved?.name, "Cours_1.pdf");

  const r1 = ingest(c.id);
  assert.equal(r1.status, 0, r1.output);
  assert.equal(fs.existsSync(path.join(lectures, "Cours_1.pdf")), false, "l'original ne reste pas sur le serveur");
  assert.deepEqual(await sourcePaths(c.id), ["lectures/Cours_1.pdf"]);
  const row = await inCourse(c.id, () => registry.localOriginal("lectures/Cours_1.pdf"));
  assert.equal(row?.state, "local");
  assert.equal(row?.name, "Cours 1.pdf", "nom d'origine gardé pour retrouver le fichier sur l'ordinateur");
  assert.equal(row?.rel, "Semaine 1/Cours 1.pdf");
  assert.match(row?.sha256 ?? "", /^[0-9a-f]{64}$/);

  // Un autre support arrive ; la ré-ingestion relit le disque : l'index du premier est conservé.
  await inCourse(c.id, () => intake.storeOriginal(c.id, lectures, "Cours_2.pdf", textPdf("La dispersion de Orvelle"), {}));
  const r2 = ingest(c.id);
  assert.equal(r2.status, 0, r2.output);
  assert.deepEqual(await sourcePaths(c.id), ["lectures/Cours_1.pdf", "lectures/Cours_2.pdf"]);
  const texts = await itemTexts(c.id);
  assert.ok(texts.some((t) => t.includes("ondes de Orvelle")), texts.join(" | "));
  assert.ok(texts.some((t) => t.includes("dispersion")), texts.join(" | "));

  // Recherche : l'index recopié reste trouvable.
  const { search } = await import("../lib/search");
  const hits = await inCourse(c.id, () => search("ondes Orvelle", 5));
  assert.ok(hits.some((g) => g.hits.some((h) => h.sourcePath === "lectures/Cours_1.pdf")), JSON.stringify(hits));
});

test("gratuit : une annale PDF attend la préparation du cours (lecture des pages en image), puis part", async () => {
  const c = await newCourse("Orvelle annale");
  await inCourse(c.id, () => intake.storeOriginal(c.id, c.refsDir, "Final_2024.pdf", textPdf("Exercice 1 du final 2024"), { originalName: "Final 2024.pdf" }));
  const r = ingest(c.id);
  assert.equal(r.status, 0, r.output);
  const pdf = path.join(c.refsDir, "Final_2024.pdf");
  assert.equal(fs.existsSync(pdf), true, "gardée en transit pour la préparation");
  assert.equal((await inCourse(c.id, () => registry.localOriginal("refs/Final_2024.pdf")))?.state, "transit");

  await inCourse(c.id, () => intake.settleOriginals({ after: "prepare" }));
  assert.equal(fs.existsSync(pdf), false, "préparation finie : l'annale ne reste pas sur le serveur");
  assert.equal((await inCourse(c.id, () => registry.localOriginal("refs/Final_2024.pdf")))?.state, "local");
  const again = ingest(c.id);
  assert.equal(again.status, 0, again.output);
  assert.deepEqual(await sourcePaths(c.id), ["refs/Final_2024.pdf"], "l'annale reste au corpus sans son fichier");
});

test("gratuit : un original oublié en transit (préparation jamais lancée) part après 24 h", async () => {
  const c = await newCourse("Orvelle oubli");
  await inCourse(c.id, () => intake.storeOriginal(c.id, c.refsDir, "final-2023.pdf", textPdf("Exercice 1 du final 2023"), {}));
  assert.equal(ingest(c.id).status, 0);
  const { q } = await import("../db/q");
  await inCourse(c.id, () => q.run(`UPDATE local_originals SET arrived_at = ? WHERE path = ?`, "2026-01-01 00:00:00", "refs/final-2023.pdf"));
  await inCourse(c.id, () => intake.settleOriginals({ after: "expiry" }));
  assert.equal(fs.existsSync(path.join(c.refsDir, "final-2023.pdf")), false);
  assert.deepEqual(await sourcePaths(c.id), ["refs/final-2023.pdf"], "l'index reste");
});

test("Premium (facturation coupée) : rien ne change, l'original reste et aucune ligne n'est créée", async () => {
  process.env.BILLING_ENABLED = "";
  try {
    const c = await newCourse("Orvelle premium");
    const lectures = path.join(c.contentRoot, "lectures");
    const saved = await inCourse(c.id, () => intake.storeOriginal(c.id, lectures, "cours.pdf", textPdf("Le spectre de Orvelle"), {}));
    assert.equal(saved?.home, "cloud");
    const r = ingest(c.id, { BILLING_ENABLED: "" });
    assert.equal(r.status, 0, r.output);
    assert.equal(fs.existsSync(path.join(lectures, "cours.pdf")), true);
    assert.deepEqual(await inCourse(c.id, () => registry.localOriginals()), []);
  } finally {
    process.env.BILLING_ENABLED = "1";
  }
});

test("devenu Premium : réimporter le même fichier le remet dans le cloud, sans doublon ni nouvel index", async () => {
  const c = await newCourse("Orvelle retour");
  const lectures = path.join(c.contentRoot, "lectures");
  const pdf = textPdf("Les modes propres de Orvelle");
  await inCourse(c.id, () => intake.storeOriginal(c.id, lectures, "modes.pdf", pdf, {}));
  assert.equal(ingest(c.id).status, 0);
  assert.equal(fs.existsSync(path.join(lectures, "modes.pdf")), false);

  process.env.BILLING_ENABLED = ""; // plus de compte gratuit : comme un Premium
  try {
    const other = await inCourse(c.id, () => intake.storeOriginal(c.id, lectures, "modes.pdf", textPdf("Autre chose"), {}));
    assert.equal(other?.name, "modes-2.pdf", "un autre contenu ne prend pas la place de l'original resté en local");
    const back = await inCourse(c.id, () => intake.storeOriginal(c.id, lectures, "modes.pdf", pdf, {}));
    assert.deepEqual([back?.name, back?.restored, back?.home], ["modes.pdf", true, "cloud"]);
    assert.equal(fs.existsSync(path.join(lectures, "modes.pdf")), true);
    assert.equal(await inCourse(c.id, () => registry.localOriginal("lectures/modes.pdf")), null);
  } finally {
    process.env.BILLING_ENABLED = "1";
  }
});
