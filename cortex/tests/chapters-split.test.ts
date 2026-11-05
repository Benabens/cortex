/**
 * Un polycopié d'un seul fichier, découpé en chapitres à l'ingestion — banc moteur du 04/11/2026
 * (synth-docx) : un DOCX de 8 chapitres donnait UN support, donc aucun plan, des notions tirées des
 * premières pages et 12 questions sur 12 dans le chapitre 1. Le découpage ne se fait que sur des
 * titres numérotés qui se suivent, assez espacés (une table des matières ne découpe rien).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { splitChapters } from "../lib/chapters";

const body = (n: number) => ` Contenu du chapitre ${n}, définitions et exemples chiffrés. `.repeat(80);

test("titres « Chapitre N » qui se suivent : un morceau par chapitre, avec son titre", () => {
  const text = [1, 2, 3, 4].map((n) => `Chapitre ${n} : Notions du thème ${n}\n${body(n)}`).join("\n");
  const parts = splitChapters(text);
  assert.equal(parts?.length, 4);
  assert.equal(parts![0].title, "Chapitre 1 : Notions du thème 1");
  assert.ok(parts![2].text.includes("Contenu du chapitre 3") && !parts![2].text.includes("Contenu du chapitre 4"));
});

test("table des matières en tête et renvois « voir chapitre 2 » : ne découpent pas", () => {
  const toc = "Sommaire. Chapitre 1 : Bases. Chapitre 2 : Méthodes. Chapitre 3 : Applications.\n";
  const text = toc + [1, 2, 3].map((n) => `Chapter ${n}: Topic ${n}\n${body(n)} (voir chapitre ${n + 1})`).join("\n");
  const parts = splitChapters(text);
  assert.equal(parts?.length, 3);
  assert.ok(parts![0].text.startsWith("Sommaire"), "la table des matières reste en tête du chapitre 1");
  assert.ok(parts![1].text.includes("Contenu du chapitre 2") && !parts![1].text.includes("Contenu du chapitre 1"));
});

test("document court, ou moins de trois chapitres : rien n'est découpé", () => {
  assert.equal(splitChapters("Chapitre 1 : A\nun peu de texte. Chapitre 2 : B\nencore. Chapitre 3 : C\nfin."), null);
  assert.equal(splitChapters(`Chapitre 1 : A\n${body(1)}Chapitre 2 : B\n${body(2)}`), null);
  assert.equal(splitChapters(body(1).repeat(5)), null);
});

test("pages d'un PDF : chaque page va au chapitre où elle commence", async () => {
  const { splitPages } = await import("../lib/chapters");
  const pages = [`Chapitre 1 : Bases ${body(1)}`, body(1), `Chapitre 2 : Méthodes ${body(2)}`, body(2), `Chapitre 3 : Cas ${body(3)}`];
  const parts = splitPages(pages);
  assert.deepEqual(parts?.map((p) => p.pages), [[0, 1], [2, 3], [4]]);
  assert.match(parts![1].title, /^Chapitre 2 : Méthodes/);
});
