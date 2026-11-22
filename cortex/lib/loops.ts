/**
 * INTÉGRATION LOOPS (emails marketing d'onboarding) : contact + événements de
 * cycle de vie. Jamais d'erreur visible : `LOOPS_API_KEY` absente, panne
 * réseau ou refus de Loops → un log et on continue (même esprit que
 * lib/email.ts). Ne doit jamais faire échouer l'inscription, la création
 * d'un cours ou un paiement.
 */
import { log } from "@/lib/metrics";

const LOOPS_API_BASE = "https://app.loops.so/api/v1";

function apiKey(): string | undefined {
  return process.env.LOOPS_API_KEY || undefined;
}

export function loopsConfigured(): boolean {
  return !!apiKey();
}

export type LoopsContact = { email: string; firstName?: string; language?: string; userId?: string };

export async function upsertLoopsContact(contact: LoopsContact): Promise<void> {
  const key = apiKey();
  if (!key) {
    log("info", "loops.contact.skipped", { reason: "LOOPS_API_KEY absente" });
    return;
  }
  try {
    const res = await fetch(`${LOOPS_API_BASE}/contacts/update`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        email: contact.email,
        firstName: contact.firstName,
        language: contact.language,
        userId: contact.userId,
        source: "cortex-signup",
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) log("warn", "loops.contact.failed", { status: res.status });
  } catch (e) {
    log("warn", "loops.contact.error", { error: e instanceof Error ? e.message.slice(0, 160) : String(e) });
  }
}

export type LoopsEventName = "signup" | "course_created" | "sources_added" | "mcp_connected" | "first_mock_exam" | "purchase";

/** E-mail si on l'a sous la main, sinon le `userId` posé sur le contact à l'inscription (évite une requête DB dans les routes chaudes). */
export type LoopsIdentity = { email?: string; userId?: string };

export async function trackLoopsEvent(identity: LoopsIdentity, eventName: LoopsEventName, eventProperties?: Record<string, unknown>): Promise<void> {
  const key = apiKey();
  if (!key || (!identity.email && !identity.userId)) {
    log("info", "loops.event.skipped", { eventName, reason: key ? "ni e-mail ni userId" : "LOOPS_API_KEY absente" });
    return;
  }
  try {
    const res = await fetch(`${LOOPS_API_BASE}/events/send`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ email: identity.email, userId: identity.userId, eventName, eventProperties: eventProperties ?? {} }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) log("warn", "loops.event.failed", { eventName, status: res.status });
  } catch (e) {
    log("warn", "loops.event.error", { eventName, error: e instanceof Error ? e.message.slice(0, 160) : String(e) });
  }
}
