/**
 * RUN DU BANC — ce que scripts/bench.ts exporte d'une génération (cours restauré + une
 * demande), et ce que lib/bench/metrics.ts en mesure. Le run ne contient que des faits
 * relevés (base, journal, fichiers, bande LLM) ; le juge ajoute ses verdicts à part.
 */

export type BenchItem = {
  /** Rang dans l'examen (0…) ; une question composée compte pour une. */
  idx: number;
  kind: "qcm" | "open" | "exercise" | "block";
  topic: string | null;
  stem: string;
  options?: string[];
  correct?: number[];
  explanation?: string;
  solution?: string;
  /** Question composée (lib/blocks) : ses sous-questions, QCM ou réponse courte. */
  parts?: { prompt: string; code?: string; options?: string[]; correct?: number; answer?: string; explanation?: string }[];
};

export type PdfCheck = { file: string; exists: boolean; pages: number; textChars: number };

export type TapeCall = {
  site: string; model: string; promptChars: number; systemChars: number; outputChars: number; ms: number;
  /** Empreinte du prompt système (cache de prompt de l'API : même préfixe = lecture en cache). */
  systemHash?: string;
  /** Redemande de completeJson après une réponse JSON illisible. */
  jsonRetry?: boolean;
  /** Instant de l'appel (ms depuis l'époque) : fenêtre de 5 min du cache de prompt. */
  at?: number;
  error?: string;
};

/** Tarif $ par million de tokens, par modèle logique (estimation du coût API, jamais mesuré). */
export type Rates = Record<string, { inPerM: number; outPerM: number; cacheReadPerM: number; cacheWritePerM: number }>;

export type BenchRun = {
  caseId: string;
  commit: string;
  provider: string;
  startedAt: string;
  finishedAt: string;
  request: {
    job: string;
    target: Record<string, unknown>;
    /** Questions commandées (QCM + ouvertes, exercices, ou questions composées). */
    requested: number;
    /** Le cas attend un refus propre (ex. aucun format connu) : rien livré, rien débité. */
    expectRefusal?: boolean;
  };
  /** Refus à la création du job (avant tout débit) : son message. */
  refusal?: string;
  job: null | { id: number; status: string; error: string | null; log: { t: string; msg: string }[]; createdAt: string; updatedAt: string; resultId: number | null };
  /** Relevés de l'avancement et du temps restant affichés, toutes les ~2 s (t = ms depuis le lancement). */
  samples: { t: number; progress: number; status: string; etaMs: number | null; late: boolean; step: string }[];
  exam: null | { id: number; kind: "qcm" | "exercises" | "blocks"; items: BenchItem[] };
  render: { statement: PdfCheck | null; corrige: PdfCheck | null; web: { ok: boolean; items: number; error?: string } };
  plan: { chapters: { id: number; seq: number; title: string }[]; topicChapter: Record<string, number | null> };
  /** Questions des examens générés AVANT ce run (doublons « vs examens précédents »). */
  previous: { stem: string; topic: string | null }[];
  usage: { site: string | null; model: string; tokensIn: number; tokensOut: number; attempt: number; latencyMs: number | null }[];
  calls: TapeCall[];
  /** Tarifs de l'API au jour du run, pour estimer ce que le run aurait coûté en prod. */
  rates: Rates;
  /** Débit et parts remboursées (‰ du débit) ; null si la facturation n'était pas active. */
  billing: null | { debited: boolean; refundedMilli: number };
  /** Items écartés par le moteur (trace du banc) : stem, options, raison. */
  rejected: { stem: string; options?: string[]; correct?: number[]; reason: string }[];
};

/** Verdict du juge sur une question (lib/bench/judge), à l'aveugle : il ne sait pas quel code l'a produite. */
export type ItemVerdict = {
  idx: number;
  /** Chapitre du plan (plan_chapters.id) dont relève la question, selon le juge. */
  chapter: number | null;
  notion: string;
  /** Clé vérifiée par une résolution indépendante (puis arbitrage si désaccord). */
  key: "right" | "wrong" | "unsure" | "na";
  explanation: "consistent" | "inconsistent" | "na";
  definition: "conform" | "mismatch" | "na";
  offCourse: boolean;
  distractors: number;
  trivialDistractors: number;
  /** Code exécuté pour vérifier la clé (lib/sandbox-exec) quand la réponse en dépend. */
  code?: { ran: boolean; ok: boolean; detail: string };
};

export type Verdicts = {
  rubric: string;
  judgeModel: string;
  items: ItemVerdict[];
  /** Paires de questions sur la même notion sans angle distinct (la seconde compte). */
  duplicatesIntra: [number, number][];
  /** Questions qui reprennent une question d'un examen précédent. */
  duplicatesPrevious: number[];
  /** Items écartés « hors cours » par le moteur et pourtant dans le cours. */
  rejected: { idx: number; offCourseReject: boolean; falseRejection: boolean }[];
};
