/**
 * Langue de l'interface : préférence du compte, sinon choix posé par le sélecteur
 * (cookie, aussi avant connexion), sinon Accept-Language, sinon anglais.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { negotiateLocale, resolveLocale } from "../lib/i18n/locale";

test("Accept-Language : la première langue livrée par ordre de qualité gagne", () => {
  assert.equal(negotiateLocale("fr-CH,fr;q=0.9,en;q=0.8"), "fr");
  assert.equal(negotiateLocale("en-US,en;q=0.9,fr;q=0.5"), "en");
  assert.equal(negotiateLocale("de-DE,de;q=0.9,fr;q=0.7,en;q=0.6"), "fr");
  // L'ordre d'écriture ne compte pas : seule la qualité tranche.
  assert.equal(negotiateLocale("en;q=0.4, fr;q=0.8"), "fr");
  assert.equal(negotiateLocale("FR-be"), "fr");
});

test("Accept-Language : rien d'utilisable → null (le repli est ailleurs)", () => {
  assert.equal(negotiateLocale(null), null);
  assert.equal(negotiateLocale(""), null);
  assert.equal(negotiateLocale("de-DE,it;q=0.8"), null);
  assert.equal(negotiateLocale("*"), null);
  assert.equal(negotiateLocale("fr;q=0"), null, "q=0 veut dire « pas cette langue »");
  assert.equal(negotiateLocale("fr;q=abc,en"), "en", "qualité illisible : entrée ignorée");
});

test("ordre : compte, puis cookie, puis Accept-Language, puis anglais", () => {
  assert.equal(resolveLocale({ account: "fr", cookie: "en", acceptLanguage: "en" }), "fr");
  assert.equal(resolveLocale({ account: null, cookie: "fr", acceptLanguage: "en-US" }), "fr");
  assert.equal(resolveLocale({ account: null, cookie: null, acceptLanguage: "fr-CH" }), "fr");
  assert.equal(resolveLocale({ account: null, cookie: null, acceptLanguage: "de-DE" }), "en");
  assert.equal(resolveLocale({}), "en");
});

test("une valeur inconnue (cookie forgé, colonne corrompue) est ignorée, jamais rendue", () => {
  assert.equal(resolveLocale({ account: "xx", cookie: "<script>", acceptLanguage: "fr" }), "fr");
  assert.equal(resolveLocale({ account: "de", cookie: null, acceptLanguage: null }), "en");
});
