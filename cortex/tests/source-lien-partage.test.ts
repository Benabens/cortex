/**
 * Lien de partage Google Drive, Docs ou Dropbox ajouté comme support : la page de visionneuse
 * (texte « Connexion ») était rangée comme support, et le lien de téléchargement refusé pour sa
 * redirection (audit ingestion du 16/11/2026). Le lien est réécrit vers le téléchargement direct,
 * et une page de connexion ou presque vide est refusée. Lecteur injecté : aucun appel réseau.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { newCourse } from "./helpers/ingest-course";
import { textPdf } from "./helpers/pdf";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-lien-partage-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";

after(() => {
  delete process.env.CORTEX_DATA_DIR;
  delete process.env.MAX_COURSES_CREATED_PER_HOUR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function add(course: string, url: string, body: Buffer | string, contentType: string) {
  const { addUrlSource } = await import("../lib/course-source");
  const asked: string[] = [];
  const fetcher = async (u: string) => { asked.push(u); return { body: Buffer.from(body), contentType, cacheControl: "" }; };
  const saved = await addUrlSource(course, { url, category: "lecture" }, fetcher).catch((e: Error & { status?: number }) => e);
  return { saved, asked };
}

test("les liens de partage sont lus à leur adresse de téléchargement direct", async () => {
  const c = await newCourse("Orvelle partages");
  const pdf = textPdf("Chapitre 1 : les ondes");
  const cases: [string, string][] = [
    ["https://drive.google.com/file/d/1AbC_dEf-123/view?usp=sharing", "https://drive.usercontent.google.com/download?id=1AbC_dEf-123&export=download&confirm=t"],
    ["https://drive.google.com/open?id=1AbC_dEf-123", "https://drive.usercontent.google.com/download?id=1AbC_dEf-123&export=download&confirm=t"],
    ["https://docs.google.com/document/d/1XyZ/edit#heading=h.1", "https://docs.google.com/document/d/1XyZ/export?format=pdf"],
    ["https://docs.google.com/presentation/d/1XyZ/edit", "https://docs.google.com/presentation/d/1XyZ/export/pdf"],
    ["https://www.dropbox.com/scl/fi/abc123/cours.pdf?rlkey=k9&dl=0", "https://dl.dropboxusercontent.com/scl/fi/abc123/cours.pdf?rlkey=k9"],
  ];
  for (const [shared, direct] of cases) {
    const { saved, asked } = await add(c.id, shared, pdf, "application/pdf");
    assert.ok(!(saved instanceof Error), `${shared} : ${(saved as Error).message}`);
    assert.deepEqual(asked, [direct], shared);
  }
});

test("une page de connexion ou presque vide n'est pas rangée comme support", async () => {
  const c = await newCourse("Orvelle connexion");
  const login = "<html><head><title>Cours - Google Drive</title></head><body><div>Connexion</div></body></html>";
  const { saved } = await add(c.id, "https://onedrive.live.com/view.aspx?id=1", login, "text/html");
  assert.ok(saved instanceof Error);
  assert.equal((saved as { status?: number }).status, 422);
  assert.match(saved.message, /connexion|presque pas de texte/i);
  assert.ok(!fs.existsSync(path.join(c.contentRoot, "lectures")) || fs.readdirSync(path.join(c.contentRoot, "lectures")).length === 0);

  const page = `<html><body><main><h1>Ondes</h1><p>${"Une onde se propage dans un milieu élastique. ".repeat(20)}</p></main></body></html>`;
  const ok = await add(c.id, "https://cours.example.org/ondes.html", page, "text/html");
  assert.ok(!(ok.saved instanceof Error), (ok.saved as Error).message);
});
