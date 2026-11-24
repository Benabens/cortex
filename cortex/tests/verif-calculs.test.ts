/**
 * RECALCUL DÉTERMINISTE DES CORRIGÉS (lib/verify-arith) — banc du 23/11/2026 : des corrigés
 * d'examen et de drill livraient des égalités fausses écrites en clair (« goulots mal recopiés »,
 * sommes de trous, traductions d'adresses). Toute égalité « a op b … = c » entièrement numérique
 * (décimal, virgule française, hexadécimal, \times, \frac) est recalculée ; une égalité qui ne se
 * laisse pas lire sans doute (unités, indices, exposants, milliers séparés par une espace) est ignorée.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { arithmeticSlips, missingSubquestions } from "../lib/verify-arith";

test("une égalité juste n'est pas signalée, une fausse l'est avec la bonne valeur", () => {
  assert.deepEqual(arithmeticSlips(String.raw`$T_1 = 3 \times 1{,}5 + 3 \times 0{,}9 = 7{,}2$ ms`), []);
  assert.deepEqual(arithmeticSlips("Les trous valent 150+37+29=216 octets."), []);
  const [s] = arithmeticSlips("Les trous valent 150+37+29=226 octets.");
  assert.equal(s.claimed, "226");
  assert.equal(s.actual, "216");
  assert.equal(arithmeticSlips("2 + 2 = 5").length, 1);
  assert.equal(arithmeticSlips("Flot maximal : 6 + 2 + 3 = 12.").length, 1, "point final de phrase");
});

test("hexadécimal, moins Unicode, gras et milliers à espace fine", () => {
  assert.deepEqual(arithmeticSlips(String.raw`$\texttt{0x3A40} + \texttt{0x1A07}$ : 0x3A40 + 0x1A07 = 0x5447`), []);
  assert.equal(arithmeticSlips("0x3A40 + 0x1A07 = 0x5457")[0]?.actual, "0x5447");
  assert.deepEqual(arithmeticSlips("0x1C2C−0x1900=812"), []);
  assert.deepEqual(arithmeticSlips(String.raw`soit $9040 - 6688 = \textbf{2352}$ octets`), []);
  assert.deepEqual(arithmeticSlips(String.raw`$31\,584 + 900 = 32\,484$`), []);
  assert.equal(arithmeticSlips(String.raw`$31\,584 + 900 = 32\,584$`).length, 1);
});

test("arrondis, fractions et parenthèses", () => {
  assert.deepEqual(arithmeticSlips("1/3 = 0.33"), []);
  assert.deepEqual(arithmeticSlips("2/3 = 0,66"), [], "une troncature au dernier chiffre n'est pas une erreur");
  assert.equal(arithmeticSlips("2/3 = 0.5").length, 1);
  assert.equal(arithmeticSlips(String.raw`$3 \times 0{,}4 = 1{,}3$`).length, 1, "un écart d'un chiffre sur la dernière décimale est une erreur");
  assert.deepEqual(arithmeticSlips("0.1 + 0.2 = 0.3"), [], "pas de faux écart dû aux flottants");
  assert.deepEqual(arithmeticSlips("4.0455/1.6189 = 2.4990"), [], "opérandes déjà arrondis");
  assert.deepEqual(arithmeticSlips(String.raw`$\frac{3}{4} \times 8 = 6$`), []);
  assert.equal(arithmeticSlips(String.raw`$\tfrac{3}{4} \times 8 = 7$`).length, 1);
  assert.deepEqual(arithmeticSlips(String.raw`$(2+3) \cdot 4 = 20$ et $5 - 7 = -2$`), []);
});

test("une égalité qu'on ne sait pas lire sans doute n'est jamais signalée", () => {
  for (const ok of [
    "x_1 + 2 = 5", // indice
    "f(2) + 3 = 7", // fonction
    String.raw`$10 \times 2^{3} = 80$`, // exposant
    "1,5 ms + 2 ms = 9 ms", // unités dans l'expression
    "on obtient 2 + 3 = 4 380 octets", // milliers séparés par une espace
    "192.168.1.10 + 1 = 7", // adresse IP
    "a = 3 = 4", // aucun opérateur
    "2 + 3 \\approx 9", // approximation
    "2 + 3 = 5 + 4", // le membre de droite est une expression
  ]) assert.deepEqual(arithmeticSlips(ok), [], ok);
});

test("corrigé HTML d'un drill : exposants et entités", () => {
  assert.deepEqual(arithmeticSlips("x = 1.4·10<sup>&minus;10</sup> = 5"), [], "l'exposant n'est pas aplati en « 10 −10 »");
  assert.deepEqual(arithmeticSlips("<li>b ← &minus;0.5 &minus; 0.2&middot;0.875 = <strong>&minus;0.675</strong></li>"), []);
  assert.equal(arithmeticSlips("<td>flot</td><td>8 + 3 + 6 = 18</td>").length, 1);
  assert.deepEqual(arithmeticSlips("5.2/6.5 = 80 %"), [], "pourcentage");
});

test("les égalités en chaîne sont toutes recalculées", () => {
  assert.deepEqual(arithmeticSlips("x = 5 + 3 = 8"), []);
  assert.equal(arithmeticSlips("x = 5 + 3 = 9")[0]?.expr, "5 + 3");
});

test("sous-questions de l'énoncé sans réponse dans le corrigé", () => {
  const statement = String.raw`\subq{1.1}{A}{3} … \subq{1.2}{B}{3} … \subq{1.6}{C}{4} …`;
  assert.deepEqual(missingSubquestions(statement, String.raw`\subq{1.1}{A} x. \subq{1.2}{B} y. \subq{1.6}{C} z.`), []);
  assert.deepEqual(missingSubquestions(statement, String.raw`\textbf{1.1} x. \textbf{1.2} y. Fin.`), ["1.6"]);
  assert.deepEqual(missingSubquestions("Énoncé sans sous-question.", "Corrigé."), []);
});
