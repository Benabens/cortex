import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  SPRING_LEAD,
  SPRING_TRAIL,
  springDurationMs,
  springEasing,
  springTransition,
  springValue,
} from "../lib/ux/spring";

/**
 * Ressorts des interrupteurs (Segmented, Toggle). Ce qu'on garantit : un mouvement court, un seul
 * rebond, et des jetons CSS qui sont bien la sortie de lib/ux/spring.ts.
 */

const peak = (s: typeof SPRING_LEAD) => {
  let max = 0;
  for (let t = 0; t <= 1; t += 0.001) max = Math.max(max, springValue(s, t));
  return max;
};

test("ressort : part de 0, arrive à 1", () => {
  for (const s of [SPRING_LEAD, SPRING_TRAIL]) {
    assert.equal(springValue(s, 0), 0);
    assert.ok(Math.abs(springValue(s, springDurationMs(s) / 1000) - 1) <= 0.0051);
    assert.ok(Math.abs(springValue(s, 2) - 1) < 1e-6);
  }
});

test("ressort : le bord de tête ne dépasse jamais sa cible, le bord suiveur rebondit une fois, peu", () => {
  assert.ok(peak(SPRING_LEAD) <= 1, "amortissement critique : aucun dépassement");
  const over = peak(SPRING_TRAIL) - 1;
  assert.ok(over > 0.02 && over < 0.06, `rebond visible mais court (dépassement ${over})`);
  // « pas de wobble » : après le premier dépassement, le ressort ne repasse pas sous la cible
  // de plus de 0,5 %.
  let crossed = false;
  for (let t = 0; t <= 1; t += 0.001) {
    const v = springValue(SPRING_TRAIL, t);
    if (v > 1) crossed = true;
    if (crossed) assert.ok(v > 0.995, `seconde oscillation à t=${t}`);
  }
});

test("ressort : 150 à 300 ms, et le bord de tête arrive avant le suiveur (c'est ce qui étire)", () => {
  const lead = springDurationMs(SPRING_LEAD);
  const trail = springDurationMs(SPRING_TRAIL);
  assert.ok(lead >= 150 && lead <= 300, `tête ${lead} ms`);
  assert.ok(trail >= 150 && trail <= 300, `suiveur ${trail} ms`);
  assert.ok(lead < trail);
  let stretch = 0;
  for (let t = 0; t <= 0.3; t += 0.001) stretch = Math.max(stretch, springValue(SPRING_LEAD, t) - springValue(SPRING_TRAIL, t));
  assert.ok(stretch > 0.1, `étirement de ${Math.round(stretch * 100)} % de la distance`);
});

test("courbe CSS : linear() bornée par 0 et 1", () => {
  const easing = springEasing(SPRING_TRAIL);
  assert.match(easing, /^linear\(0, .*, 1\)$/);
  assert.equal(easing.split(",").length, 29);
});

test("globals.css porte exactement les courbes calculées", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.ok(css.includes(`--spring-lead: ${springTransition(SPRING_LEAD)};`), "régénérer --spring-lead");
  assert.ok(css.includes(`--spring-trail: ${springTransition(SPRING_TRAIL)};`), "régénérer --spring-trail");
});
