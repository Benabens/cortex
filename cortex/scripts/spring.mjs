#!/usr/bin/env node
// Génère un ressort échantillonné en `linear()` CSS à partir d'une période et d'un rebond.
// Le Toggle emploie `node scripts/spring.mjs 220 0.38 32` ; son test compare cette sortie
// aux jetons de globals.css pour empêcher toute retouche manuelle de la courbe.

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
  const value = spring(periodMs, bounce);
  for (let t = 2000; t >= 0; t -= 1) {
    if (Math.abs(value(t) - 1) > tol) return t + 1;
  }
  return 0;
}

/** Durée, dépassement maximal et courbe `linear()` à `samples + 1` points. */
export function springLinear(periodMs, bounce, samples = 24) {
  const value = spring(periodMs, bounce);
  const duration = Math.ceil(settleMs(periodMs, bounce) / 10) * 10;
  const points = Array.from({ length: samples + 1 }, (_, index) => +value((duration * index) / samples).toFixed(3));
  let peak = 1;
  for (let t = 0; t <= duration; t += 1) peak = Math.max(peak, value(t));
  return { duration, peak, points, linear: `linear(${points.join(", ")})` };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [period, bounce, samples] = process.argv.slice(2).map(Number);
  if (!period || !(bounce >= 0 && bounce < 1)) {
    console.error("usage : node scripts/spring.mjs <période ms> <rebond 0-1> [échantillons]");
    process.exit(2);
  }
  const result = springLinear(period, bounce, samples || 24);
  console.log(`durée : ${result.duration}ms · dépassement : ${((result.peak - 1) * 100).toFixed(1)} %`);
  console.log(result.linear);
}
