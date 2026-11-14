import type Stripe from "stripe";
import type { BackfillStripe } from "@/lib/billing/revenue-backfill";
import { disputeFeeCents, idOf, invoiceTaxCents, unixToStr } from "@/lib/billing/stripe-events";

/**
 * Frais Stripe RÉELS d'un paiement, dans la devise du paiement (unités mineures),
 * ou null s'ils ne sont pas encore connus (balance transaction pas encore créée).
 *
 * Les frais sont portés par la balance transaction de la charge, dans la devise
 * de RÈGLEMENT du compte, qui peut différer de celle du paiement : on les ramène
 * alors au prorata (frais / montant réglé × montant payé), sans taux de change.
 */
export function feeInChargeCurrency(charge: { amount: number; currency: string }, bt: { amount: number; fee: number; currency: string }): number {
  if (bt.currency === charge.currency) return bt.fee;
  if (!(bt.amount > 0)) return 0;
  return Math.ceil((bt.fee / bt.amount) * charge.amount);
}

export async function feeOfPaymentIntent(stripe: Stripe, paymentIntent: string): Promise<number | null> {
  const pi = await stripe.paymentIntents.retrieve(paymentIntent, { expand: ["latest_charge.balance_transaction"] });
  const charge = typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  const bt = charge && typeof charge.balance_transaction === "object" ? charge.balance_transaction : null;
  if (!charge || !bt) return null;
  return feeInChargeCurrency(charge, bt);
}

/** Lecture Stripe de la reprise de l'historique (lib/billing/revenue-backfill) : rien n'y est écrit. */
export function stripeBackfillApi(stripe: Stripe): BackfillStripe {
  return {
    async checkoutSession(id) {
      const s = await stripe.checkout.sessions.retrieve(id);
      if (s.payment_status !== "paid") return null;
      return {
        amountCents: s.amount_total ?? 0, currency: s.currency ?? "eur", taxCents: s.total_details?.amount_tax ?? 0,
        paymentIntent: idOf(s.payment_intent), paidAt: unixToStr(s.created), livemode: s.livemode,
      };
    },
    async invoice(id) {
      const inv = await stripe.invoices.retrieve(id);
      if (inv.status !== "paid") return null;
      // Format récent : plus de invoice.payment_intent, le paiement est dans InvoicePayments.
      let pi = idOf((inv as { payment_intent?: unknown }).payment_intent);
      if (!pi) pi = idOf((await stripe.invoicePayments.list({ invoice: id, limit: 1 })).data[0]?.payment?.payment_intent);
      return {
        amountCents: inv.amount_paid, currency: inv.currency, taxCents: invoiceTaxCents(inv), paymentIntent: pi,
        paidAt: unixToStr(inv.status_transitions?.paid_at), livemode: inv.livemode,
      };
    },
    async payment(paymentIntent) {
      const pi = await stripe.paymentIntents.retrieve(paymentIntent, { expand: ["latest_charge.balance_transaction"] });
      const charge = typeof pi.latest_charge === "object" ? pi.latest_charge : null;
      if (!charge) return null;
      const bt = typeof charge.balance_transaction === "object" ? charge.balance_transaction : null;
      const disputes = await stripe.disputes.list({ payment_intent: paymentIntent, limit: 100 });
      return {
        feeCents: bt ? feeInChargeCurrency(charge, bt) : null,
        refundedCents: charge.amount_refunded ?? 0,
        disputes: disputes.data.map((d) => ({ amountCents: d.amount, feeCents: disputeFeeCents(d) })),
      };
    },
  };
}
