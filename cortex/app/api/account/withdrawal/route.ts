import { apiError, requestLocale } from "@/lib/i18n/api-error";
import { NextRequest, NextResponse } from "next/server";
import { authGet } from "@/db/auth-store";
import { currentUser } from "@/db/context";
import { createWithdrawalRequest, eligibleWithdrawals, type PurchaseType } from "@/lib/consumer-law";
import { sendEmail } from "@/lib/email";
import { log } from "@/lib/metrics";
import { useUser } from "@/lib/req";
import { stripeClient } from "@/lib/billing/stripe-client";
import { readJson, withBodyLimit } from "@/lib/upload-limit";
import { accountLocale } from "@/lib/i18n/account-locale";
import { translator } from "@/lib/i18n/translate";
import type { Locale } from "@/lib/i18n/locale";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  useUser(req);
  return NextResponse.json({ purchases: await eligibleWithdrawals(currentUser()) });
}

export async function sendReceipt(to: string | null, requestedAt: string, purchaseId: string, locale: Locale): Promise<void> {
  if (!process.env.RESEND_API_KEY) { log("info", "withdrawal.email_skipped", { purchaseId, reason: "RESEND_API_KEY absente" }); return; }
  const t = translator(locale);
  const text = t("withdrawalEmail.text", { requestedAt, purchaseId }) + (locale === "en" ? `\n\n${t("withdrawalEmail.binding")}` : "");
  const publisher = process.env.PUBLISHER_EMAIL?.trim() || null;
  const recipients = [...new Set([to, publisher].filter((recipient): recipient is string => !!recipient))];
  for (const recipient of recipients) {
    const sent = await sendEmail({ to: recipient, subject: t("withdrawalEmail.subject"), text });
    if (!sent.ok) log("warn", "withdrawal.email_failed", { recipient, reason: sent.reason });
  }
}

export const POST = withBodyLimit(async function POST(req: NextRequest) {
  useUser(req);
  const userId = currentUser();
  const body = await readJson(req, {}) as { type?: unknown; purchaseId?: unknown; confirm?: unknown };
  if (body.confirm !== true || (body.type !== "pack" && body.type !== "subscription") || !String(body.purchaseId ?? "")) {
    return apiError(req, "withdrawal_purchase_and_confirmation_required", 400);
  }
  try {
    const type = body.type as PurchaseType;
    const purchaseId = String(body.purchaseId);
    const eligible = await eligibleWithdrawals(userId);
    if (!eligible.some((purchase) => purchase.type === type && purchase.id === purchaseId)) {
      throw new Error("purchase no longer eligible"); // message interne : la réponse est withdrawal_request_failed
    }
    const result = await createWithdrawalRequest(userId, type, purchaseId);
    let cancellationWarning: string | null = null;
    if (type === "subscription") {
      const sub = await authGet<{ subscription_id: string | null }>(`SELECT subscription_id FROM subscriptions WHERE user_id = ? AND status IN ('active','trialing')`, userId);
      if (sub?.subscription_id) {
        const key = process.env.STRIPE_SECRET_KEY;
        if (!key) cancellationWarning = translator(requestLocale(req))("account.withdrawal.cancelUnconfigured");
        else try { await stripeClient(key).subscriptions.update(sub.subscription_id, { cancel_at_period_end: true }); }
        catch (error) {
          cancellationWarning = translator(requestLocale(req))("account.withdrawal.cancelFailed");
          log("error", "withdrawal.subscription_cancel_failed", { subscription: sub.subscription_id, message: error instanceof Error ? error.message.slice(0, 160) : String(error) });
        }
      }
    }
    const user = await authGet<{ email: string | null }>(`SELECT email FROM users WHERE id = ?`, userId);
    const locale = await accountLocale(userId).catch(() => null) ?? requestLocale(req);
    await sendReceipt(user?.email ?? null, result.requestedAt, purchaseId, locale).catch((error) =>
      log("warn", "withdrawal.email_failed", { message: error instanceof Error ? error.message.slice(0, 160) : String(error) }),
    );
    return NextResponse.json({ ...result, warning: cancellationWarning }, { status: 201 });
  } catch {
    return apiError(req, "withdrawal_request_failed", 400);
  }
});
