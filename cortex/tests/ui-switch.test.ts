/**
 * INTERRUPTEUR (components/ui/primitives.tsx, Toggle) : la feuille et les tokens tiennent leurs promesses.
 *  - `--ease-spring` est le ressort échantillonné par scripts/spring.mjs (période 220 ms, rebond 0,38), jamais une
 *    courbe à la main ; `--t-switch` est la durée de cet échantillon ; dépassement ≈ 1,7 px sur 20 px de course ;
 *  - la pastille bouge en transform + largeur dérivée : aucune transition sur left / margin / width / all / transform,
 *    pas de scaleX ; l'étirement et l'appui n'existent que sous prefers-reduced-motion: no-preference ;
 *  - le composant est un vrai <input type="checkbox" role="switch"> et la page Révision s'en sert.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { springLinear } from "../scripts/spring.mjs";

const ROOT = join(import.meta.dirname, "..");
const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");

function block(): string {
  const start = css.indexOf("/* — Interrupteur (Toggle");
  const end = css.indexOf("/* — fin de l'interrupteur — */", start);
  assert.ok(start > 0 && end > start, "bloc Interrupteur absent de globals.css");
  return css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "");
}

test("--ease-spring est le ressort échantillonné (220 ms, rebond 0,38) et --t-switch sa durée", () => {
  const curve = css.match(/--ease-spring:\s*(linear\([^)]*\));/)?.[1];
  const duration = Number(css.match(/--t-switch:\s*(\d+)ms;/)?.[1]);
  const expected = springLinear(220, 0.38, 32) as { linear: string; duration: number; peak: number };
  assert.equal(curve, expected.linear);
  assert.equal(duration, expected.duration);
  assert.ok((expected.peak - 1) * 20 < 2, "dépassement au-delà de 2 px sur la course");
});

test("la pastille bouge en transform + largeur dérivée, jamais left / margin / width / all, jamais scaleX", () => {
  const b = block();
  assert.match(b, /@property --tl \{ syntax: "<length>"/);
  assert.match(b, /transform: translateX\(var\(--tl\)\)/);
  assert.match(b, /width: calc\(20px \+ var\(--tr\) - var\(--tl\)\)/);
  assert.doesNotMatch(b, /scaleX/);
  for (const m of b.matchAll(/transition:\s*([^;]+);/g)) {
    for (const p of m[1].split(",").map((d) => d.trim().split(/\s+/)[0])) {
      assert.ok(!["left", "right", "margin", "width", "all", "transform"].includes(p), `transition sur ${p}`);
    }
  }
});

test("étirement, retard du bord arrière et appui : seulement sous prefers-reduced-motion: no-preference", () => {
  const b = block();
  const i = b.indexOf("@media (prefers-reduced-motion: no-preference)");
  assert.ok(i > 0);
  assert.doesNotMatch(b.slice(0, i), /:active|--t-switch-lag|--ease-spring|--t-press/);
  assert.match(b.slice(i), /input:active:not\(:disabled\) \+ \.sw-track \{\s*--tr: 6px/);
});

test("Toggle est un vrai input role=switch, et la page Révision s'en sert", () => {
  const prim = readFileSync(join(ROOT, "components/ui/primitives.tsx"), "utf8");
  assert.match(prim, /type="checkbox"\s+role="switch"/);
  const page = readFileSync(join(ROOT, "app/revision/page.tsx"), "utf8");
  assert.match(page, /<Toggle checked=\{hideDone\}/);
  assert.doesNotMatch(page, /type="checkbox"/);
});
