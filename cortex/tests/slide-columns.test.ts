/**
 * Banc HUM-285 du 15/11/2026 : une diapositive présentait trois études côte à côte, en colonnes.
 * Aplati ligne par ligne, son texte mêlait les colonnes et le résultat de la première étude était
 * prêté à la troisième (clé fausse, confirmée par la vérification à l'aveugle). Le bloc est désormais
 * relu colonne par colonne avant l'aplatissement ; un tableau à cellules courtes, du code aligné et
 * la prose ordinaire restent lus par ligne.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readColumns } from "@/lib/slide-columns";

const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/** Une ligne de diapositive à trois colonnes, alignées comme pdftotext les extrait. */
const row = (a: string, b = "", c = "") => `     ${a.padEnd(40)}${b.padEnd(38)}${c}`.trimEnd();
const SLIDE = [
  "TROIS ÉTUDES",
  "",
  row("MÉTA-ANALYSE", "TERRAIN · 4 PAYS", "NOTES COLLABORATIVES"),
  "",
  row("Effet modeste mais réel sur", "Le résultat tient aussi hors", "La diffusion baisse nettement"),
  row("la croyance. L'effet diminue quand", "d'Europe, en Asie et en", "après une note publiée. Limite :"),
  row("les convictions sont fortes.", "Afrique, pendant deux semaines.", "les notes arrivent tard."),
  "",
  row("Alpha et al. 2020", "Beta & Gamma 2021", "Delta et al. 2024"),
  "",
  "",
  "",
  "La correction fonctionne, mais elle court derrière le faux.",
].join("\n");

test("une diapositive en colonnes est relue colonne par colonne, chaque résultat suivi de son étude", () => {
  const out = flat(readColumns(SLIDE));
  assert.match(out, /L'effet diminue quand les convictions sont fortes\. Alpha et al\. 2020 TERRAIN/);
  assert.match(out, /en Asie et en Afrique, pendant deux semaines\. Beta & Gamma 2021/);
  assert.match(out, /Limite : les notes arrivent tard\. Delta et al\. 2024 La correction fonctionne/);
  assert.ok(out.startsWith("TROIS ÉTUDES MÉTA-ANALYSE Effet modeste"));
  // Aucun mot perdu ni ajouté.
  assert.deepEqual(out.split(" ").sort(), flat(SLIDE).split(" ").sort());
});

test("un tableau à cellules courtes reste lu par ligne", () => {
  const table = [
    "Étude              N        effet",
    "Alpha et al.       30       faible",
    "Beta & Gamma       4        moyen",
    "Delta et al.       12       fort",
  ].join("\n");
  assert.equal(readColumns(table), table);
});

test("du code aligné et la prose ordinaire ne bougent pas", () => {
  const code = ["x = load(path)      # lit le fichier", "y = clean(x)        # retire les doublons", "z = fit(y)          # entraîne le modèle"].join("\n");
  assert.equal(readColumns(code), code);
  const prose = "Une phrase ordinaire.  Deux espaces après le point.\nUne autre ligne, sans colonnes.";
  assert.equal(readColumns(prose), prose);
});
