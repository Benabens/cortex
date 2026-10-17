#!/usr/bin/env node
// Ressort échantillonné en `linear()` CSS : une courbe de ressort des tokens (`--ease-spring`) vient
// d'ici, jamais d'une main. Modèle « durée perçue + rebond » (celui d'Apple) : la période de
// l'oscillation est la durée perçue, l'amortissement vaut 1 − rebond.
//
//   node scripts/design/spring.mjs <période ms> <rebond 0-1> [échantillons = 24]
//
// Imprime la durée à poser (la courbe est au repos à 0,5 % près, arrondie aux 10 ms au-dessus),
// le dépassement maximal et le `linear()`. `app/src/styles/switch.test.mts` rejoue ce calcul et
// vérifie que le token lui est identique.

/** Position normalisée (0 → 1) d'un ressort sous-amorti, en fonction du temps en ms. */
export function spring(periodMs, bounce) {
  const zeta = 1 - bounce;
  const omega = (2 * Math.PI) / (periodMs / 1000);
  const omegaD = omega * Math.sqrt(1 - zeta * zeta);
  return (tMs) => {
    const t = tMs / 1000;
    return 1 - Math.exp(-zeta * omega * t) * (Math.cos(omegaD * t) + ((zeta * omega) / omegaD) * Math.sin(omegaD * t));
  };
}

/** Premier instant (ms) après lequel la courbe reste à `tol` près de 1. */
export function settleMs(periodMs, bounce, tol = 0.005) {
  const f = spring(periodMs, bounce);
  for (let t = 2000; t >= 0; t -= 1) if (Math.abs(f(t) - 1) > tol) return t + 1;
  return 0;
}

/** Durée à poser, dépassement maximal et `linear()` à `samples` + 1 points. */
export function springLinear(periodMs, bounce, samples = 24) {
  const f = spring(periodMs, bounce);
  const duration = Math.ceil(settleMs(periodMs, bounce) / 10) * 10;
  const points = Array.from({ length: samples + 1 }, (_, i) => +f((duration * i) / samples).toFixed(3));
  let peak = 1;
  for (let t = 0; t <= duration; t += 1) peak = Math.max(peak, f(t));
  return { duration, peak, points, linear: `linear(${points.join(", ")})` };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [period, bounce, samples] = process.argv.slice(2).map(Number);
  if (!period || !(bounce >= 0 && bounce < 1)) {
    console.error("usage : node scripts/design/spring.mjs <période ms> <rebond 0-1> [échantillons]");
    process.exit(2);
  }
  const r = springLinear(period, bounce, samples || 24);
  console.log(`durée : ${r.duration}ms · dépassement : ${((r.peak - 1) * 100).toFixed(1)} %`);
  console.log(r.linear);
}
