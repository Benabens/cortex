/**
 * Rapport par fichier d'une ingestion : ce que l'étudiant voit après « Préparer le cours » ou un
 * import de dossier. Un fichier qui ne se lit pas est isolé (les autres sont lus), puis nommé
 * ici avec la raison, au lieu de faire échouer tout le job ou de disparaître dans les journaux.
 *
 * Le script d'ingestion (processus enfant) l'écrit dans le fichier désigné par
 * CORTEX_INGEST_REPORT (lib/ingest-report-file) ; le worker le range dans `jobs.report_json`.
 * Module sans dépendance serveur : l'interface lit les mêmes types et les mêmes messages.
 */
import { currentLocale } from "@/lib/i18n/current";
import type { Locale } from "@/lib/i18n/locale";
import { translator } from "@/lib/i18n/translate";

/** indexed : lu ; unreadable : abîmé ou format faux ; encrypted : protégé par mot de passe ; no_text : aucun texte (scan). */
export type IngestFileStatus = "indexed" | "unreadable" | "encrypted" | "no_text";
export type IngestFileOutcome = { path: string; status: IngestFileStatus; items: number };
export type IngestReport = { files: IngestFileOutcome[] };

export const INGEST_REPORT_ENV = "CORTEX_INGEST_REPORT";

/** La raison d'un échec de lecture : pdf.js lève PasswordException pour un PDF chiffré. */
export function failureStatus(error: unknown): "encrypted" | "unreadable" {
  return (error as { name?: string } | null)?.name === "PasswordException" ? "encrypted" : "unreadable";
}

/** Un fichier lu : `no_text` s'il n'a donné aucun passage indexable. */
export function readStatus(items: number): "indexed" | "no_text" {
  return items > 0 ? "indexed" : "no_text";
}

/** Préfixe de la dernière ligne d'une ingestion qui échoue : le worker en tire le message du job. */
export const INGEST_FAILURE_PREFIX = "Échec ingestion : ";

/**
 * Le message d'un job dont l'ingestion a échoué, tiré de sa sortie : la ligne préfixée, jamais
 * la dernière ligne brute (une erreur imprimée en objet finit par « } »).
 */
export function ingestFailureMessage(lines: string[], code: number | null): string {
  const line = lines.findLast((l) => l.startsWith(INGEST_FAILURE_PREFIX));
  const detail = line?.slice(INGEST_FAILURE_PREFIX.length).trim();
  return detail ? `L’ingestion a échoué : ${detail}` : `L’ingestion a échoué (code ${code ?? "inconnu"}).`;
}

/**
 * Ce que l'étudiant lit pour un fichier non lu : la cause et quoi faire (dictionnaire
 * `ingestReport`, interface et connecteur MCP). Dans le navigateur, l'appelant passe la langue
 * de useLocale() ; côté serveur, celle de la requête.
 */
const PROBLEM_KEY = { unreadable: "unreadable", encrypted: "encrypted", no_text: "noText" } as const;

export function problemMessage(status: Exclude<IngestFileStatus, "indexed">, locale: Locale = currentLocale()): string {
  return translator(locale)(`ingestReport.${PROBLEM_KEY[status]}`);
}

/** La même cause en quelques mots, pour un résumé d'une ligne (connecteur MCP). */
function problemShort(status: Exclude<IngestFileStatus, "indexed">, locale: Locale): string {
  return translator(locale)(`ingestReport.short.${PROBLEM_KEY[status]}`);
}

export type IngestProblem = { path: string; name: string; status: Exclude<IngestFileStatus, "indexed">; message: string; short: string };

/** Les fichiers non lus d'un rapport, chacun avec sa consigne ; [] sans rapport. */
export function ingestProblems(report: IngestReport | null | undefined, locale: Locale = currentLocale()): IngestProblem[] {
  return (report?.files ?? []).flatMap((f) =>
    f.status === "indexed"
      ? []
      : [{ path: f.path, name: f.path.split("/").at(-1) ?? f.path, status: f.status, message: problemMessage(f.status, locale), short: problemShort(f.status, locale) }],
  );
}
