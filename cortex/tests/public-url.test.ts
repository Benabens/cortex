/**
 * URL PUBLIQUE ET CHANGEMENT DE DOMAINE. AUTH_URL est la source unique de
 * l'URL publique. Après un changement de domaine, l'ancien hôte sert toujours
 * l'app mais une connexion commencée dessus échoue (cookies d'état OAuth posés
 * sur l'ancien hôte, rappel de Google sur le nouveau) : REDIRECT_FROM_HOSTS
 * liste les hôtes à renvoyer vers l'URL publique. La liste est explicite : une
 * règle « tout hôte différent » bouclerait derrière un proxy qui réécrit Host.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { legacyHostRedirect, publicOrigin } from "../lib/public-url";

const env = { AUTH_URL: "https://cortexexam.com/", REDIRECT_FROM_HOSTS: "cortex-app-production-6a65.up.railway.app, old.example.org" };
const at = (host: string | null, pathname = "/revision", search = "") => ({ host, pathname, search });

test("publicOrigin : origine d'AUTH_URL, null si absente ou mal formée", () => {
  assert.equal(publicOrigin({ AUTH_URL: "https://cortexexam.com/chemin?x=1" }), "https://cortexexam.com");
  assert.equal(publicOrigin({}), null);
  assert.equal(publicOrigin({ AUTH_URL: "pas une url" }), null);
});

test("ancien hôte listé : renvoi vers l'URL publique, chemin et paramètres conservés", () => {
  assert.equal(legacyHostRedirect(at("cortex-app-production-6a65.up.railway.app", "/examens", "?chapitre=3"), env), "https://cortexexam.com/examens?chapitre=3");
  assert.equal(legacyHostRedirect(at("OLD.example.org:443", "/"), env), "https://cortexexam.com/", "casse et port ignorés");
});

test("hôte canonique ou inconnu : jamais de renvoi (pas de boucle possible)", () => {
  assert.equal(legacyHostRedirect(at("cortexexam.com"), env), null);
  assert.equal(legacyHostRedirect(at("10.0.3.7:3000"), env), null, "hôte interne non listé");
  assert.equal(legacyHostRedirect(at(null), env), null);
  assert.equal(legacyHostRedirect(at("cortexexam.com"), { ...env, REDIRECT_FROM_HOSTS: "cortexexam.com" }), null, "l'hôte canonique listé par erreur n'est pas redirigé");
});

test("sans AUTH_URL ou sans liste : rien", () => {
  assert.equal(legacyHostRedirect(at("old.example.org"), { REDIRECT_FROM_HOSTS: "old.example.org" }), null);
  assert.equal(legacyHostRedirect(at("old.example.org"), { AUTH_URL: "https://cortexexam.com" }), null);
});

test("healthcheck et webhook Stripe : servis sur l'ancien hôte aussi", () => {
  assert.equal(legacyHostRedirect(at("old.example.org", "/api/health"), env), null);
  assert.equal(legacyHostRedirect(at("old.example.org", "/api/billing/webhook"), env), null, "l'ancien endpoint Stripe reste joignable");
});
