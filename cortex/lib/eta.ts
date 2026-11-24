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
  /** Questions commandées par chacun de ces jobs (alignées sur historyMs), si connues. */
  historyUnits?: (number | null)[];
  /** Questions commandées par CE job (QCM + ouvertes, exercices), si connues. */
  units?: number | null;
};

/**
 * `label` : la phrase française d'origine (journal, lecteur français). `kind` et `minutes` la
 * décrivent sans langue : lib/i18n/job-text en refait la phrase dans la langue du lecteur.
 */
export type Eta = {
  remainingMs: number | null; late: boolean; basis: "history" | "default"; label: string;
  kind: "queued" | "resumed" | "late" | "remaining";
  /** Minutes arrondies annoncées (durée totale une fois lancé, en file) ; 0 = moins d'une minute ; null si en retard. */
  minutes: number | null;
  /**
   * Fourchette du même reste (ms), pour l'interface : la dispersion des derniers jobs du type
   * (au moins 3), sinon large faute de mesure. null si en retard. Le libellé n'en dit rien (MCP).
   */
  lowMs: number | null;
  highMs: number | null;
};

const MIN = 60_000;
/** Sans historique : ordres de grandeur mesurés (banc du job 9 de CS-290 pour un examen QCM). */
const DEFAULT_MS: Record<string, number> = { qcm: 12 * MIN, exam: 15 * MIN, exercise: 6 * MIN, "lab-exercise": 6 * MIN, prepare: 8 * MIN, blueprint: 6 * MIN, format: 3 * MIN, ingest: 3 * MIN, drill: 2 * MIN, check: 1 * MIN };
/**
 * Durée par question commandée, sans historique (même banc : ≈ 12 min pour 7 QCM + 2 ouvertes).
 * Banc moteur du 04/11/2026 : une seule durée par type annonçait 12 min pour 10 comme pour 40 QCM.
 */
const DEFAULT_UNIT_MS: Record<string, number> = { qcm: 80_000, exam: 3 * MIN };
/** Au-delà de la durée attendue × ce facteur, le job est « en retard » : plus d'estimation chiffrée. */
const LATE_FACTOR = 1.25;
/**
 * Sans assez d'historique, la fourchette autour de l'attendu : les durées mesurées au banc varient
 * du simple au double d'un cours à l'autre (examen écrit : 8 à 35 min).
 */
const DEFAULT_SPREAD: [number, number] = [0.6, 1.8];

/** Facteurs bas et haut autour de la médiane, lus sur les derniers jobs (≥ 3), bornés pour rester utiles. */
function spreadOf(history: number[]): [number, number] {
  if (history.length < 3) return DEFAULT_SPREAD;
  const m = median(history);
  const low = Math.min(...history) / m;
  const high = Math.max(...history) / m;
  return [Math.min(0.9, Math.max(0.5, low)), Math.min(2.5, Math.max(1.15, high))];
}

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
  const units = i.units && i.units > 0 ? i.units : null;
  const runs = i.historyMs.map((ms, k) => ({ ms, n: i.historyUnits?.[k] ?? null })).filter((h) => Number.isFinite(h.ms) && h.ms > 0).slice(0, 5);
  const history = runs.map((h) => h.ms);
  const basis = history.length ? "history" as const : "default" as const;
  // La durée suit la taille de la commande quand on la connaît : temps par question des jobs passés
  // (ceux dont on connaît la commande), à défaut le temps par question par défaut du type.
  const perUnit = runs.filter((h) => h.n && h.n > 0).map((h) => h.ms / h.n!);
  const expected = units && perUnit.length
    ? median(perUnit) * units
    : history.length
      ? median(history)
      : units && DEFAULT_UNIT_MS[i.type] ? DEFAULT_UNIT_MS[i.type] * units : DEFAULT_MS[i.type] ?? 10 * MIN;
  const suffix = basis === "default" ? " (estimation sans historique)" : "";
  const progress = Math.min(100, Math.max(0, i.progress));
  const [lowF, highF] = spreadOf(history);
  const range = (ms: number) => ({ lowMs: Math.round(ms * lowF), highMs: Math.round(ms * highF) });

  if (i.status === "queued") {
    const once = Math.max(1, Math.round(expected / MIN));
    return { remainingMs: expected, late: false, basis, label: `En file : environ ${once} min une fois lancé${suffix}`, kind: "queued", minutes: once, ...range(expected) };
  }
  // Repris après une coupure : le temps écoulé depuis le PREMIER départ ne dit plus rien ; la
  // reprise repart du dernier point sauvegardé, il reste la part non faite.
  if (i.attempts > 0) {
    const remaining = expected * (1 - progress / 100);
    return { remainingMs: remaining, late: false, basis, label: `${minutes(remaining)} (reprise)${suffix}`, kind: "resumed", minutes: Math.round(remaining / MIN), ...range(remaining) };
  }
  if (i.elapsedMs > expected * LATE_FACTOR && progress < 95) {
    return { remainingMs: null, late: true, basis, label: "Plus long que d'habitude, la génération continue", kind: "late", minutes: null, lowMs: null, highMs: null };
  }
  // L'avancement peut être provisoirement haut avant que les contrôles ajoutent leurs lots de
  // reprise. Il ne doit donc jamais annoncer moins que le simple compte à rebours historique.
  // Les deux bornes décroissent à état constant ; seule l'ajout explicite d'un réessai peut faire
  // remonter la composante liée à l'avancement (lib/progress).
  const remaining = Math.max(expected * (1 - progress / 100), expected - i.elapsedMs, 0);
  return { remainingMs: remaining, late: false, basis, label: `${minutes(remaining)}${suffix}`, kind: "remaining", minutes: Math.round(remaining / MIN), ...range(remaining) };
}
