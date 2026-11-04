/**
 * TEMPS RESTANT D'UNE GÉNÉRATION — le suivi d'un job ne donnait qu'un pourcentage.
 * Durée attendue : la médiane des derniers jobs du même type du cours (insensible à un
 * job hors norme), à défaut une durée par type ; reste sa part non faite, lue sur l'avancement
 * PAR PHASE (lib/progress) — jamais sur le temps écoulé, qui la faisait remonter. Pur :
 * le calcul ne lit ni l'horloge ni la base (lib/jobs lui passe l'écoulé et l'historique).
 */

export type EtaInput = {
  type: string;
  status: string;
  /** 0-100 */
  progress: number;
  /** Depuis la création du job. */
  elapsedMs: number;
  /** Reprises après une coupure (jobs.attempts). */
  attempts: number;
  /** Durées des derniers jobs du même type, terminés. */
  historyMs: number[];
};

export type Eta = { remainingMs: number | null; late: boolean; basis: "history" | "default"; label: string };

const MIN = 60_000;
/** Sans historique : ordres de grandeur mesurés (banc du job 9 de CS-290 pour un examen QCM). */
const DEFAULT_MS: Record<string, number> = { qcm: 12 * MIN, exam: 15 * MIN, exercise: 6 * MIN, "lab-exercise": 6 * MIN, prepare: 8 * MIN, blueprint: 6 * MIN, format: 3 * MIN, ingest: 3 * MIN };
/** Au-delà de la durée attendue × ce facteur, le job est « en retard » : plus d'estimation chiffrée. */
const LATE_FACTOR = 1.25;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function minutes(ms: number): string {
  const m = Math.round(ms / MIN);
  return m < 1 ? "moins d'une minute" : `≈ ${m} min restantes`;
}

export function estimateRemaining(i: EtaInput): Eta {
  const history = i.historyMs.filter((x) => Number.isFinite(x) && x > 0).slice(0, 5);
  const basis = history.length ? "history" as const : "default" as const;
  const expected = history.length ? median(history) : DEFAULT_MS[i.type] ?? 10 * MIN;
  const suffix = basis === "default" ? " (estimation sans historique)" : "";
  const progress = Math.min(100, Math.max(0, i.progress));

  if (i.status === "queued") {
    return { remainingMs: expected, late: false, basis, label: `En file — environ ${Math.max(1, Math.round(expected / MIN))} min une fois lancé${suffix}` };
  }
  // Repris après une coupure : le temps écoulé depuis le PREMIER départ ne dit plus rien ; la
  // reprise repart du dernier point sauvegardé, il reste la part non faite.
  if (i.attempts > 0) {
    const remaining = expected * (1 - progress / 100);
    return { remainingMs: remaining, late: false, basis, label: `${minutes(remaining)} (reprise)${suffix}` };
  }
  if (i.elapsedMs > expected * LATE_FACTOR && progress < 95) {
    return { remainingMs: null, late: true, basis, label: "Plus long que d'habitude — la génération continue" };
  }
  // La part non faite de la durée attendue. Rien ne dépend du temps écoulé : une étape longue ne
  // fait pas remonter l'estimation ; elle ne remonte que si l'avancement recule, c'est-à-dire
  // quand la génération AJOUTE un réessai (lib/progress).
  const remaining = expected * (1 - progress / 100);
  return { remainingMs: remaining, late: false, basis, label: `${minutes(remaining)}${suffix}` };
}
