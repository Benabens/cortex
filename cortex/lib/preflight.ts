import { sqlite } from "@/db/client";
import { llmUnavailableReason } from "@/lib/llm";
import { texAvailable } from "@/lib/exam-latex";

export type PreflightIssue = { error: string; command?: string; status: number };

/**
 * Pré-checks AVANT de lancer un worker de génération (examen ou exercice) :
 * mieux vaut bloquer tout de suite avec un message clair que brûler 4-20 min
 * pour un rendu inutilisable. `command` = commande copiable affichée par l'UI.
 */
export function preflightGeneration(): PreflightIssue | null {
  const engineIssue = llmUnavailableReason();
  if (engineIssue) return { status: 503, error: engineIssue };
  let items = 0;
  try {
    items = (sqlite.prepare(`SELECT count(*) n FROM items`).get() as { n: number }).n;
  } catch {}
  if (!items)
    return {
      status: 409,
      error: "Corpus non ingéré — la génération n'aurait aucune matière. Lance l'ingestion puis réessaie.",
      command: "npm run ingest",
    };
  if (!texAvailable())
    return {
      status: 412,
      error: "Aucun moteur LaTeX détecté : impossible de produire le PDF d'examen. Installe tectonic, puis redémarre l'app.",
      command: "brew install tectonic",
    };
  return null;
}
