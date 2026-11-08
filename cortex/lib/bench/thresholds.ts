import type { Metrics } from "./metrics";

/**
 * SEUILS DU BANC — fixés par Ben (lot Q, 04/11/2026). Un seuil franchi = échec rouge ;
 * sans objet (pas de juge, pas de chrono demandé, pas de référence) = ni vert ni rouge.
 *
 * Interprétations notées dans docs/bench.md :
 *  - « aucun chapitre à 0 dès 10 questions » : chapitres à 0 ≤ max(0, chapitres − questions) ;
 *  - « coût non en hausse » : au plus +5 % sur la référence (bruit d'un modèle non déterministe) ;
 *  - la durée est mesurée sur le provider du banc et ne représente pas l'API de production.
 */

/** `replay` : run rejoué depuis des bandes (CI) — durée, coût et temps restant n'y veulent rien dire. */
export type ThresholdOpts = { maxMinutes?: number; expectRefusal?: boolean; focus?: boolean; replay?: boolean };
export type Verdict = { id: string; label: string; value: string; limit: string; pass: boolean | null };

const pct = (x: number) => `${Math.round(x * 1000) / 10} %`;

export function checkThresholds(m: Metrics, opts: ThresholdOpts = {}, ref?: Metrics): Verdict[] {
  const d = m.delivery;
  const out: Verdict[] = [];
  const add = (id: string, label: string, value: string, limit: string, pass: boolean | null) => out.push({ id, label, value, limit, pass });

  if (opts.expectRefusal) add("delivery.complete", "Livraison", d.refusedAsExpected ? "refus propre" : `${d.delivered}/${d.requested}`, "refus avant débit", d.refusedAsExpected);
  else add("delivery.complete", "Livraison", `${d.delivered}/${d.requested}${d.providerOutage ? " (panne fournisseur)" : ""}`, "100 % hors panne", d.providerOutage ? null : d.delivered >= d.requested);
  add("delivery.refund", "Remboursement juste", d.refundedMilli === null ? "facturation inactive" : `${d.refundedMilli} ‰ (dû ${d.expectedRefundMilli} ‰)`, "± 1 ‰", d.refundOk);

  const c = m.coverage;
  const coverageApplies = !opts.focus && !opts.expectRefusal && d.delivered >= 10;
  add("coverage.zeroChapters", "Chapitres à 0", `${c.zeroChapters}/${c.chapters}`, `≤ ${c.allowedZero}`, coverageApplies && c.chapters ? c.zeroChapters <= c.allowedZero : null);

  add("duplicates.intra", "Doublons dans l'examen", m.duplicates ? String(m.duplicates.intra) : "—", "0", m.duplicates ? m.duplicates.intra === 0 : null);
  add("duplicates.previous", "Doublons vs examens précédents", m.duplicates ? String(m.duplicates.previous) : "—", "0", m.duplicates ? m.duplicates.previous === 0 : null);

  const f = m.fidelity;
  add("fidelity.keys", "Clés justes", f ? `${pct(f.keyAccuracy)} (${f.keysWrong} fausse(s), ${f.keysUnsure} incertaine(s))` : "—", "≥ 98 %", f && f.keysChecked ? f.keyAccuracy >= 0.98 : null);
  add("fidelity.explanations", "Explications incohérentes", f ? String(f.incoherentExplanations) : "—", "0", f ? f.incoherentExplanations === 0 : null);

  const t = m.difficulty;
  add("difficulty.trivial", "Distracteurs triviaux", t ? `${pct(t.trivialShare)} (${t.trivial}/${t.distractors})` : "—", "≤ 5 %", t && t.distractors ? t.trivialShare <= 0.05 : null);

  const o = m.offCourse;
  add("offCourse.falseRejections", "Faux rejets hors cours", o ? `${pct(o.falseRejectionRate)} (${o.falseRejections})` : "—", "≤ 3 %", o ? o.falseRejectionRate <= 0.03 : null);

  const r = m.render;
  const delivered = d.delivered > 0;
  add("render.pdf", "PDF énoncé + corrigé", `${r.statementPdf ? "énoncé ✓" : "énoncé ✗"} ${r.corrigePdf ? "corrigé ✓" : "corrigé ✗"}`, "100 %", delivered ? r.statementPdf && r.corrigePdf : null);

  const min = m.perf.totalMs / 60_000;
  add("perf.duration", "Durée totale", `${Math.round(min * 10) / 10} min`, opts.maxMinutes ? `< ${opts.maxMinutes} min` : "—", opts.maxMinutes && delivered && !opts.replay ? min < opts.maxMinutes : null);
  add("perf.cost", "Coût par examen (estimé)", `${m.perf.costUsd.toFixed(3)} $${ref ? ` (réf. ${ref.perf.costUsd.toFixed(3)} $)` : ""}`, "≤ réf. + 5 %", ref && ref.perf.costUsd > 0 && !opts.replay ? m.perf.costUsd <= ref.perf.costUsd * 1.05 : null);

  const e = m.ux.etaMedianError;
  add("ux.eta", "Erreur médiane du temps restant", e === null ? "—" : pct(e), "≤ 25 %", e === null || opts.replay ? null : e <= 0.25);
  return out;
}

/**
 * Régressions d'un run rejoué face à sa référence enregistrée (CI) : les seuils verts à la
 * référence et rouges maintenant. Les réponses du modèle étant figées, seul le code a changé.
 */
export function regressions(base: Verdict[], cur: Verdict[]): Verdict[] {
  const was = new Map(base.map((v) => [v.id, v.pass]));
  return cur.filter((v) => v.pass === false && was.get(v.id) === true);
}
