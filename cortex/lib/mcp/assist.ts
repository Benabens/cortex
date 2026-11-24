import { AssistRefused, assistCall } from "@/lib/billing/reserve";
import { BAD_OUTPUT_CODES, OWN_LLM_CODES, llmErrorCode, llmUserError } from "@/lib/llm";
import { errorText } from "@/lib/i18n/user-error";
import { log } from "@/lib/metrics";
import { ToolError, codeForStatus } from "./tool";

/**
 * Appel d'ASSISTANCE au nom du compte courant, exactement comme les routes de
 * l'app (drill, check-solution) : réservation atomique du prix d'une aide (rafale,
 * quota du jour, solde) AVANT l'appel, remboursée si nos propres gardes
 * l'arrêtent avant envoi ou si la réponse reste illisible (lib/billing/reserve
 * assistCall). Les refus et pannes deviennent des ToolError au message lisible
 * (lib/llm/errors) ; le texte brut d'un fournisseur n'est jamais renvoyé.
 */
export async function runAssist<T>(kind: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await assistCall(kind, fn);
  } catch (e) {
    if (e instanceof AssistRefused) throw new ToolError(codeForStatus(e.status), errorText("en", e), undefined, e.code);
    const code = llmErrorCode(e);
    const userError = llmUserError(e);
    if (code && OWN_LLM_CODES.has(code)) throw new ToolError("unavailable", errorText("en", userError), undefined, userError.code);
    // Le code journalisé nomme la cause (BAD_OUTPUT, OVERLOADED, TIMEOUT…) ; à défaut,
    // la classe de l'erreur — un « unknown » ne permet aucun diagnostic.
    const reason = code ?? (e instanceof Error ? e.name : "unknown");
    log("warn", "mcp.assist_failed", { kind, code: reason });
    const billing = code && BAD_OUTPUT_CODES.has(code)
      ? "Nothing was charged."
      : "The model call was sent, so the charge remains.";
    throw new ToolError("unavailable", `${errorText("en", userError)} ${billing}`, reason, userError.code);
  }
}
