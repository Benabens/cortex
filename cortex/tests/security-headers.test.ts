import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * B4 — En-têtes de sécurité posés par la configuration Next sur TOUTES les
 * réponses (pages, API, fichiers servis) : CSP défensive compatible avec Next
 * (scripts inline du framework, styles inline de Tailwind/next-font, aperçus
 * blob:, PDF), anti-clickjacking, anti-sniffing, referrer sobre.
 */

async function allHeaders(): Promise<Record<string, string>> {
  const mod = await import("../next.config");
  const cfg = mod.default;
  assert.equal(typeof cfg.headers, "function", "next.config doit déclarer headers()");
  const rules = await cfg.headers!();
  const { GLOBAL_HEADERS_SOURCE } = await import("../lib/security-headers");
  const global = rules.find((r) => r.source === GLOBAL_HEADERS_SOURCE);
  assert.ok(global, `aucune règle globale : ${rules.map((r) => r.source).join(", ")}`);
  return Object.fromEntries(global!.headers.map((h) => [h.key.toLowerCase(), h.value]));
}

/** Simule le matcher path-to-regexp de Next sur la source de la règle globale. */
function globalRuleMatches(source: string, pathname: string): boolean {
  const inner = source.slice("/(".length, -")".length); // "(?!a|b).*"
  return new RegExp(`^/${inner}$`).test(pathname);
}

test("CSP : frame-ancestors, object-src, base-uri, scripts et connexions bornés à l'origine", async () => {
  const h = await allHeaders();
  const csp = h["content-security-policy"];
  assert.ok(csp, "Content-Security-Policy absente");
  const d = Object.fromEntries(csp.split(";").map((s) => s.trim()).filter(Boolean).map((s) => {
    const [k, ...v] = s.split(/\s+/); return [k, v.join(" ")];
  }));
  assert.equal(d["default-src"], "'self'");
  assert.equal(d["frame-ancestors"], "'none'");
  assert.ok(/^'(none|self)'$/.test(d["object-src"] ?? ""), `object-src : ${d["object-src"]}`);
  assert.equal(d["base-uri"], "'self'");
  assert.equal(d["connect-src"], "'self'");
  // Aucune origine externe pour les scripts (les inline du framework restent nécessaires).
  assert.ok(!/https?:/.test(d["script-src"] ?? ""), `script-src externe : ${d["script-src"]}`);
  // Ce que l'app utilise vraiment doit rester permis.
  assert.match(d["img-src"] ?? "", /blob:/);   // aperçu d'image jointe (object URL)
  assert.match(d["img-src"] ?? "", /data:/);
  assert.match(d["style-src"] ?? "", /'unsafe-inline'/); // Tailwind / next-font / HTML d'examen
  assert.match(d["form-action"] ?? "", /accounts\.google\.com/); // redirection OAuth après POST
});

test("la règle globale couvre pages/API/assets mais PAS les routes de fichiers (qui posent leurs en-têtes)", async () => {
  const { GLOBAL_HEADERS_SOURCE, servedFileHeaders, CSP_BASE } = await import("../lib/security-headers");
  for (const p of ["/", "/api/health", "/api/jobs", "/_next/static/x.js", "/entrainement", "/examens", "/mock/3"]) {
    assert.ok(globalRuleMatches(GLOBAL_HEADERS_SOURCE, p), `${p} devrait être couvert`);
  }
  for (const p of ["/refs/final.pdf", "/csrc", "/exam/exam-1.pdf", "/uploads/x.png"]) {
    assert.ok(!globalRuleMatches(GLOBAL_HEADERS_SOURCE, p), `${p} ne doit pas être écrasé par la règle globale`);
  }
  // …et ces routes reçoivent le même jeu, sandbox en plus pour le HTML.
  const pdf = servedFileHeaders("application/pdf");
  assert.equal(pdf["content-security-policy"], CSP_BASE);
  assert.equal(pdf["x-content-type-options"], "nosniff");
  const html = servedFileHeaders("text/html");
  assert.match(html["content-security-policy"], /^sandbox;/);
  assert.equal(html["x-frame-options"], "DENY");
});

test("X-Content-Type-Options, Referrer-Policy, X-Frame-Options, Permissions-Policy", async () => {
  const h = await allHeaders();
  assert.equal(h["x-content-type-options"], "nosniff");
  assert.ok(/^(strict-origin-when-cross-origin|no-referrer|same-origin|strict-origin)$/.test(h["referrer-policy"] ?? ""), h["referrer-policy"]);
  assert.equal(h["x-frame-options"], "DENY");
  assert.ok(h["permissions-policy"], "Permissions-Policy absente");
});
