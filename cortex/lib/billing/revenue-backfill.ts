import { recordDispute, recordPayment, recordRefund, setRealFee, usdPerUnit, type PaymentKind } from "@/lib/billing/revenue";

/**
 * REPRISE DE L'HISTORIQUE STRIPE dans stripe_payments / stripe_payment_losses
 * (npm run billing:backfill). Avant le 14/11/2026, le webhook créditait sans
 * retenir l'argent encaissé : un compte qui avait déjà payé aurait un budget IA
 * nul. Sources : stripe_purchases (packs) et stripe_invoices (abonnement), relus
 * chez Stripe (montant, taxe, frais réels, remboursé cumulé, litiges).
 *
 * Aussi : les paiements dont les frais ont été ESTIMÉS (Stripe injoignable au
 * webhook) prennent leurs frais réels. Tout est idempotent (recordPayment par
 * source, remboursé et litige au maximum vu) : la reprise se rejoue sans risque.
 *
 * Lecture par `read` (lecture seule en dry-run : lib/billing/report-source) ;
 * écriture seulement si `write`, par le store global. Une source introuvable ou
 * en erreur chez Stripe est écartée avec sa raison ; les autres passent.
 */

export type StripePaid = {
  amountCents: number; currency: string; taxCents: number; paymentIntent: string | null; paidAt: string | null; livemode: boolean;
};
export type StripePaymentFacts = {
  feeCents: number | null; refundedCents: number; disputes: Array<{ amountCents: number; feeCents: number | null }>;
};
/** Accès Stripe injecté (testable sans réseau). null = introuvable ou non payé. */
export type BackfillStripe = {
  checkoutSession(id: string): Promise<StripePaid | null>;
  invoice(id: string): Promise<StripePaid | null>;
  payment(paymentIntent: string): Promise<StripePaymentFacts | null>;
};
type Read = (sql: string, ...params: Array<string | number | null>) => Promise<Record<string, unknown>[]>;

export type BackfillReport = {
  /** Paiements absents de stripe_payments, retrouvés chez Stripe. */
  toRecord: number;
  recordedGrossUsd: number;
  /** Paiements à frais estimés dont Stripe donne les frais réels. */
  feesToFix: number;
  refunds: number;
  disputes: number;
  skipped: Array<{ sourceId: string; why: string }>;
};

const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v));

/** Table absente (base pas encore migrée, dry-run avant déploiement) → aucune ligne. */
async function rowsOrNone(read: Read, sql: string): Promise<Record<string, unknown>[]> {
  try { return await read(sql); } catch { return []; }
}

export async function backfillRevenue(o: { read: Read; api: BackfillStripe; write: boolean }): Promise<BackfillReport> {
  const report: BackfillReport = { toRecord: 0, recordedGrossUsd: 0, feesToFix: 0, refunds: 0, disputes: 0, skipped: [] };
  const known = new Map<string, boolean>(); // source_id → frais estimés
  for (const r of await rowsOrNone(o.read, `SELECT source_id, fee_estimated FROM stripe_payments`)) {
    known.set(String(r.source_id), Number(r.fee_estimated) === 1);
  }
  const sources: Array<{ kind: PaymentKind; sourceId: string; paymentIntent: string | null; userId: string }> = [
    ...(await o.read(`SELECT session_id AS id, payment_intent, user_id FROM stripe_purchases ORDER BY created_at`)).map((r) => ({
      kind: "pack" as const, sourceId: String(r.id), paymentIntent: str(r.payment_intent), userId: String(r.user_id),
    })),
    ...(await o.read(`SELECT invoice_id AS id, payment_intent, user_id FROM stripe_invoices ORDER BY created_at`)).map((r) => ({
      kind: "subscription" as const, sourceId: String(r.id), paymentIntent: str(r.payment_intent), userId: String(r.user_id),
    })),
  ];

  for (const s of sources) {
    const isNew = !known.has(s.sourceId);
    if (!isNew && !known.get(s.sourceId)) continue; // déjà enregistré avec ses frais réels
    try {
      let paid: StripePaid | null = null;
      if (isNew) {
        paid = s.kind === "pack" ? await o.api.checkoutSession(s.sourceId) : await o.api.invoice(s.sourceId);
        if (!paid || !(paid.amountCents > 0)) {
          report.skipped.push({ sourceId: s.sourceId, why: paid ? "rien d'encaissé (montant nul)" : "introuvable ou non payé chez Stripe" });
          continue;
        }
      }
      const pi = paid?.paymentIntent ?? s.paymentIntent;
      const facts = pi ? await o.api.payment(pi) : null;
      if (isNew && paid) {
        report.toRecord++;
        report.recordedGrossUsd += (paid.amountCents / 100) * (usdPerUnit(paid.currency) ?? 0);
        if (o.write) {
          await recordPayment({
            sourceId: s.sourceId, kind: s.kind, paymentIntent: pi, userId: s.userId, currency: paid.currency,
            amountCents: paid.amountCents, taxCents: paid.taxCents, feeCents: facts?.feeCents ?? null,
            livemode: paid.livemode, paidAt: paid.paidAt ?? undefined,
          });
        }
      } else if (facts?.feeCents != null) {
        report.feesToFix++;
        if (o.write) await setRealFee(s.sourceId, facts.feeCents);
      }
      if (facts && pi) {
        if (facts.refundedCents > 0) {
          report.refunds++;
          if (o.write) await recordRefund(pi, facts.refundedCents);
        }
        for (const d of facts.disputes) {
          report.disputes++;
          if (o.write) await recordDispute(pi, d.amountCents, d.feeCents);
        }
      }
    } catch (e) {
      report.skipped.push({ sourceId: s.sourceId, why: e instanceof Error ? e.message.slice(0, 160) : String(e) });
    }
  }
  report.recordedGrossUsd = Math.round(report.recordedGrossUsd * 100) / 100;
  return report;
}
