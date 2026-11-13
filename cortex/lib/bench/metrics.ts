import { phaseDurationsFromLogs } from "../progress";
import type { BenchRun, Verdicts } from "./types";

/**
 * MESURES D'UN RUN DU BANC — pures : rien que les faits du run exporté (lib/bench/types).
 * Les verdicts du juge (fidélité, doublons, distracteurs, hors cours) s'ajoutent à part
 * (lib/bench/judge) ; les seuils de Ben se lisent dans lib/bench/thresholds.
 */

/** Panne ou saturation du fournisseur (y compris la limite d'usage de l'abonnement) : exclue du seuil de livraison. */
const OUTAGE = /surcharg|injoignable|OVERLOADED|RATE_LIMIT|UPSTREAM|NETWORK|usage limit|limite d'utilisation/i;

export type Delivery = {
  requested: number;
  delivered: number;
  /** Part du débit à rendre, en ‰ : manque / demandé (tout si rien n'est livré). */
  expectedRefundMilli: number;
  refundedMilli: number | null;
  /** Remboursement conforme à ±1 ‰ (null : facturation inactive). */
  refundOk: boolean | null;
  providerOutage: boolean;
  /** Refus propre attendu par le cas (rien livré, rien débité). */
  refusedAsExpected: boolean;
};

export type Coverage = {
  chapters: number;
  /** Chapitres du plan sans aucune question. */
  zeroChapters: number;
  /** Chapitres à 0 inévitables : plus de chapitres que de questions (max(0, chapitres − questions)). */
  allowedZero: number;
  perChapter: { id: number; title: string; n: number }[];
  /** Questions rattachées à aucun chapitre du plan. */
  unmapped: number;
  /** Notions distinctes (sous-thèmes) posées. */
  notions: number;
  /** Demande avec focus : part des questions sur le chapitre visé (null sans focus ou chapitre introuvable). */
  focusShare: number | null;
};

/** Mesures qui dépendent du juge : null sans verdicts. */
export type Fidelity = {
  judged: number;
  /** Clés tranchées (justes ou fausses) ; les « incertaines » sont comptées à part. */
  keysChecked: number;
  keysWrong: number;
  keysUnsure: number;
  keyAccuracy: number;
  codeRuns: number;
  codeWrong: number;
  definitionMismatch: number;
  incoherentExplanations: number;
};
export type Duplicates = { intra: number; previous: number };
export type Difficulty = { distractors: number; trivial: number; trivialShare: number };
export type OffCourse = {
  offCourseRejects: number;
  /** Rejets « hors cours » alors que le cours traite la notion. */
  falseRejections: number;
  /** Faux rejets / items passés au contrôle (livrés + rejetés hors cours). */
  falseRejectionRate: number;
  /** Questions livrées que le juge trouve hors cours. */
  leaked: number;
};

export type Render = { statementPdf: boolean; corrigePdf: boolean; web: boolean };

/**
 * Performance. Durées et nombre d'appels : MESURÉS sur le provider du run.
 * Tokens d'entrée, cache de prompt et coût $ : ESTIMÉS (≈ 4 caractères par token, tarif de
 * l'API, cache = même prompt système dans les 5 min) — le CLI ne les mesure pas comme l'API.
 */
export type Perf = {
  totalMs: number;
  phases: Record<string, number>;
  calls: number;
  /** Réponses JSON illisibles redemandées (completeJson) : l'API à sortie structurée en aurait moins. */
  jsonRetries: number;
  /** Réessais du fournisseur (tentative > 1 dans llm_usage). */
  providerRetries: number;
  topupBatches: number;
  dedupReplacements: number;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheRate: number;
  costUsd: number;
  estimated: true;
};

export type Ux = {
  /** Reculs de l'avancement entre deux relevés. */
  regressions: number;
  /** Reculs sans réessai annoncé dans le journal : le temps restant remonte sans raison. */
  unexplainedRegressions: number;
  monotone: boolean;
  /** Erreur relative médiane du temps restant affiché (un « en retard » compte 100 %) ; null sans relevé. */
  etaMedianError: number | null;
};

export type Metrics = {
  delivery: Delivery;
  coverage: Coverage;
  fidelity: Fidelity | null;
  duplicates: Duplicates | null;
  difficulty: Difficulty | null;
  offCourse: OffCourse | null;
  render: Render;
  perf: Perf;
  ux: Ux;
};

