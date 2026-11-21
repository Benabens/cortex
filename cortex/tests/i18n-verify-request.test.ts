/**
 * Page "Vérifie ta boîte mail" (/verify-request, DA de /login — lib/auth pages.verifyRequest) :
 * adresse affichée quand connue, renvoyer/changer d'adresse, en français et en anglais.
 * Le vrai parcours (lien magique → cette page) est couvert par e2e/magic-link.spec.ts ;
 * ceci vérifie le rendu du composant pour les deux langues et les deux cas (adresse connue
 * ou non — accessible seulement via le repli NextAuth, sans query email).
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { test } from "node:test";
import { VerifyRequestCard } from "../app/verify-request/VerifyRequestCard";
import { renderIntl } from "./helpers/intl";

const props = { email: "etudiant@epfl.ch", callbackUrl: "/" };

test("adresse connue : affichée, bouton pour renvoyer, lien pour changer d'adresse (FR/EN)", () => {
  const fr = renderIntl(createElement(VerifyRequestCard, props), "fr");
  const en = renderIntl(createElement(VerifyRequestCard, props), "en");
  assert.match(fr, /Vérifie ta boîte mail/);
  assert.match(fr, /etudiant@epfl\.ch/);
  assert.match(fr, /Renvoyer le lien/);
  assert.match(fr, /Changer d.adresse/);
  assert.match(fr, /indésirables/);
  assert.match(en, /Check your inbox/);
  assert.match(en, /etudiant@epfl\.ch/);
  assert.match(en, /Resend the link/);
  assert.match(en, /Use a different address/);
  assert.match(en, /spam folder/);
});

test("sans adresse connue (repli NextAuth) : message générique, pas de bouton renvoyer", () => {
  const fr = renderIntl(createElement(VerifyRequestCard, { email: null, callbackUrl: "/" }), "fr");
  assert.match(fr, /Un lien de connexion vient de partir/);
  assert.match(fr, /Retour à la connexion/);
  assert.doesNotMatch(fr, /Renvoyer le lien/);
});
