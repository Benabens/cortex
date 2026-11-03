/**
 * AVANCEMENT D'UN JOB PAR PHASE — le temps restant d'une génération se lit sur son
 * avancement (lib/eta). Avant : chaque tâche publiait ses propres pourcentages fixes ; depuis
 * le parallélisme (M), les ouvertes publiaient 82 % dès le départ, puis les lots de QCM 30 %,
 * puis 70 %, et les lignes de journal 0 % : l'estimation remontait sans raison.
 *
 * Ici l'avancement est le travail fait, pesé par la durée de chaque phase : des groupes
 * successifs de phases parallèles (QCM ∥ ouvertes, puis PDF). Dans un groupe, c'est la phase
 * la plus en retard (le chemin critique) qui compte. Il ne recule que lorsqu'une unité de
 * travail est AJOUTÉE (un réessai : lot de comblement, ouverte relancée, nouvelle version).
 */

export type PhaseSpec = { name: string; units: number; ms: number };
type Phase = { units: number; done: number; ms: number };

export class PhaseProgress {
  private readonly groups: Map<string, Phase>[];

  /** `from` : l'avancement déjà publié avant ces phases (architecte, préparation). */
  constructor(private readonly from: number, groups: PhaseSpec[][]) {
    this.groups = groups.map((g) => new Map(g.map((p) => [p.name, { units: Math.max(0, p.units), done: 0, ms: Math.max(1, p.ms) }])));
  }

  private phase(name: string): Phase {
    for (const g of this.groups) {
      const p = g.get(name);
      if (p) return p;
    }
    throw new Error(`Phase inconnue : ${name}`);
  }

  /** `n` unités terminées. */
  done(name: string, n = 1): void {
    const p = this.phase(name);
    p.done = Math.min(p.units, p.done + n);
  }

  /** `n` unités de plus à faire : un réessai réellement ajouté, seul cas où l'avancement recule. */
  add(name: string, n = 1): void {
    this.phase(name).units += n;
  }

  /** Avancement entier, de `from` à 99 (100 est l'étape finale, lue « terminé » par le worker). */
  pct(): number {
    let total = 0;
    let remaining = 0;
    for (const g of this.groups) {
      const live = [...g.values()].filter((p) => p.units > 0);
      if (!live.length) continue;
      total += Math.max(...live.map((p) => p.ms));
      remaining += Math.max(...live.map((p) => p.ms * (1 - p.done / p.units)));
    }
    const frac = total ? 1 - remaining / total : 1;
    return Math.min(99, Math.floor(this.from + (100 - this.from) * frac));
  }
}

/** « ⏱ QCM : 5 min 12 s » : la durée d'une phase, dans le journal d'un job (relue par phaseDurationsFromLogs). */
export function phaseLine(label: string, ms: number): string {
  const s = Math.round(ms / 1000);
  return `⏱ ${label} : ${s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`}`;
}

const PHASE_LINE = /^⏱ (.+?) : (?:(\d+) min )?(\d+) s$/;

/**
 * Durée médiane de chaque phase dans les journaux des derniers jobs terminés : les poids de
 * l'avancement par phase. Une phase absente des journaux n'a pas d'entrée (défaut de l'appelant).
 */
export function phaseDurationsFromLogs(logs: { msg: string }[][]): Record<string, number> {
  const seen = new Map<string, number[]>();
  for (const log of logs) {
    for (const { msg } of log) {
      const m = PHASE_LINE.exec(msg.trim());
      if (!m) continue;
      seen.set(m[1], [...(seen.get(m[1]) ?? []), (Number(m[2] ?? 0) * 60 + Number(m[3])) * 1000]);
    }
  }
  const out: Record<string, number> = {};
  for (const [name, xs] of seen) {
    const s = [...xs].sort((a, b) => a - b);
    out[name] = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  }
  return out;
}
