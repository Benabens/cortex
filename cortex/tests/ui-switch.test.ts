/** Garanties propres au Toggle : ressort, étirement réel, appui et accessibilité. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { springLinear } from "../scripts/spring.mjs";

const ROOT = join(import.meta.dirname, "..");
const css = readFileSync(join(ROOT, "app/globals.css"), "utf8");

function toggleCss(): string {
  const start = css.indexOf("/* — Interrupteur binaire.");
  const end = css.indexOf("/* — Reduced motion:", start);
  assert.ok(start > 0 && end > start, "bloc du Toggle absent de globals.css");
  return css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "");
}

test("le ressort du Toggle est généré par scripts/spring.mjs", () => {
  const curve = css.match(/--switch-spring:\s*(linear\([^)]*\));/)?.[1];
  const duration = Number(css.match(/--switch-duration:\s*(\d+)ms;/)?.[1]);
  const expected = springLinear(220, 0.38, 32);
  assert.equal(curve, expected.linear);
  assert.equal(duration, expected.duration);
  assert.ok((expected.peak - 1) * 20 < 2, "rebond supérieur à 2 px");
});

test("la pastille glisse et s'étire par ses deux bords", () => {
  const block = toggleCss();
  assert.match(block, /@property --switch-left/);
  assert.match(block, /transform: translateX\(var\(--switch-left\)\)/);
  assert.match(block, /width: calc\(20px \+ var\(--switch-right\) - var\(--switch-left\)\)/);
  assert.doesNotMatch(block, /scaleX/);
  assert.doesNotMatch(block, /\.switch-knob/);
});

test("l'étirement et la réaction à l'appui respectent le mouvement réduit", () => {
  const block = toggleCss();
  const motion = block.indexOf("@media (prefers-reduced-motion: no-preference)");
  assert.ok(motion > 0);
  assert.doesNotMatch(block.slice(0, motion), /:active|--switch-lag|--switch-spring|--switch-press/);
  assert.match(block.slice(motion), /input:active:not\(:disabled\) \+ \.switch-track \{\s*--switch-right: 6px/);
});

test("le Toggle canonique est un checkbox switch et Révision conserve Segmented", () => {
  const component = readFileSync(join(ROOT, "components/ui/Toggle.tsx"), "utf8");
  assert.match(component, /type="checkbox"\s+role="switch"/);
  assert.match(component, /event\.key === "Enter"/);
  const primitives = readFileSync(join(ROOT, "components/ui/primitives.tsx"), "utf8");
  assert.doesNotMatch(primitives, /function Toggle/);
  const revision = readFileSync(join(ROOT, "app/revision/page.tsx"), "utf8");
  assert.match(revision, /<Segmented/);
  assert.match(revision, /<Toggle checked=\{hideDone\}/);
});
