import { authAll, authGet } from "@/db/auth-store";
import type { Locale } from "@/lib/i18n/locale";
import { invoicePdf, invoiceSeller } from "./invoice-pdf";
import { loadOrder, type ReceiptStripe } from "./receipts";

/**
 * PAIEMENTS ET FACTURES DE MON COMPTE. La liste vient de `stripe_payments` (revenu
 * encaissé, posé par le webhook) : un pack payé, une facture d'abonnement payée.
 * Le PDF est construit à la demande depuis la facture Stripe du paiement (./orders),
 * jamais stocké. Seul le propriétaire du paiement l'obtient : un id d'un autre compte
 * répond comme un id inconnu (introuvable, sans dire qu'il existe).
 */

export type AccountPayment = { id: string; kind: "pack" | "subscription"; amountCents: number; currency: string; paidAt: string };

export async function accountInvoices(userId: string): Promise<AccountPayment[]> {
  const rows = await authAll<{ source_id: string; kind: string; amount_cents: number | string; currency: string; paid_at: string }>(
    `SELECT source_id, kind, amount_cents, currency, paid_at FROM stripe_payments WHERE user_id = ? AND amount_cents > 0 ORDER BY paid_at DESC LIMIT 100`,
    userId,
  );
  return rows.map((r) => ({ id: r.source_id, kind: r.kind === "subscription" ? "subscription" : "pack", amountCents: Number(r.amount_cents), currency: r.currency, paidAt: r.paid_at }));
}

export type InvoicePdfResult =
  | { state: "ok"; pdf: Buffer; filename: string }
  | { state: "not_found" }
  /** Vendeur non configuré (INVOICE_SELLER_*), ou facture Stripe illisible ou pas encore finalisée. */
  | { state: "unavailable"; reason: string };

export async function accountInvoicePdf(p: { userId: string; id: string; locale: Locale; stripe: ReceiptStripe; env?: Partial<NodeJS.ProcessEnv> }): Promise<InvoicePdfResult> {
  const row = await authGet<{ kind: string }>(`SELECT kind FROM stripe_payments WHERE source_id = ? AND user_id = ?`, p.id, p.userId);
  if (!row) return { state: "not_found" };
  const seller = invoiceSeller(p.env ?? process.env);
  if (!seller.ok) return { state: "unavailable", reason: `vendeur non configuré : ${seller.missing}` };
  const known = await authGet<{ invoice_id: string | null; plan: string | null }>(`SELECT invoice_id, plan FROM stripe_receipts WHERE source_id = ?`, p.id);
  let loaded: Awaited<ReturnType<typeof loadOrder>>;
  try {
    loaded = await loadOrder(p.stripe, { sourceId: p.id, kind: row.kind === "subscription" ? "subscription" : "pack", invoiceId: known?.invoice_id ?? null, plan: known?.plan ?? null });
  } catch (e) {
    return { state: "unavailable", reason: `Stripe : ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!loaded) return { state: "unavailable", reason: "facture Stripe absente ou pas encore finalisée" };
  const number = (loaded.order.number ?? p.id).replace(/[^A-Za-z0-9-]/g, "");
  const filename = `${p.locale === "en" ? "invoice" : "facture"}-cortex-${number}.pdf`;
  return { state: "ok", pdf: invoicePdf(loaded.order, seller.seller, p.locale), filename };
}
