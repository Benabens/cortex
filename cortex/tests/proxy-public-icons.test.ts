import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";

/**
 * Logo Dissolution v2 — les icônes, le manifest et l'image de partage sont lus
 * sans session (onglet, écran d'accueil, robots de prévisualisation). Avec
 * AUTH_ENABLED=1, ils répondaient 307 → /login : favicon cassé hors connexion.
 */

(process.env as Record<string, string | undefined>).AUTH_ENABLED = "1";

const ICON_PATHS = [
  "/favicon.ico",
  "/icon.svg",
  "/apple-icon.png",
  "/manifest.webmanifest",
  "/login/opengraph-image.png",
  "/brand/icon-192.png",
  "/brand/icon-512.png",
  "/brand/maskable-512.png",
];

test("auth active : icônes et manifest passent sans redirection vers /login", async () => {
  const { default: proxy } = await import("../proxy");
  for (const p of ICON_PATHS) {
    // Next ajoute un suffixe de cache (?<hash>) aux fichiers de métadonnées.
    const res = await proxy(new NextRequest(`http://cortex.test${p}?v=abc`));
    assert.equal(res.status, 200, `${p} → ${res.status}`);
    assert.equal(res.headers.get("location"), null, `${p} redirigé`);
  }
});

test("les fichiers publics sont comparés en égalité stricte, pas en préfixe", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../proxy.ts", import.meta.url), "utf8");
  assert.match(src, /PUBLIC_FILES\.has\(pathname\)/);
  const m = src.match(/const PUBLIC_PREFIXES = \[([^\]]*)\]/);
  assert.ok(m, "PUBLIC_PREFIXES introuvable");
  for (const p of ['"/icon', '"/apple', '"/manifest']) {
    assert.ok(!m![1].includes(p), `${p}… ne doit pas être un préfixe public`);
  }
});
