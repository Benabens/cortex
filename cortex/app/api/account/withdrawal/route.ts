import { NextRequest, NextResponse } from "next/server";
import { authGet } from "@/db/auth-store";
import { currentUser } from "@/db/context";
import { createWithdrawalRequest, eligibleWithdrawals, type PurchaseType } from "@/lib/consumer-law";
import { log } from "@/lib/metrics";
import { useUser } from "@/lib/req";
import { stripeClient } from "@/lib/billing/stripe-client";
import { readJson, withBodyLimit } from "@/lib/upload-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  useUser(req);
  return NextResponse.json({ purchases: await eligibleWithdrawals(currentUser()) });
}

async function sendReceipt(to: string | null, requestedAt: string, purchaseId: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) { log("info", "withdrawal.email_skipped", { purchaseId, reason: "RESEND_API_KEY absente" }); return; }
  const text = `Nous accusons réception de votre demande de rétractation du ${requestedAt} pour l’achat ${purchaseId}. Elle sera traitée manuellement dans Stripe.`;
  const publisher = process.env.PUBLISHER_EMAIL?.trim() || null;
  const recipients = [...new Set([to, publisher].filter((recipient): recipient is string => !!recipient))];
  for (const recipient of recipients) {
    try {
      const res = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ from: process.env.AUTH_EMAIL_FROM ?? "Cortex <onboarding@resend.dev>", to: recipient, subject: "Demande de rétractation reçue", text }) });
      if (!res.ok) log("warn", "withdrawal.email_failed", { recipient, status: res.status });
    } catch (error) {
      log("warn", "withdrawal.email_failed", { recipient, message: error instanceof Error ? error.message.slice(0, 160) : String(error) });
    }
  }
}

export const POST = withBodyLimit(async function POST(req: NextRequest) {
  useUser(req);
  const userId = currentUser();
  const body = await readJson(req, {}) as { type?: unknown; purchaseId?: unknown; confirm?: unknown };
  if (body.confirm !== true || (body.type !== "pack" && body.type !== "subscription") || !String(body.purchaseId ?? "")) {
    return NextResponse.json({ error: "Choisis un achat puis confirme explicitement ta demande." }, { status: 400 });
  }
  try {
    const type = body.type as PurchaseType;
    const purchaseId = String(body.purchaseId);
    const eligible = await eligibleWithdrawals(userId);
    if (!eligible.some((purchase) => purchase.type === type && purchase.id === purchaseId)) {
      throw new Error("Cet achat n’est plus éligible à la rétractation en ligne.");
    }
    const result = await createWithdrawalRequest(userId, type, purchaseId);
    let cancellationWarning: string | null = null;
    if (type === "subscription") {
      const sub = await authGet<{ subscription_id: string | null }>(`SELECT subscription_id FROM subscriptions WHERE user_id = ? AND status IN ('active','trialing')`, userId);
      if (sub?.subscription_id) {
        const key = process.env.STRIPE_SECRET_KEY;
        if (!key) cancellationWarning = "Demande reçue, mais Stripe n’est pas configuré pour programmer la résiliation. L’éditeur la traitera manuellement.";
        else try { await stripeClient(key).subscriptions.update(sub.subscription_id, { cancel_at_period_end: true }); }
        catch (error) {
          cancellationWarning = "Demande reçue, mais la résiliation automatique a échoué. L’éditeur la traitera manuellement.";
          log("error", "withdrawal.subscription_cancel_failed", { subscription: sub.subscription_id, message: error instanceof Error ? error.message.slice(0, 160) : String(error) });
        }
      }
    }
    const user = await authGet<{ email: string | null }>(`SELECT email FROM users WHERE id = ?`, userId);
    await sendReceipt(user?.email ?? null, result.requestedAt, purchaseId).catch((error) =>
      log("warn", "withdrawal.email_failed", { message: error instanceof Error ? error.message.slice(0, 160) : String(error) }),
    );
    return NextResponse.json({ ...result, warning: cancellationWarning }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Demande impossible." }, { status: 400 });
  }
});
