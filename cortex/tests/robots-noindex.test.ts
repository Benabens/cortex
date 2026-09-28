/**
 * PRÉ-LANCEMENT 9 — l'app est une surface PRIVÉE (tout est derrière login) mais
 * n'avait aucun robots.txt : les moteurs suivaient la redirection vers /login,
 * page indexable au même titre que la vitrine. L'app interdit désormais
 * l'indexation partout, sauf l'écran de connexion. Le sitemap reste à la vitrine.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("robots.txt : tout interdit sauf l'écran de connexion, aucun sitemap annoncé", async () => {
  const mod = await import("../app/robots");
  const r = mod.default();
  const rules = Array.isArray(r.rules) ? r.rules : [r.rules!];
  const all = rules.find((x) => x!.userAgent === "*" || x!.userAgent === undefined)!;
  const disallow = ([] as string[]).concat(all.disallow ?? []);
  const allow = ([] as string[]).concat(all.allow ?? []);
  assert.deepEqual(disallow, ["/"], "toute l'app est interdite");
  assert.ok(allow.includes("/login"), "seule la porte d'entrée reste indexable");
  assert.equal(r.sitemap, undefined, "le sitemap appartient à la vitrine, pas à l'app");
});

test("politique d'indexation : noindex par défaut, indexable seulement pour la connexion", async () => {
  const { NOINDEX, INDEXABLE } = await import("../lib/seo");
  assert.deepEqual(NOINDEX.robots, { index: false, follow: false });
  assert.deepEqual(INDEXABLE.robots, { index: true, follow: true });
});

test("les deux mises en page appliquent la bonne politique", async () => {
  const fs = await import("node:fs");
  assert.match(fs.readFileSync("app/layout.tsx", "utf8"), /\.\.\.NOINDEX/, "racine : pages authentifiées en noindex");
  assert.match(fs.readFileSync("app/login/layout.tsx", "utf8"), /\.\.\.INDEXABLE/, "connexion : indexable");
});
