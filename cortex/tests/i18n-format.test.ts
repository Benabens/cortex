/**
 * Nombres, prix et dates selon la langue de l'interface, à l'heure de Zurich (le fuseau de
 * l'app), au lieu des `fr-FR` / `fr-CH` écrits en dur (audit i18n #26, #27).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fmt } from "../lib/i18n/format";

const NBSP = " ";
const NNBSP = " ";

test("nombres : séparateurs de la langue, deux décimales au plus", () => {
  assert.equal(fmt("fr").number(12345.5).replace(NNBSP, " "), "12 345,5");
  assert.equal(fmt("en").number(12345.5), "12,345.5");
  assert.equal(fmt("fr").number(2.456), "2,46");
  assert.equal(fmt("en").number(3), "3");
});

test("prix : pas de décimales inutiles, centimes quand il y en a", () => {
  assert.equal(fmt("fr").price(14.9, "EUR"), `14,90${NBSP}€`);
  assert.equal(fmt("fr").price(119, "EUR"), `119${NBSP}€`);
  assert.equal(fmt("en").price(14.9, "EUR"), "€14.90");
  assert.equal(fmt("en").price(9, "CHF"), `CHF${NBSP}9`);
});

test("dates : jour, mois en toutes lettres, année — à Zurich, pas à l'heure du serveur", () => {
  // 23 h 30 UTC le 31 décembre = déjà le 1er janvier à Zurich.
  assert.equal(fmt("fr").date("2026-12-31T23:30:00Z"), "1 janvier 2027");
  assert.equal(fmt("en").date("2026-12-31T23:30:00Z"), "1 January 2027");
  assert.equal(fmt("fr").date("2026-11-17T10:00:00Z", "short"), "17 nov.");
  assert.equal(fmt("en").date("2026-11-17T10:00:00Z", "short"), "17 Nov");
});

test("heure : 24 h, à Zurich, et le fuseau peut être nommé", () => {
  assert.equal(fmt("fr").time("2026-11-17T13:05:00Z"), "14:05");
  assert.equal(fmt("en").time("2026-11-17T13:05:00Z"), "14:05");
  assert.equal(fmt("fr").dateTime("2026-11-17T13:05:00Z"), "17 novembre 2026 à 14:05");
  assert.equal(fmt("en").dateTime("2026-11-17T13:05:00Z"), "17 November 2026 at 14:05");
});

test("date SQL sans fuseau (« 2026-09-26 10:00:00 ») lue comme de l'UTC, date invalide rendue telle quelle", () => {
  assert.equal(fmt("fr").dateTime("2026-09-26 10:00:00"), "26 septembre 2026 à 12:00");
  assert.equal(fmt("fr").date("pas une date"), "pas une date");
});
