import { randomUUID } from "node:crypto";
import { authAll, authGet, authRun } from "@/db/auth-store";
import { nowStr } from "@/db/q";
import type { PlanKey } from "@/lib/billing/stripe-events";

export type PurchaseType = "pack" | "subscription";

export function consentForPlan(plan: PlanKey): { type: PurchaseType; text: string } {
  return plan === "credits_10"
    ? { type: "pack", text: "Je demande l’accès immédiat à mes crédits et reconnais perdre mon droit de rétractation dès leur première utilisation." }
    : { type: "subscription", text: "Je demande que mon abonnement commence immédiatement. Si je me rétracte sous 14 jours, le montant proportionnel au service déjà fourni restera dû." };
}

export async function recordPurchaseConsent(o: { userId: string; plan: PlanKey; termsVersion: string; stripeSessionId: string }): Promise<void> {
  await authRun(
    `INSERT INTO purchase_consents (stripe_session_id, user_id, purchase_type, terms_version, consented_at) VALUES (?,?,?,?,?)
     ON CONFLICT (stripe_session_id) DO NOTHING`,
    o.stripeSessionId, o.userId, consentForPlan(o.plan).type, o.termsVersion, nowStr(),
  );
}

export type EligiblePurchase = { id: string; type: PurchaseType; purchasedAt: string; label: string };

export async function eligibleWithdrawals(userId: string, now = new Date()): Promise<EligiblePurchase[]> {
  const since = new Date(now.getTime() - 14 * 86400_000).toISOString().slice(0, 19).replace("T", " ");
  const packs = await authAll<{ id: string; purchased_at: string }>(
    `SELECT session_id id, created_at purchased_at FROM stripe_purchases WHERE user_id = ? AND created_at >= ? ORDER BY created_at DESC`, userId, since,
  );
  const subscriptions = await authAll<{ id: string; purchased_at: string }>(
    `SELECT s.subscription_id id, min(pc.consented_at) purchased_at
     FROM purchase_consents pc
     JOIN subscriptions s ON s.user_id = pc.user_id
     WHERE pc.user_id = ? AND pc.purchase_type = 'subscription' AND pc.consented_at >= ?
       AND s.status IN ('active','trialing') AND coalesce(s.period_start, s.updated_at) >= ?
       AND s.subscription_id IS NOT NULL
     GROUP BY s.subscription_id
     ORDER BY min(pc.consented_at) DESC`, userId, since, since,
  );
  return [
    ...packs.map((p) => ({ id: p.id, type: "pack" as const, purchasedAt: p.purchased_at, label: "Pack de 10 crédits" })),
    ...subscriptions.map((p) => ({ id: p.id, type: "subscription" as const, purchasedAt: p.purchased_at, label: "Abonnement Pro" })),
  ];
}

export async function createWithdrawalRequest(userId: string, type: PurchaseType, purchaseId: string): Promise<{ id: string; status: "reçue"; requestedAt: string }> {
  const eligible = await eligibleWithdrawals(userId);
  if (!eligible.some((p) => p.id === purchaseId && p.type === type)) throw new Error("Cet achat n’est plus éligible à la rétractation en ligne.");
  const existing = await authGet<{ id: string; requested_at: string }>(
    `SELECT id, requested_at FROM withdrawal_requests WHERE user_id = ? AND purchase_type = ? AND purchase_id = ?`, userId, type, purchaseId,
  );
  if (existing) return { id: existing.id, status: "reçue", requestedAt: existing.requested_at };
  const user = await authGet<{ email: string | null }>(`SELECT email FROM users WHERE id = ?`, userId);
  const id = randomUUID();
  const requestedAt = nowStr();
  await authRun(`INSERT INTO withdrawal_requests (id, user_id, email, purchase_type, purchase_id, requested_at, status) VALUES (?,?,?,?,?,?,?)`,
    id, userId, user?.email ?? null, type, purchaseId, requestedAt, "reçue");
  return { id, status: "reçue", requestedAt };
}
