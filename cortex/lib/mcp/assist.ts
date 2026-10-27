import { AssistRefused, assistCall } from "@/lib/billing/reserve";
import { log } from "@/lib/metrics";
import { ToolError, codeForStatus } from "./tool";

/** Codes d'erreur LLM émis par NOS gardes (messages rédigés par Cortex, sûrs à montrer). */
const OWN_LLM_CODES = new Set(["UNAVAILABLE", "SPEND_CAP", "QUOTA", "CREDITS"]);

/**
 * Appel d'ASSISTANCE au nom du compte courant, exactement comme les routes de
 * l'app (drill, check-solution) : réservation atomique de 0,1 crédit (rafale,
 * quota du jour, solde) AVANT l'appel, remboursée si nos propres gardes
 * l'arrêtent avant envoi (lib/billing/reserve assistCall). Les refus et pannes
 * deviennent des ToolError ; le texte brut d'un fournisseur n'est jamais renvoyé.
 */
export async function runAssist<T>(kind: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await assistCall(kind, fn);
  } catch (e) {
    if (e instanceof AssistRefused) throw new ToolError(codeForStatus(e.status), e.message);
    const code = (e as { code?: string } | null)?.code;
    if (code && OWN_LLM_CODES.has(code)) throw new ToolError("unavailable", (e as Error).message);
    log("warn", "mcp.assist_failed", { kind, code: code ?? "unknown" });
    throw new ToolError("unavailable", "Le moteur d'IA n'a pas pu répondre (erreur du fournisseur). L'appel est parti, il reste débité ; réessaie dans un instant.");
  }
}