function delivery(r: BenchRun): Delivery {
  const requested = r.request.requested;
  const delivered = r.exam?.items.length ?? 0;
  const refused = !!r.refusal && !r.job;
  const expectedRefundMilli = refused || !r.billing?.debited
    ? 0
    : r.job?.status === "done" ? Math.min(1000, Math.max(0, Math.round((1000 * (requested - delivered)) / Math.max(1, requested)))) : 1000;
  const refundedMilli = r.billing ? r.billing.refundedMilli : null;
  return {
    requested, delivered, expectedRefundMilli, refundedMilli,
    refundOk: refundedMilli === null ? null : Math.abs(refundedMilli - expectedRefundMilli) <= 1,
    providerOutage: OUTAGE.test(r.job?.error ?? ""),
    refusedAsExpected: !!r.request.expectRefusal && refused && !r.billing?.debited,
  };
}

const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

function coverage(r: BenchRun, v?: Verdicts): Coverage {
  const items = r.exam?.items ?? [];
  const judged = new Map((v?.items ?? []).map((x) => [x.idx, x]));
  const chapterOf = (idx: number, topic: string | null): number | null =>
    judged.get(idx)?.chapter ?? (topic != null ? r.plan.topicChapter[topic] ?? null : null);
  const known = new Set(r.plan.chapters.map((c) => c.id));
  const counts = new Map<number, number>();
  let unmapped = 0;
  for (const it of items) {
    const ch = chapterOf(it.idx, it.topic);
    if (ch == null || !known.has(ch)) unmapped++;
    else counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  const perChapter = [...r.plan.chapters].sort((a, b) => a.seq - b.seq).map((c) => ({ id: c.id, title: c.title, n: counts.get(c.id) ?? 0 }));
  const focus = typeof r.request.target.focus === "string" ? norm(r.request.target.focus) : "";
  const target = focus ? perChapter.find((c) => norm(c.title).includes(focus) || focus.includes(norm(c.title))) : undefined;
  const notions = new Set(items.map((it) => norm(judged.get(it.idx)?.notion || it.topic || it.stem.slice(0, 60))));
  return {
    chapters: perChapter.length,
    zeroChapters: perChapter.filter((c) => c.n === 0).length,
    allowedZero: Math.max(0, perChapter.length - items.length),
    perChapter, unmapped, notions: notions.size,
    focusShare: target && items.length ? target.n / items.length : null,
  };
}

function judgedQuality(r: BenchRun, v: Verdicts): Pick<Metrics, "fidelity" | "duplicates" | "difficulty" | "offCourse"> {
  const items = v.items;
  const right = items.filter((x) => x.key === "right").length;
  const wrong = items.filter((x) => x.key === "wrong").length;
  const runs = items.filter((x) => x.code?.ran);
  const distractors = items.reduce((s, x) => s + x.distractors, 0);
  const trivial = items.reduce((s, x) => s + x.trivialDistractors, 0);
  const offRejects = v.rejected.filter((x) => x.offCourseReject);
  const seen = (r.exam?.items.length ?? 0) + offRejects.length;
  const falseRejections = offRejects.filter((x) => x.falseRejection).length;
  return {
    fidelity: {
      judged: items.length, keysChecked: right + wrong, keysWrong: wrong, keysUnsure: items.filter((x) => x.key === "unsure").length,
      keyAccuracy: right + wrong ? right / (right + wrong) : 1,
      codeRuns: runs.length, codeWrong: runs.filter((x) => !x.code?.ok).length,
      definitionMismatch: items.filter((x) => x.definition === "mismatch").length,
      incoherentExplanations: items.filter((x) => x.explanation === "inconsistent").length,
    },
    duplicates: { intra: new Set(v.duplicatesIntra.map(([, b]) => b)).size, previous: new Set(v.duplicatesPrevious).size },
    difficulty: { distractors, trivial, trivialShare: distractors ? trivial / distractors : 0 },
    offCourse: { offCourseRejects: offRejects.length, falseRejections, falseRejectionRate: seen ? falseRejections / seen : 0, leaked: items.filter((x) => x.offCourse).length },
  };
}

function render(r: BenchRun): Render {
  const ok = (p: BenchRun["render"]["statement"]) => !!p && p.exists && p.pages > 0 && p.textChars > 0;
  return { statementPdf: ok(r.render.statement), corrigePdf: ok(r.render.corrige), web: r.render.web.ok && r.render.web.items === (r.exam?.items.length ?? 0) };
}

/** Lignes du journal qui AJOUTENT du travail (lib/progress : seuls cas où l'avancement peut reculer). */
const RETRY_LINE = /lot\(s\) de comblement|nouvel essai|→ remplacement|nouvelle version|réessai/i;
const TOPUP_LINE = /lot\(s\) de comblement/;
const DEDUP_LINE = /doublon retiré\(s\).*→ remplacement/;
const CHARS_PER_TOKEN = 4;
const CACHE_TTL_MS = 5 * 60_000;

const dbTime = (s: string) => Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(" ", "T") : `${s.replace(" ", "T")}Z`);

