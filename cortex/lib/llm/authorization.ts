import { AsyncLocalStorage } from "node:async_hooks";
import { authGet } from "@/db/auth-store";
import { currentUser } from "@/db/context";
import { billingEnabled } from "@/lib/billing/credits";
import { isOwner } from "@/lib/billing/owner";
import { currentJob } from "@/lib/billing/usage-context";
import { GENERATION_DEBIT_SQL } from "@/lib/billing/usage";
import { FREE_TOOL_USER } from "@/lib/exam-topics/config";
import { LlmError } from "./types";

export type LlmAuthorization = {
  /** `free_tool` : analyse de l'outil gratuit sans compte, `ref` = `exam-topics:<jeton>`. */
  kind: "assist" | "job" | "test" | "free_tool";
  ref: string;
};

const authorization = new AsyncLocalStorage<LlmAuthorization>();

export class LlmPaymentRequiredError extends LlmError {
  readonly status = 402;
  constructor(message = "Il te faut des crédits pour cette action. Achète des crédits dans Mon compte → Abonnement & crédits.") {
    super(message, "PAYMENT_REQUIRED");
    this.name = "LlmPaymentRequiredError";
  }
}

export function runWithLlmAuthorization<T>(value: LlmAuthorization, fn: () => T): T {
  return authorization.run(value, fn);
}

/** Une référence débitée existe encore. En dev sans facturation, sa présence suffit. */
export async function reservationExists(ref: string | null | undefined, userId = currentUser()): Promise<boolean> {
  if (!ref) return false;
  if (!billingEnabled()) return true;
  const row = await authGet<{ user_id: string }>(
    `SELECT user_id FROM credit_transactions WHERE ref = ? AND ${GENERATION_DEBIT_SQL}`,
    ref,
  );
  return row?.user_id === userId;
}

/**
 * Réservation que l'appel en cours consomme : celle d'une aide (assistCall) ou le
 * débit du job courant. null : propriétaire hors réservation, ou appel sans débit.
 */
export function currentLlmProof(): LlmAuthorization | null {
  const job = currentJob();
  return authorization.getStore() ?? (job?.creditRef ? { kind: "job", ref: job.creditRef } : null);
}

/** Défense ultime, exécutée avant cache, compteur de dépense et provider. */
export async function assertLlmAuthorized(): Promise<void> {
  // Outil gratuit : aucun crédit, la preuve est une analyse admise et en cours (lib/exam-topics/runs),
  // sous son pseudo-compte. Vérifiée même sous la dérogation de test, et jamais rattrapée par
  // l'exemption propriétaire.
  const proof = currentLlmProof();
  if (proof?.kind === "free_tool" || currentUser() === FREE_TOOL_USER) {
    const id = proof?.kind === "free_tool" && proof.ref.startsWith("exam-topics:") ? proof.ref.slice("exam-topics:".length) : null;
    const { runIsLive } = await import("@/lib/exam-topics/runs");
    if (currentUser() !== FREE_TOOL_USER || !id || !(await runIsLive(id))) throw new LlmPaymentRequiredError();
    return;
  }
  // Les tests de moteur appellent volontairement le point d'entrée directement
  // avec des providers locaux factices. Cette dérogation n'est reconnue que par
  // le runner `npm test` et jamais dans un processus Next de production.
  if (process.env.CORTEX_LLM_TEST_AUTH === "1" && process.argv.some((arg) => /[/\\]tests[/\\].+\.test\.[cm]?[jt]s$/.test(arg))) return;
  const user = currentUser();
  if (await isOwner(user)) return;

  if (!proof || !(await reservationExists(proof.ref, user))) throw new LlmPaymentRequiredError();
}
