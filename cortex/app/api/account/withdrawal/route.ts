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

async function sendReceipt(to: string, requestedAt: string, purchaseId: string): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) { log("info", "withdrawal.email_skipped", { purchaseId, reason: "RESEND_API_KEY absente" }); return; }
  const text = `Nous accusons réception de votre demande de rétractation du ${requestedAt} pour l’achat ${purchaseId}. Elle sera traitée manuellement dans Stripe.`;
  const recipients = [...new Set([to, "abensur.benjamin@gmail.com"])];
  for (const recipient of recipients) {
    const res = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ from: process.env.AUTH_EMAIL_FROM ?? "Cortex <onboarding@resend.dev>", to: recipient, subject: "Demande de rétractation reçue", text }) });
    if (!res.ok) log("warn", "withdrawal.email_failed", { recipient, status: res.status });
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
    if (type === "subscription") {
      const sub = await authGet<{ subscription_id: string | null }>(`SELECT subscription_id FROM subscriptions WHERE user_id = ? AND status IN ('active','trialing')`, userId);
      if (sub?.subscription_id) {
        const key = process.env.STRIPE_SECRET_KEY;
        if (!key) throw new Error("Stripe n’est pas configuré pour programmer la résiliation.");
        await stripeClient(key).subscriptions.update(sub.subscription_id, { cancel_at_period_end: true });
      }
    }
    const result = await createWithdrawalRequest(userId, type, String(body.purchaseId));
    const user = await authGet<{ email: string | null }>(`SELECT email FROM users WHERE id = ?`, userId);
    if (user?.email) await sendReceipt(user.email, result.requestedAt, String(body.purchaseId));
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Demande impossible." }, { status: 400 });
  }
});
