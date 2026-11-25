import crypto from "node:crypto";
import { currentCourse, hasCourseContext } from "@/db/client";
import { currentUser } from "@/db/context";
import { tryGetCourse } from "@/lib/courses";
import { currentJob } from "@/lib/billing/usage-context";
import type { IngestReport } from "@/lib/ingest-report";
import { captureError, markReported } from "@/lib/observability";

/**
 * ÉCHEC QUI TOUCHE UN ÉTUDIANT → SENTRY, avec un vocabulaire fixe (décision du 25/11/2026 : Ben
 * est prévenu sans aller voir lui-même). Chaque site d'échec appelle reportFailure une fois ;
 * Sentry regroupe par (nature, type de job, code d'erreur) — jamais par message, qui varie d'un
 * cours à l'autre et peut en citer le contenu.
 *
 * Ce qui part : des étiquettes techniques et une empreinte de compte. Ce qui ne part jamais :
 * e-mail, identifiant de compte, nom ou contenu de cours (le message de l'exception est une
 * phrase fixe fabriquée ici ; le détail reste dans le journal du job).
 */
export type FailureKind =
  /** Job en échec définitif (worker) : l'étudiant n'a rien reçu. */
  | "job_failed"
  /** Job abandonné par la réconciliation : worker mort, tentatives épuisées. */
  | "job_abandoned"
  /** Examen livré incomplet : des questions manquent, remboursées au prorata. */
  | "exam_incomplete"
  /** PDF de l'examen non compilé même après le repli : seule la version web reste. */
  | "pdf_failed"
  /** PDF du corrigé non compilé : l'étudiant ne reçoit pas le corrigé en PDF. */
  | "answer_key_pdf_failed"
  /** Remboursement de crédits dû mais pas appliqué (exception) : l'étudiant a payé pour rien. */
  | "refund_failed"
  /** Fichiers d'un cours illisibles à l'ingestion. */
  | "ingest_files_failed"
  /** Appel au modèle en échec après les relances, hors job (aide synchrone, connecteur). */
  | "llm_failed"
  /** Étape de contrôle sautée en cours de job (relecture, vérification) : livré, mais moins vérifié. */
  | "generation_degraded";

export type FailureReport = {
  failure: FailureKind;
  level: "error" | "warning";
  /** Code d'erreur de l'app (clé de `errors.*`) ou de LlmError ; stable, sans paramètre. */
  code: string;
  /** Sinon : le job du process (worker), s'il y en a un. */
  jobType?: string;
  /** Sinon : déduit du cours courant. */
  courseKind?: CourseKind;
  /** Étiquettes techniques en plus (compteurs, oui/non) : jamais de texte libre. */
  extra?: Record<string, string>;
  /** L'exception d'origine, quand elle existe : relevée plus haut (route, outil MCP), elle ne refait pas d'événement. */
  exception?: unknown;
};

export type CourseKind = "curated" | "generic" | "unknown";

/** Domaine, comme les autres alertes de l'app (lib/storage-quota, lib/backup-schedule) : `area`. */
const AREA: Record<FailureKind, string> = {
  job_failed: "jobs", job_abandoned: "jobs", exam_incomplete: "jobs", pdf_failed: "pdf", answer_key_pdf_failed: "pdf",
  refund_failed: "billing", ingest_files_failed: "ingest", llm_failed: "llm", generation_degraded: "jobs",
};

/**
 * Refus voulus qui finissent un job : plafonds de dépense, cours sans support. L'étudiant n'a
 * rien, mais Cortex a fait ce qu'il doit (et rembourse) : avertissement, pas erreur.
 */
const REFUSAL_CODES = new Set(["llm_global_spend_cap", "llm_user_spend_cap", "llm_reservation_spend_cap", "job_corpus_missing"]);

/** Niveau de l'échec d'un job selon son code : un refus voulu n'est pas une panne. */
export function jobFailureLevel(code: string): "error" | "warning" {
  return REFUSAL_CODES.has(code) ? "warning" : "error";
}

