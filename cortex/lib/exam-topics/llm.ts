import { runWithUser } from "@/db/context";
import { runWithLlmAuthorization } from "@/lib/llm/authorization";
import { FREE_TOOL_USER } from "./config";

/**
 * Tout appel au modèle d'une analyse passe par ici : pseudo-compte de l'outil (jamais le
 * propriétaire par défaut de currentUser()) et preuve `free_tool` que lib/llm vérifie
 * (analyse admise, en cours), plafonds de l'analyse et du jour compris (lib/billing/usage).
 */
export function runExamTopicCall<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  return runWithUser(FREE_TOOL_USER, () => runWithLlmAuthorization({ kind: "free_tool", ref: `exam-topics:${runId}` }, fn));
}
