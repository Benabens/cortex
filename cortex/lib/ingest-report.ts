/**
 * Rapport par fichier d'une ingestion : ce que l'étudiant voit après « Préparer le cours » ou un
 * import de dossier. Un fichier qui ne se lit pas est isolé (les autres sont lus), puis nommé
 * ici avec la raison, au lieu de faire échouer tout le job ou de disparaître dans les journaux.
 *
 * Le script d'ingestion (processus enfant) l'écrit dans le fichier désigné par
 * CORTEX_INGEST_REPORT (lib/ingest-report-file) ; le worker le range dans `jobs.report_json`.
 * Module sans dépendance serveur : l'interface lit les mêmes types et les mêmes messages.
 */

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
 * Ce que l'étudiant lit pour un fichier non lu : la cause et quoi faire. Seul endroit où ces
 * messages s'écrivent (interface et connecteur MCP) ; en français, la langue de l'interface.
 */
const PROBLEM_MESSAGES: Record<Exclude<IngestFileStatus, "indexed">, string> = {
  unreadable: "fichier abîmé ou format non reconnu, il n’a pas pu être lu. Ré-exporte-le en PDF, puis dépose-le de nouveau.",
  encrypted: "PDF protégé par un mot de passe. Enregistre une copie sans protection, puis dépose-la de nouveau.",
  no_text: "aucun texte lisible (document scanné ?), il n’entre pas dans le corpus. Dépose une version au texte sélectionnable.",
};

/** La même cause en quelques mots, pour un résumé d'une ligne (connecteur MCP). */
const PROBLEM_SHORT: Record<Exclude<IngestFileStatus, "indexed">, string> = {
  unreadable: "abîmé ou illisible",
  encrypted: "protégé par un mot de passe",
  no_text: "sans texte, scanné ?",
};

export type IngestProblem = { path: string; name: string; status: Exclude<IngestFileStatus, "indexed">; message: string; short: string };

/** Les fichiers non lus d'un rapport, chacun avec sa consigne ; [] sans rapport. */
export function ingestProblems(report: IngestReport | null | undefined): IngestProblem[] {
  return (report?.files ?? []).flatMap((f) =>
    f.status === "indexed"
      ? []
      : [{ path: f.path, name: f.path.split("/").at(-1) ?? f.path, status: f.status, message: PROBLEM_MESSAGES[f.status], short: PROBLEM_SHORT[f.status] }],
  );
}
