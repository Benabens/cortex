/**
 * QUESTIONS OUVERTES DISPARUES DE /mock (23/11/2026, après #209). Sous le bundler de Next, un module
 * qui importe un paquet ESM chargé à part (katex, via lib/math-html) devient asynchrone : un
 * `require()` synchrone de ce module rend alors un objet sans ses fonctions. Dans getQcmExam, le
 * `require("@/lib/exam-latex")` donnait « texToHtml is not a function », avalé par un catch : plus
 * aucune question ouverte à l'écran. tsx ne reproduit pas ce chargement, d'où cette garde sur les
 * sources : aucun require() d'un module interne qui atteint, par ses imports, un tel paquet.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(__dirname, "..");
/** Paquets ESM que Next charge hors du bundle, donc de façon asynchrone. */
const ESM_EXTERNALS = new Set(["katex"]);

function resolveInternal(spec: string, from: string): string | null {
  const base = spec.startsWith("@/") ? path.join(ROOT, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
  if (!base) return null;
  for (const f of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  return null;
}

/** Imports statiques (hors `import type`) d'un fichier source. */
function staticImports(file: string): string[] {
  const src = fs.readFileSync(file, "utf8");
  return [...src.matchAll(/^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gm)].map((m) => m[1]);
}

/** Le paquet ESM externe atteint par les imports statiques de `file`, ou null. */
function reachesEsmExternal(file: string, seen = new Set<string>()): string | null {
  if (seen.has(file)) return null;
  seen.add(file);
  for (const spec of staticImports(file)) {
    const pkg = spec.startsWith("@/") || spec.startsWith(".") ? null : spec.split("/")[0];
    if (pkg && ESM_EXTERNALS.has(pkg)) return pkg;
    const next = resolveInternal(spec, file);
    const hit = next && reachesEsmExternal(next, seen);
    if (hit) return `${path.relative(ROOT, next)} → ${hit}`;
  }
  return null;
}

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name.startsWith(".") ? [] : sources(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

test("aucun require() synchrone d'un module qui importe un paquet ESM externe (katex) : il rendrait un module vide", () => {
  const offenders: string[] = [];
  for (const file of ["app", "components", "db", "lib"].flatMap((d) => sources(path.join(ROOT, d)))) {
    for (const m of fs.readFileSync(file, "utf8").matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
      const target = resolveInternal(m[1], file);
      const hit = target && reachesEsmExternal(target);
      if (hit) offenders.push(`${path.relative(ROOT, file)} : require("${m[1]}") → ${hit}`);
    }
  }
  assert.deepEqual(offenders, [], "à remplacer par un import statique ou `await import()`");
});

test("la garde voit bien la chaîne exam-latex → math-html → katex", () => {
  assert.match(reachesEsmExternal(path.join(ROOT, "lib/exam-latex.ts")) ?? "", /math-html\.ts → katex/);
});
