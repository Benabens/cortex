/**
 * OUVERTURE DES INSCRIPTIONS. Sans INVITE_ONLY=1, toute adresse peut créer un
 * compte (ouverture publique). Avec INVITE_ONLY=1 (lancement fermé), seules les
 * adresses d'INVITE_EMAILS passent — une entrée « @domaine » ouvre tout le
 * domaine, sans jamais ouvrir un domaine qui se termine pareil.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { inviteAllows } from "../lib/invite";

test("ouverture publique : sans INVITE_ONLY=1, n'importe quelle adresse s'inscrit", () => {
  assert.equal(inviteAllows("inconnu@gmail.com", {}), true);
  assert.equal(inviteAllows("inconnu@gmail.com", { INVITE_ONLY: "0", INVITE_EMAILS: "ben@example.com" }), true, "la liste est ignorée hors lancement fermé");
  assert.equal(inviteAllows("inconnu@gmail.com", { INVITE_EMAILS: "ben@example.com" }), true);
});

test("lancement fermé : seules les adresses invitées passent, sans égard à la casse", () => {
  const env = { INVITE_ONLY: "1", INVITE_EMAILS: "Ben@Example.com, @epfl.ch" };
  assert.equal(inviteAllows("ben@example.com", env), true);
  assert.equal(inviteAllows(" BEN@example.com ", env), true);
  assert.equal(inviteAllows("alice@epfl.ch", env), true, "tout le domaine");
  assert.equal(inviteAllows("inconnu@gmail.com", env), false);
  assert.equal(inviteAllows("", env), false);
  assert.equal(inviteAllows(null, env), false);
  assert.equal(inviteAllows("x@example.com", { INVITE_ONLY: "1" }), false, "liste vide : personne");
});

test("lancement fermé : « @epfl.ch » n'ouvre pas un domaine qui se termine pareil", () => {
  const env = { INVITE_ONLY: "1", INVITE_EMAILS: "@epfl.ch" };
  assert.equal(inviteAllows("mallory@notepfl.ch", env), false);
  assert.equal(inviteAllows("mallory@evil.com@epfl.ch", env), true, "le domaine est celui après le dernier @");
});