/**
 * Empreinte anonyme d'un compte : HMAC par une clé du serveur, pour qu'une liste d'e-mails
 * hachés ne la retrouve pas. Même compte → même empreinte : Sentry compte les étudiants touchés.
 */
export function userHash(userId: string): string {
  const key = process.env.AUTH_SECRET?.trim() || "cortex-local-sans-secret";
  return crypto.createHmac("sha256", key).update(`sentry-user:${userId}`).digest("hex").slice(0, 12);
}

/** Cours à profil curaté (lib/profiles) ou générique ; inconnu hors contexte de cours. */
export function courseKindOf(courseId?: string): CourseKind {
  // Sans contexte, currentCourse() rend cs-202 par défaut : ce serait « curated » à tort.
  if (courseId === undefined && !hasCourseContext()) return "unknown";
  try {
    const c = tryGetCourse(courseId ?? currentCourse());
    return !c ? "unknown" : c.profileId ? "curated" : "generic";
  } catch {
    return "unknown";
  }
}

/** Code réduit à un jeton sûr : un code ne doit jamais devenir un canal pour du texte. */
function token(s: string | undefined, fallback = "none"): string {
  const t = (s ?? "").toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_").slice(0, 48);
  return t || fallback;
}

/** Envoie l'événement (no-op sans SENTRY_DSN). Ne lève jamais. */
export function reportFailure(f: FailureReport): void {
  try {
    const code = token(f.code);
    // Même vocabulaire partout : la réservation d'une aide dit « assist_drill », le job « drill ».
    const jobType = token((f.jobType ?? currentJob()?.type)?.replace(/^assist_/, ""), "-");
    const tags: Record<string, string> = {};
    // Les étiquettes en plus d'abord : elles ne peuvent pas écraser les étiquettes de base.
    for (const [k, v] of Object.entries(f.extra ?? {})) tags[token(k)] = token(v);
    Object.assign(tags, {
      area: AREA[f.failure],
      failure: f.failure,
      job_type: jobType,
      course_kind: f.courseKind ?? courseKindOf(),
      error_code: code,
      user_hash: userHash(currentUser()),
    });
    markReported(f.exception);
    const what = jobType === "-" ? f.failure : `${f.failure} (${jobType})`;
    captureError(new Error(`Échec étudiant : ${what}, code ${code}`), tags, {
      level: f.level,
      fingerprint: ["cortex", f.failure, jobType, code],
    });
  } catch {
    /* le suivi d'erreurs ne doit jamais casser le chemin d'exécution */
  }
}

/**
 * Fichiers illisibles à l'ingestion : l'étudiant le voit sur sa page, mais une régression du
 * lecteur se lirait ici chez tous à la fois. Un PDF chiffré ou sans texte est un fait du fichier,
 * pas une panne : pas d'alerte. Un événement par ingestion, jamais de nom de fichier.
 */
export function reportIngestProblems(report: IngestReport | null | undefined, jobType: string): void {
  const unreadable = report?.files.filter((f) => f.status === "unreadable").length ?? 0;
  if (!unreadable) return;
  reportFailure({ failure: "ingest_files_failed", level: "warning", code: "unreadable", jobType, extra: { files_unreadable: String(unreadable) } });
}

/** PDF du corrigé non compilé (exam-latex, qcm-latex) : l'examen est livré, le corrigé PDF manque. */
export function reportAnswerKeyPdfFailure(): void {
  reportFailure({ failure: "answer_key_pdf_failed", level: "warning", code: "answer_key_pdf" });
}

/**
 * Étape de contrôle sautée en cours de job parce que l'appel au modèle a échoué : le résultat
 * part quand même, moins vérifié. `step` est un nom de site fixe (jamais un message).
 */
export function reportDegraded(step: string, exception?: unknown): void {
  const code = (exception as { code?: unknown } | null)?.code;
  // Job annulé par l'étudiant : l'appel en vol s'arrête, ce n'est pas une étape sautée.
  if (code === "ABORTED") return;
  reportFailure({
    failure: "generation_degraded", level: "warning", code: step,
    extra: { cause: typeof code === "string" ? code : "unknown" }, exception,
  });
}
