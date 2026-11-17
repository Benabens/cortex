/**
 * OUVRIR UN ORIGINAL RESTÉ SUR L'ORDINATEUR (compte gratuit) : dans le dossier choisi par
 * l'étudiant, le fichier est retrouvé par son nom puis confirmé par sa taille et son empreinte.
 * Seam : findLocalFile (lib/ux/local-file), sur un faux dossier File System Access.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { findLocalFile, viewableType, type DirHandle, type FileHandle } from "../lib/ux/local-file";

const file = (name: string, body: string): FileHandle => ({ kind: "file", name, getFile: async () => new File([body], name) });
const dir = (name: string, children: (DirHandle | FileHandle)[]): DirHandle => ({
  kind: "directory", name, values: async function* () { yield* children; },
});
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const wanted = (body: string) => ({ name: "Cours 1.pdf", rel: "Semaine 1/Cours 1.pdf", path: "lectures/Cours_1.pdf", size: Buffer.byteLength(body), sha256: sha(body) });

test("retrouvé dans un sous-dossier, par son nom d'origine et son empreinte", async () => {
  const root = dir("ML", [file("autre.pdf", "x"), dir("Semaine 1", [file("Cours 1.pdf", "le vrai cours")])]);
  const r = await findLocalFile(root, wanted("le vrai cours"));
  assert.equal(r.status, "found");
  assert.equal(r.status === "found" && r.where, "Semaine 1/Cours 1.pdf");
});

test("même nom mais contenu modifié depuis l'import : signalé, jamais pris pour le bon fichier", async () => {
  const root = dir("ML", [file("Cours 1.pdf", "une autre version")]);
  assert.deepEqual(await findLocalFile(root, wanted("le vrai cours")), { status: "changed", where: "Cours 1.pdf" });
});

test("absent du dossier choisi", async () => {
  assert.deepEqual(await findLocalFile(dir("ML", [file("x.pdf", "y")]), wanted("le vrai cours")), { status: "missing" });
});

test("une page HTML ou un document Office ne s'ouvre jamais dans l'app (aucun script importé n'y tourne)", () => {
  assert.equal(viewableType("cours.pdf"), "application/pdf");
  assert.equal(viewableType("page.html"), null);
  assert.equal(viewableType("td.docx"), null);
});
