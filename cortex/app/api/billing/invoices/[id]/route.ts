import { NextRequest } from "next/server";
import { currentUser } from "@/db/context";
import { billingEnabled } from "@/lib/billing/credits";
import { accountInvoicePdf } from "@/lib/billing/invoices";
import { stripeClient } from "@/lib/billing/stripe-client";
import { contactEmail } from "@/lib/contact";
import { accountLocale } from "@/lib/i18n/account-locale";
import { apiError, requestLocale } from "@/lib/i18n/api-error";
import { log } from "@/lib/metrics";
import { useUser } from "@/lib/req";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/billing/invoices/<cs_… | in_…> : facture PDF Cortex d'un paiement du compte
 * connecté (lien du reçu et de Mon compte). Le paiement d'un autre compte répond 404,
 * comme un id inconnu. Langue : celle du compte, sinon celle de la requête.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  useUser(req);
  if (!billingEnabled()) return apiError(req, "billing_disabled", 501);
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return apiError(req, "stripe_secret_key_missing", 501);
  const { id } = await ctx.params;
  if (!/^(cs|in)_[A-Za-z0-9_]{1,250}$/.test(id)) return apiError(req, "not_found", 404);
  const userId = currentUser();
  const locale = (await accountLocale(userId).catch(() => null)) ?? requestLocale(req);
  const res = await accountInvoicePdf({ userId, id, locale, stripe: stripeClient(key) });
  if (res.state === "not_found") return apiError(req, "not_found", 404);
  if (res.state === "unavailable") {
    log("error", "invoice.unavailable", { user: userId, source: id, reason: res.reason });
    return apiError(req, { code: "invoice_unavailable", params: { email: contactEmail() } }, 503);
  }
  return new Response(new Uint8Array(res.pdf), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${res.filename}"`,
      "cache-control": "private, no-store",
    },
  });
}
