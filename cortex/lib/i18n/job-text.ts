import type { Eta } from "@/lib/eta";
import { llmErrorCode, llmUserError } from "@/lib/llm/errors";
import { fmt } from "./format";
import type { Locale } from "./locale";
import { translator } from "./translate";
import { errorText, isUserError, userError, type UserError } from "./user-error";

/**
 * LE SUIVI D'UN JOB DANS LA LANGUE DE SON LECTEUR. Le worker écrit des phrases françaises
 * (étape, temps restant, erreur) : elles font le journal et restent ce que lit un lecteur
 * français, inchangées. À côté, il range ce qu'elles disent sans langue (`errorInfo`,
 * `stepInfo`, les champs `kind` / `minutes` du temps restant) : c'est de là que se refait la
 * phrase pour un autre lecteur. Une étape intermédiaire (« Lot QCM 2/4… », 200 phrases dans le
 * moteur) n'a pas d'équivalent traduit : elle devient l'étape générique de son type de job.
 */

/** Erreur d'un job : un code stable de `errors.*`, et les crédits rendus après l'échec. */
export type JobError = UserError & { creditsBackCenti?: number };

/** Étapes qui portent une information (fin incomplète, reprise) ; les autres se déduisent du statut. */
export type JobStepInfo =
  | { key: "done" }
  | { key: "doneIncomplete"; missing: number; requested: number; backCenti?: number }
  | { key: "resumed"; attempt: number; max: number }
  | { key: "waiting"; position: number; ingest: boolean };

export type LocalizableJob = {
  type: string;
  status: string;
  currentStep: string | null;
  error: string | null;
  errorInfo?: JobError | null;
  stepInfo?: JobStepInfo | null;
};

export type LocalizedJobText = { currentStep: string | null; error: string | null; eta: string | null };

/** Centièmes de crédit → crédits (même unité que lib/billing/credits, sans importer la facturation). */
const credits = (centi: number) => centi / 100;

/**
 * `fallback` : ce que devient un texte sans équivalent rangé pour un lecteur non francophone.
 * « generic » (interface) : l'étape générique, ou « La génération a échoué ». « raw » (connecteur
 * MCP) : la phrase d'origine, que le modèle reformule pour l'étudiant sans perdre le détail.
 */
export function localizeJob(job: LocalizableJob, eta: Eta | null, locale: Locale, opts: { fallback?: "generic" | "raw" } = {}): LocalizedJobText {
  if (locale === "fr") return { currentStep: job.currentStep, error: job.error, eta: eta?.label ?? null };
  const generic = (opts.fallback ?? "generic") === "generic";
  return {
    currentStep: stepText(job, locale, generic),
    error: errorOf(job, locale, generic),
    eta: eta ? etaText(eta, locale) : null,
  };
}

export function etaText(eta: Eta, locale: Locale): string {
  const t = translator(locale);
  const text = eta.kind === "queued" ? t("jobText.etaQueued", { minutes: eta.minutes ?? 1 })
    : eta.kind === "late" ? t("jobText.etaLate")
    : eta.kind === "resumed" ? t("jobText.etaResumed", { minutes: eta.minutes ?? 0 })
    : t("jobText.etaRemaining", { minutes: eta.minutes ?? 0 });
  return eta.basis === "default" && eta.kind !== "late" ? t("jobText.etaNoHistory", { eta: text }) : text;
}

function stepText(job: LocalizableJob, locale: Locale, generic: boolean): string | null {
  const t = translator(locale);
  const info = job.stepInfo;
  if (info?.key === "done") return t("jobText.stepDone");
  if (info?.key === "doneIncomplete") return t("jobText.stepDoneIncomplete", { shortfall: shortfallText(info, locale) });
  if (info?.key === "resumed" && job.status === "queued") return t("jobText.stepResumed", { attempt: info.attempt, max: info.max });
  if (info?.key === "waiting" && job.status === "queued") return t("jobText.stepWaiting", { position: info.position, what: info.ingest ? "ingest" : "generation" });
  if (!job.currentStep || !generic) return job.currentStep;
  switch (job.status) {
    case "queued": return t("jobText.stepQueued");
    case "running": case "verifying": case "compiling": return t("jobText.stepRunning", { type: job.type === "lab-exercise" ? "lab" : job.type });
    case "done": return t("jobText.stepDone");
    case "canceled": return t("jobText.stepCanceled");
    default: return t("jobText.stepFailed");
  }
}

export function shortfallText(s: { missing: number; requested: number; backCenti?: number }, locale: Locale): string {
  const t = translator(locale);
  const what = t("jobText.shortfall", { missing: s.missing, requested: s.requested });
  if (!s.backCenti || s.backCenti <= 0) return what;
  const back = credits(s.backCenti);
  return t("jobText.shortfallBack", { shortfall: what, credits: fmt(locale).number(back), back });
}

function errorOf(job: LocalizableJob, locale: Locale, generic: boolean): string | null {
  // « job_failed » ne dit rien de plus que l'échec : le connecteur garde alors la phrase d'origine.
  const info = job.errorInfo?.code === "job_failed" && !generic ? null : job.errorInfo;
  if (!info) {
    if (!job.error || !generic) return job.error;
    // Sans code rangé : l'échec dit en clair ; ailleurs (examen livré, PDF en échec), un détail technique.
    return job.status === "error" ? errorText(locale, { code: "job_failed" }) : null;
  }
  const text = errorText(locale, info);
  if (!info.creditsBackCenti || info.creditsBackCenti <= 0) return text;
  const back = credits(info.creditsBackCenti);
  return translator(locale)("jobText.errorBack", { error: text.replace(/[.\s]+$/u, ""), credits: fmt(locale).number(back), back });
}

/**
 * L'erreur sans langue d'une exception qui fait échouer un job : la sienne (UserFacingError,
 * `userError` posé par une garde), sinon celle de l'appel au modèle qu'elle enveloppe (`cause`,
 * « Aucun QCM généré : <cause> »), sinon « la génération a échoué ».
 */
export function jobErrorOf(e: unknown): UserError {
  let x: unknown = e;
  for (let depth = 0; x && depth < 5; depth++) {
    const own = (x as { userError?: unknown }).userError;
    if (isUserError(own)) return own.params ? userError(own.code, own.params) : userError(own.code);
    if (isUserError(x)) return x.params ? userError(x.code, x.params) : userError(x.code);
    if (llmErrorCode(x)) return llmUserError(x);
    x = (x as { cause?: unknown }).cause;
  }
  return userError("job_failed");
}
