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

test("le proxy sert robots.txt sans session (sinon la consigne n'atteint jamais les moteurs)", async () => {
  const env = process.env as Record<string, string | undefined>;
  env.AUTH_ENABLED = "1";
  try {
    const { NextRequest } = await import("next/server");
    const { default: proxy } = await import("../proxy");
    const res = await proxy(new NextRequest("http://cortex.test/robots.txt"));
    assert.notEqual(res.status, 307, "un crawler anonyme ne doit pas être redirigé vers /login");
    assert.equal(res.headers.get("location"), null);
    // Contre-épreuve : /robots.txt est bien dans les fichiers publics, et une page
    // authentifiée n'y est pas (la garde elle-même est couverte par proxy-demo).
    const fs = await import("node:fs");
    const src = fs.readFileSync("proxy.ts", "utf8");
    const publicFiles = /const PUBLIC_FILES = new Set\(\[([^\]]*)\]\)/.exec(src)?.[1] ?? "";
    assert.match(publicFiles, /"\/robots\.txt"/);
    assert.ok(!publicFiles.includes("/examens"));
  } finally {
    delete env.AUTH_ENABLED;
  }
});