function perf(r: BenchRun): Perf {
  const log = r.job?.log ?? [];
  const totalMs = r.job ? Math.max(0, dbTime(r.job.updatedAt) - dbTime(r.job.createdAt)) : 0;
  let tokensIn = 0, tokensOut = 0, cacheRead = 0, cost = 0;
  const lastWrite = new Map<string, number>();
  for (const c of r.calls) {
    const rate = r.rates[c.model] ?? r.rates.opus ?? { inPerM: 0, outPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 };
    const sys = Math.round(c.systemChars / CHARS_PER_TOKEN);
    const total = Math.round((c.promptChars + c.systemChars) / CHARS_PER_TOKEN);
    const out = Math.round(c.outputChars / CHARS_PER_TOKEN);
    let read = 0, write = 0;
    if (sys && c.systemHash) {
      const prev = lastWrite.get(c.systemHash);
      if (prev !== undefined && c.at !== undefined && c.at - prev <= CACHE_TTL_MS) read = sys;
      else write = sys;
      // Une lecture prolonge la durée de vie de l'entrée du cache.
      if (c.at !== undefined) lastWrite.set(c.systemHash, c.at);
    }
    tokensIn += total; tokensOut += out; cacheRead += read;
    cost += ((total - read - write) * rate.inPerM + write * rate.cacheWritePerM + read * rate.cacheReadPerM + out * rate.outPerM) / 1e6;
  }
  return {
    totalMs, phases: phaseDurationsFromLogs([log]),
    calls: r.calls.length,
    jsonRetries: r.calls.filter((c) => c.jsonRetry).length,
    providerRetries: r.usage.filter((u) => u.attempt > 1).length,
    topupBatches: log.filter((l) => TOPUP_LINE.test(l.msg)).length,
    dedupReplacements: log.filter((l) => DEDUP_LINE.test(l.msg)).length,
    tokensIn, tokensOut, cacheReadTokens: cacheRead, cacheRate: tokensIn ? cacheRead / tokensIn : 0, costUsd: cost, estimated: true,
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function ux(r: BenchRun): Ux {
  const t0 = Date.parse(r.startedAt);
  const retries = (r.job?.log ?? []).filter((l) => RETRY_LINE.test(l.msg)).map((l) => Date.parse(l.t) - t0);
  let regressions = 0, unexplained = 0;
  for (let i = 1; i < r.samples.length; i++) {
    const [a, b] = [r.samples[i - 1], r.samples[i]];
    if (b.progress >= a.progress) continue;
    regressions++;
    // Le recul s'affiche au relevé qui suit l'ajout du réessai (marge : la colonne se met à jour à l'étape suivante).
    if (!retries.some((t) => t > a.t - 30_000 && t <= b.t)) unexplained++;
  }
  const end = r.job ? dbTime(r.job.updatedAt) - dbTime(r.job.createdAt) : 0;
  const errors = r.samples
    .filter((s) => ["running", "verifying", "compiling"].includes(s.status) && end > 0 && s.t < end)
    .map((s) => (s.late || s.etaMs === null ? 1 : Math.abs(s.etaMs - (end - s.t)) / Math.max(end - s.t, 60_000)));
  return { regressions, unexplainedRegressions: unexplained, monotone: unexplained === 0, etaMedianError: errors.length ? median(errors) : null };
}

export function measureRun(r: BenchRun, verdicts?: Verdicts): Metrics {
  const judged = verdicts ? judgedQuality(r, verdicts) : { fidelity: null, duplicates: null, difficulty: null, offCourse: null };
  return { delivery: delivery(r), coverage: coverage(r, verdicts), ...judged, render: render(r), perf: perf(r), ux: ux(r) };
}
