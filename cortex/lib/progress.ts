/**
 * AVANCEMENT D'UN JOB PAR PHASE — le temps restant d'une génération se lit sur son
 * avancement (lib/eta). Avant : chaque tâche publiait ses propres pourcentages fixes ; depuis
 * le parallélisme (M), les ouvertes publiaient 82 % dès le départ, puis les lots de QCM 30 %,
 * puis 70 %, et les lignes de journal 0 % : l'estimation remontait sans raison.
 *
 * Ici l'avancement est le travail fait, pesé par la durée de chaque phase : des groupes
 * successifs de phases parallèles (QCM ∥ ouvertes, puis PDF). Dans un groupe, c'est la phase
 * la plus en retard (le chemin critique) qui compte. Les unités d'une phase peuvent peser leur
 * durée (`done(nom, poids)`), et un long appel au modèle sans étape intermédiaire avance avec le
 * temps attendu (`begin`), sans jamais compter en entier avant sa fin.
 *
 * Il ne recule jamais (24/11/2026) : un réessai AJOUTÉ (lot de comblement,
 * ouverte relancée, nouvelle version) se partage ce qui reste de la barre. Avant, la barre
 * reculait à chaque ronde (rejeu HUM-285 : 75 % → 55 %), le client la tenait figée à 75 % toute
 * la ronde, puis elle sautait. Le temps restant ne se sous-estime pas pour autant : lib/eta ne
 * descend jamais sous le compte à rebours historique, qui compte les rondes habituelles.
 */

export type PhaseSpec = { name: string; units: number; ms: number };
type Running = { weight: number; expectedMs: number; since: number };
type Phase = { units: number; done: number; ms: number; running: Set<Running> };

/**
 * Part d'un appel en cours déjà comptée, selon le temps écoulé sur sa durée attendue : 82 % à la
 * durée attendue, plafonnée à 95 % (un appel plus long que prévu avance encore, sans jamais finir
 * son étape avant de rendre).
 */
function creep(elapsedMs: number, expectedMs: number): number {
  return Math.min(0.95, 0.95 * (1 - Math.exp((-2 * Math.max(0, elapsedMs)) / Math.max(1, expectedMs))));
}

export class PhaseProgress {
  private readonly groups: Map<string, Phase>[];
  /** Dernier ajout de travail : l'avancement affiché alors et l'avancement brut juste après. */
  private anchor: { shown: number; raw: number } | null = null;

  /** `from` : l'avancement déjà publié avant ces phases (architecte, préparation). */
  constructor(private readonly from: number, groups: PhaseSpec[][]) {
    this.groups = groups.map((g) => new Map(g.map((p) => [p.name, { units: Math.max(0, p.units), done: 0, ms: Math.max(1, p.ms), running: new Set<Running>() }])));
  }

  private phase(name: string): Phase {
    for (const g of this.groups) {
      const p = g.get(name);
      if (p) return p;
    }
    throw new Error(`Phase inconnue : ${name}`);
  }

  /** `n` unités terminées (ou un poids, si les unités de la phase pèsent leur durée). */
  done(name: string, n = 1): void {
    const p = this.phase(name);
    p.done = Math.min(p.units, p.done + n);
  }

  /**
   * Un long appel commence : il compte `weight` unités une fois fini, et avance d'ici là avec le
   * temps, sur sa durée attendue. Rend la fin de l'appel (à appeler une fois, même en échec).
   */
  begin(name: string, weight: number, expectedMs: number, now = Date.now()): () => void {
    const p = this.phase(name);
    const r: Running = { weight, expectedMs, since: now };
    p.running.add(r);
    return () => {
      if (!p.running.delete(r)) return;
      this.done(name, weight);
    };
  }

  /** `n` unités de plus à faire : un réessai réellement ajouté. La barre garde sa place, le reste se partage. */
  add(name: string, n = 1, now = Date.now()): void {
    const shown = this.shown(now);
    this.phase(name).units += n;
    this.anchor = { shown, raw: this.raw(now) };
  }

  /** Avancement brut : le travail fait sur le travail connu, de `from` à 99. */
  private raw(now: number): number {
    let total = 0;
    let remaining = 0;
    for (const g of this.groups) {
      const live = [...g.values()].filter((p) => p.units > 0);
      if (!live.length) continue;
      const left = (p: Phase) => {
        const inFlight = [...p.running].reduce((a, r) => a + r.weight * creep(now - r.since, r.expectedMs), 0);
        return 1 - Math.min(p.units, p.done + inFlight) / p.units;
      };
      total += Math.max(...live.map((p) => p.ms));
      remaining += Math.max(...live.map((p) => p.ms * left(p)));
    }
    const frac = total ? 1 - remaining / total : 1;
    return Math.min(99, this.from + (100 - this.from) * frac);
  }

  /** L'avancement affiché : brut, ou, depuis un ajout de travail, ce qui restait alors partagé entre le travail connu. */
  private shown(now: number): number {
    const raw = this.raw(now);
    const a = this.anchor;
    if (!a) return raw;
    if (a.raw >= 99) return Math.max(a.shown, raw);
    if (raw <= a.raw) return a.shown;
    return a.shown + ((raw - a.raw) * (99 - a.shown)) / (99 - a.raw);
  }

  /** Avancement entier, de `from` à 99 (100 est l'étape finale, lue « terminé » par le worker). */
  pct(now = Date.now()): number {
    return Math.min(99, Math.floor(this.shown(now) + 1e-9));
  }
}

/**
 * Republie l'avancement pendant un long appel (unités `begin`), sans nouvelle ligne de journal :
 * toutes les `everyMs`, s'il a monté depuis la dernière publication (`seen` : celle d'une étape).
 */
export function progressTicker(read: () => number | null, publish: (p: number) => unknown, everyMs = 5_000): { seen(p: number): void; stop(): void } {
  let last = -1;
  const timer = setInterval(() => {
    const p = read();
    if (p == null || p <= last) return;
    last = p;
    // Une publication perdue (base occupée) : la suivante la rattrape.
    Promise.resolve().then(() => publish(p)).catch(() => {});
  }, everyMs);
  timer.unref?.();
  return { seen: (p) => { last = Math.max(last, p); }, stop: () => clearInterval(timer) };
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
