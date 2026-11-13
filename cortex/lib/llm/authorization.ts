import { AsyncLocalStorage } from "node:async_hooks";
import { authGet } from "@/db/auth-store";
import { currentUser } from "@/db/context";
import { billingEnabled } from "@/lib/billing/credits";
import { isOwner } from "@/lib/billing/owner";
import { currentJob } from "@/lib/billing/usage-context";
import { LlmError } from "./types";

export type LlmAuthorization = {
  kind: "assist" | "job" | "test";
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
    `SELECT user_id FROM credit_transactions WHERE ref = ? AND reason LIKE 'génération %'`,
    ref,
  );
  return row?.user_id === userId;
}

/** Défense ultime, exécutée avant cache, compteur de dépense et provider. */
export async function assertLlmAuthorized(): Promise<void> {
  // Les tests de moteur appellent volontairement le point d'entrée directement
  // avec des providers locaux factices. Cette dérogation n'est reconnue que par
  // le runner `npm test` et jamais dans un processus Next de production.
  if (process.env.CORTEX_LLM_TEST_AUTH === "1" && process.argv.some((arg) => /[/\\]tests[/\\].+\.test\.[cm]?[jt]s$/.test(arg))) return;
  const user = currentUser();
  if (await isOwner(user)) return;

  const explicit = authorization.getStore();
  const job = currentJob();
  const proof = explicit ?? (job?.creditRef ? { kind: "job" as const, ref: job.creditRef } : null);
  if (!proof || !(await reservationExists(proof.ref, user))) throw new LlmPaymentRequiredError();
}
