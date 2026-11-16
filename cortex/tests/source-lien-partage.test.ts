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

  // Une page courte qui parle de « connexion » (réseau) n'est pas une page de connexion.
  const tcp = `<html><head><title>TCP</title></head><body><p>${"Une connexion TCP s’ouvre par une poignée de main en trois temps. ".repeat(6)}</p></body></html>`;
  const net = await add(c.id, "https://cours.example.org/tcp.html", tcp, "text/html");
  assert.ok(!(net.saved instanceof Error), (net.saved as Error).message);

  const form = `<html><head><title>Moodle</title></head><body><form><input name="u"><input type="password" name="p"></form><p>${"Bienvenue sur la plateforme de cours de l’université. ".repeat(6)}</p></body></html>`;
  const { saved: refused } = await add(c.id, "https://moodle.example.org/login/index.php", form, "text/html");
  assert.ok(refused instanceof Error && /connexion/.test(refused.message));

  const page = `<html><body><main><h1>Ondes</h1><p>${"Une onde se propage dans un milieu élastique. ".repeat(20)}</p></main></body></html>`;
  const ok = await add(c.id, "https://cours.example.org/ondes.html", page, "text/html");
  assert.ok(!(ok.saved instanceof Error), (ok.saved as Error).message);
});

test("lien de partage : la redirection vers l'hôte de téléchargement du service est suivie, une autre non", async () => {
  const c = await newCourse("Orvelle redirections");
  const { addUrlSource } = await import("../lib/course-source");
  const { PublicFetchError } = await import("../lib/public-https");
  const pdf = textPdf("Chapitre 2 : les ondes");
  const via = (target: string) => {
    const asked: string[] = [];
    const fetcher = async (u: string) => {
      asked.push(u);
      if (u.startsWith("https://docs.google.com/")) throw new PublicFetchError("redirect", "redirection (HTTP 307)", target);
      return { body: pdf, contentType: "application/pdf", cacheControl: "" };
    };
    return { asked, run: () => addUrlSource(c.id, { url: "https://docs.google.com/document/d/1XyZ/edit", category: "lecture" }, fetcher).catch((e: Error) => e) };
  };
  const ok = via("https://doc-0s-4c-docs.googleusercontent.com/export/abc/def?format=pdf");
  const saved = await ok.run();
  assert.ok(!(saved instanceof Error), (saved as Error).message);
  assert.deepEqual(ok.asked, ["https://docs.google.com/document/d/1XyZ/export?format=pdf", "https://doc-0s-4c-docs.googleusercontent.com/export/abc/def?format=pdf"]);

  const bad = via("https://evil.example.org/x.pdf");
  const refused = await bad.run();
  assert.ok(refused instanceof Error && /redirige vers evil\.example\.org/.test(refused.message));
  assert.equal(bad.asked.length, 1);
  // Une adresse ordinaire qui redirige reste refusée, même vers un hôte Google.
  const { saved: plain } = await (async () => {
    const fetcher = async () => { throw new PublicFetchError("redirect", "redirection (HTTP 301)", "https://doc-0s-docs.googleusercontent.com/x"); };
    return { saved: await addUrlSource(c.id, { url: "https://cours.example.org/poly.pdf", category: "lecture" }, fetcher).catch((e: Error) => e) };
  })();
  assert.ok(plain instanceof Error && /redirige/.test(plain.message));
});
