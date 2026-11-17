import { q } from "@/db/q";
import { jobSpec, launchGate } from "@/lib/billing/limits";
import { llmUnavailableReason } from "@/lib/llm";
import { texAvailable } from "@/lib/exam-latex";
import { GENERATION_MIN_FREE_BYTES, checkStorage } from "@/lib/storage-quota";
import { currentUser } from "@/db/context";
import { refusal, type Refusal } from "@/lib/i18n/user-error";

export type PreflightIssue = Refusal & { command?: string };

/**
 * Pré-checks AVANT de lancer un worker de génération (examen ou exercice) :
 * mieux vaut bloquer tout de suite avec un message clair que brûler 4-20 min
 * pour un rendu inutilisable. `command` = commande copiable affichée par l'UI.
 * Limites d'usage (lib/billing/limits) et PLACE DISQUE vérifiées ICI (point
 * commun des routes de génération par jobs) — no-op sans env.
 */
export async function preflightGeneration(kind: string, target?: string | null): Promise<PreflightIssue | null> {
  // TOUTES les limites (débit, quota du jour, jobs en cours, solde, budget, calcul
  // du jour, mois, stockage), au coût EXACT du job demandé (taille comprise) :
  // le verdict de lib/billing/limits, celui que la réservation rendra.
  const { costForJob } = await import("@/lib/jobs");
  const limitIssue = await launchGate(jobSpec(kind, costForJob(kind as never, target)));
  if (limitIssue) return limitIssue;
  // PLACE DISQUE : une génération produit des artefacts (PDF d'examen, figures)
  // qui comptent dans le quota du compte comme les fichiers importés — et un
  // volume presque plein casse aussi bien la compilation que l'ingestion. Vérifié
  // avant le corpus : sans place, le conseil « lance l'ingestion » serait faux.
  const storageIssue = await checkStorage(currentUser(), 0, {
    minFreeBytes: GENERATION_MIN_FREE_BYTES,
    what: "produce_exam",
  });
  if (storageIssue) return storageIssue;
  const engineIssue = llmUnavailableReason();
  if (engineIssue) return refusal(503, "llm_engine_unavailable");
  let items = 0;
  try {
    items = (await q.get<{ n: number }>(`SELECT count(*) n FROM items`))!.n;
  } catch {}
  if (!items)
    return {
      ...refusal(409, "corpus_not_ingested"),
      command: "npm run ingest",
    };
  if (!texAvailable())
    return {
      ...refusal(412, "latex_engine_missing"),
      command: "brew install tectonic",
    };
  return null;
}
