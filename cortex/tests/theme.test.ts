import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import {
  HTML_ESCAPED_CHARS,
  THEME_INIT_SCRIPT,
  THEME_STORAGE_KEY,
  parseThemePref,
  resolveTheme,
} from "../lib/ux/theme";

/**
 * Thème clair / sombre. Ce qu'on garantit : le script du <head> pose le bon `data-theme` dans
 * tous les cas (choix enregistré, système, stockage bloqué) sans jamais lever, et le thème
 * clair redéfinit bien chaque jeton de couleur du sombre.
 */

/** Exécute le script d'initialisation dans un faux navigateur ; renvoie le thème posé. */
function runInit({ stored, systemLight, storageThrows = false }: { stored?: string | null; systemLight: boolean; storageThrows?: boolean }) {
  const attrs: Record<string, string> = {};
  const sandbox = {
    document: { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) } },
    localStorage: {
      getItem: (k: string) => {
        if (storageThrows) throw new Error("SecurityError");
        return k === THEME_STORAGE_KEY ? (stored ?? null) : null;
      },
    },
    window: { matchMedia: (q: string) => ({ matches: q.includes("light") && systemLight }) },
  };
  runInNewContext(THEME_INIT_SCRIPT, sandbox);
  return attrs["data-theme"];
}

test("script du <head> : un choix explicite l'emporte sur le système", () => {
  assert.equal(runInit({ stored: "light", systemLight: false }), "light");
  assert.equal(runInit({ stored: "dark", systemLight: true }), "dark");
});

test("script du <head> : sans choix (« Système »), suit prefers-color-scheme", () => {
  assert.equal(runInit({ stored: null, systemLight: true }), "light");
  assert.equal(runInit({ stored: null, systemLight: false }), "dark");
  assert.equal(runInit({ stored: "n'importe quoi", systemLight: true }), "light");
});

test("script du <head> : rendu en texte par React, il ne contient rien à échapper", () => {
  assert.doesNotMatch(THEME_INIT_SCRIPT, HTML_ESCAPED_CHARS);
  const ge = readFileSync(new URL("../app/global-error.tsx", import.meta.url), "utf8");
  const palette = ge.match(/const PALETTE = `([^`]*)`/);
  assert.ok(palette, "palette de global-error introuvable");
  assert.doesNotMatch(palette[1], HTML_ESCAPED_CHARS);
});

test("script du <head> : stockage bloqué → sombre, sans lever", () => {
  assert.equal(runInit({ storageThrows: true, systemLight: true }), "dark");
});

test("préférence : tout ce qui n'est pas clair / sombre vaut « système »", () => {
  assert.equal(parseThemePref("light"), "light");
  assert.equal(parseThemePref("dark"), "dark");
  assert.equal(parseThemePref(null), "system");
  assert.equal(parseThemePref("system"), "system");
  assert.equal(resolveTheme("system", "light"), "light");
  assert.equal(resolveTheme("dark", "light"), "dark");
});

test("globals.css : le thème clair redéfinit chaque couleur du thème sombre", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const block = (start: RegExp) => {
    const from = css.search(start);
    assert.ok(from >= 0, `bloc introuvable : ${start}`);
    return css.slice(from, css.indexOf("\n}", from));
  };
  const names = (src: string) => new Set([...src.matchAll(/^\s*(--color-[\w-]+):/gm)].map((m) => m[1]));
  const dark = names(block(/^@theme \{/m));
  const light = names(block(/^:root\[data-theme="light"\] \{/m));
  const missing = [...dark].filter((n) => !light.has(n));
  assert.deepEqual(missing, [], `jetons sans équivalent clair : ${missing.join(", ")}`);
});
