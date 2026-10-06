/**
 * CONTACT ET LIENS LÉGAUX.
 *  - Une seule adresse de contact dans l'app (pied de page, connexion, messages
 *    qui renvoient vers le support), remplaçable par CONTACT_EMAIL.
 *  - Les quatre documents légaux vivent sur la vitrine, en français (version qui
 *    fait foi ; chaque page renvoie à sa traduction anglaise). Déclarer la
 *    vitrine (LANDING_URL) suffit à les lier ; un LEGAL_*_URL explicite prime.
 *    Sans l'un ni l'autre, aucun lien : la vente reste fermée en production.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { contactEmail } from "../lib/contact";
import { landingOrigin, legalEnglishUrl, legalLinks, legalReady } from "../lib/legal";

test("adresse de contact : celle de l'éditeur par défaut, CONTACT_EMAIL la remplace si elle est valide", () => {
  assert.equal(contactEmail({}), "abensur.benjamin@gmail.com");
  assert.equal(contactEmail({ CONTACT_EMAIL: " support@cortexexam.com " }), "support@cortexexam.com");
  assert.equal(contactEmail({ CONTACT_EMAIL: "pas-une-adresse" }), "abensur.benjamin@gmail.com");
  assert.equal(contactEmail({ CONTACT_EMAIL: "a@b.c?subject=x\"><script>" }), "abensur.benjamin@gmail.com", "rien qui casserait un lien mailto");
});

test("vitrine déclarée : les quatre documents français sont liés à leurs chemins", () => {
  const env = { LANDING_URL: "https://cortexexam.com/" };
  assert.equal(landingOrigin(env), "https://cortexexam.com");
  assert.deepEqual(legalLinks(env), {
    terms: "https://cortexexam.com/terms",
    privacy: "https://cortexexam.com/privacy",
    refund: "https://cortexexam.com/remboursement",
    notice: "https://cortexexam.com/mentions-legales",
  });
  assert.equal(legalReady(env), true);
});

test("version anglaise : un lien vers la traduction des conditions, d'où partent les trois autres ; aucun sans vitrine déclarée", () => {
  assert.equal(legalEnglishUrl({ LANDING_URL: "https://cortexexam.com" }), "https://cortexexam.com/terms-en");
  assert.equal(legalEnglishUrl({}), null);
  assert.equal(legalEnglishUrl({ LEGAL_TERMS_URL: "https://autre.example/cgv" }), null, "un document hébergé ailleurs n'a pas de traduction connue");
});

test("un LEGAL_*_URL explicite prime sur la vitrine", () => {
  const links = legalLinks({ LANDING_URL: "https://cortexexam.com", LEGAL_TERMS_URL: "https://autre.example/cgv" });
  assert.equal(links.terms, "https://autre.example/cgv");
  assert.equal(links.privacy, "https://cortexexam.com/privacy");
});

test("ni vitrine ni liens : aucun lien, les documents ne sont pas réputés publiés", () => {
  assert.deepEqual(legalLinks({}), { terms: null, privacy: null, refund: null, notice: null });
  assert.equal(legalReady({}), false);
  assert.equal(landingOrigin({ LANDING_URL: "javascript:alert(1)" }), null, "http(s) seulement");
});
