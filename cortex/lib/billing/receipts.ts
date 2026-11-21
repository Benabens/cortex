import type Stripe from "stripe";
import { authAll, authGet, authRun, type AuthTx } from "@/db/auth-store";
import { nowStr } from "@/db/q";
import { claimOnce, releaseClaim, SENT, settleClaim } from "@/lib/claim-once";
import { contactEmail } from "@/lib/contact";
import { sendEmail, type EmailOutcome } from "@/lib/email";
import { accountLocale } from "@/lib/i18n/account-locale";
import { log } from "@/lib/metrics";
import { publicOrigin } from "@/lib/public-url";
import { ORDER_INVOICE_EXPAND, orderFromInvoice, type Order, type OrderKind } from "./orders";
import { receiptEmail } from "./receipt-email";
import type { PlanKey } from "./stripe-events";

/**
 * REÇU CORTEX APRÈS PAIEMENT. Stripe envoie ses reçus avec la marque du COMPTE
 * (partagé avec Kairo : « Benabens », son icône, son adresse), et ne permet de les
 * couper qu'au niveau du compte. Cortex envoie donc le sien, depuis son adresse
 * (AUTH_EMAIL_FROM), dans la langue du compte (français à défaut, langue du contrat).
 *
 * FILE : le webhook (./stripe-events) pose une ligne `stripe_receipts` par paiement
 * ENCAISSÉ (pack payé, facture d'abonnement payée ; pas un pack offert à 0 €, pas
 * une autre application du compte), dans la transaction qui crédite. La route du
 * webhook l'envoie juste après sa réponse ; un passage toutes les 5 minutes
 * (instrumentation.ts) reprend ce qui n'est pas parti.
 *
 * CONTENU lu au moment d'écrire sur la FACTURE Stripe du paiement (./orders) :
 * numéro, montants, réductions par leur nom. Facture pas encore finalisée (le pack
 * reçoit la sienne juste après la session) ou Stripe injoignable : nouvel essai au
 * passage suivant. Passé 7 jours sans envoi, le reçu est abandonné, en erreur.
 *
 * UNE FOIS par paiement, même avec plusieurs instances : réclamation `receipt:<source>`
 * (lib/claim-once). Issue inconnue chez Resend : la réclamation reste et la reprise
 * garde la même clé d'idempotence ; refus net : clé rendue, nouvel essai sous une
 * nouvelle clé, abandon après 5 refus ou un refus qui ne passera pas tout seul (4xx).
 *
 * CORTEX_RECEIPTS=0 coupe l'envoi (la file se remplit quand même).
 */

/** Ce que ce module lit chez Stripe (le client réel convient ; un faux pour les tests). */
export type ReceiptStripe = {
  invoices: { retrieve(id: string, p?: { expand?: string[] }): Promise<Stripe.Invoice> };
  checkout: { sessions: { retrieve(id: string): Promise<{ invoice?: string | { id: string } | null }> } };
};
type Send = (mail: { to: string; subject: string; text: string; html?: string; idempotencyKey?: string }) => Promise<EmailOutcome>;

type Row = { source_id: string; kind: OrderKind; user_id: string; invoice_id: string | null; plan: string | null; attempts: number; created_at: string };
export type ReceiptReport = { sent: number; pending: number; failed: number };

const WINDOW_MS = 7 * 86_400_000;
const MAX_REFUSALS = 5;
export const RECEIPT_TICK_MS = 5 * 60_000;

export async function queueReceipt(r: { sourceId: string; kind: OrderKind; userId: string; invoiceId: string | null; plan: PlanKey | null }, tx?: AuthTx): Promise<void> {
  const sql = `INSERT INTO stripe_receipts (source_id, kind, user_id, invoice_id, plan, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT (source_id) DO NOTHING`;
  const args = [r.sourceId, r.kind, r.userId, r.invoiceId, r.plan, nowStr()];
  if (tx) await tx.run(sql, ...args);
  else await authRun(sql, ...args);
}

const idOf = (v: string | { id: string } | null | undefined) => (typeof v === "string" ? v : v?.id ?? null);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);
const isPlan = (v: string | null): v is PlanKey => v === "credits_10" || v === "pro_monthly" || v === "pro_yearly";

/**
 * La facture Stripe d'un paiement de Cortex : celle de la facture d'abonnement (in_…), ou
 * celle qu'`invoice_creation` a émise pour la session d'un pack (cs_…). null si elle n'existe
 * pas encore. Ne lit QUE les paiements de Cortex : l'appelant l'a vérifié (file ou stripe_payments).
 */
export async function invoiceIdOf(stripe: ReceiptStripe, sourceId: string, known: string | null): Promise<string | null> {
  if (known) return known;
  if (sourceId.startsWith("in_")) return sourceId;
  if (sourceId.startsWith("cs_")) return idOf((await stripe.checkout.sessions.retrieve(sourceId)).invoice);
  return null;
}

/** La commande d'un paiement, lue sur sa facture FINALISÉE et payée ; null tant qu'elle ne l'est pas. */
export async function loadOrder(stripe: ReceiptStripe, p: { sourceId: string; kind: OrderKind; invoiceId: string | null; plan: string | null }): Promise<{ order: Order; invoiceId: string } | null> {
  const invoiceId = await invoiceIdOf(stripe, p.sourceId, p.invoiceId);
  if (!invoiceId) return null;
  const inv = await stripe.invoices.retrieve(invoiceId, { expand: ORDER_INVOICE_EXPAND });
  if (inv.status !== "paid" || !inv.number) return null;
  return { order: orderFromInvoice(inv, { kind: p.kind, plan: isPlan(p.plan) ? p.plan : null }), invoiceId };
}

export async function sendPendingReceipts(o: { stripe: ReceiptStripe; send?: Send; only?: string; now?: Date }): Promise<ReceiptReport> {
  const report: ReceiptReport = { sent: 0, pending: 0, failed: 0 };
  const now = o.now ?? new Date();
  const cutoff = new Date(now.getTime() - WINDOW_MS).toISOString().slice(0, 19).replace("T", " ");
  // Trop vieux pour partir encore : abandonné, et dit une fois.
  const stale = await authAll<{ source_id: string }>(`SELECT source_id FROM stripe_receipts WHERE sent_at IS NULL AND failed_at IS NULL AND created_at < ?`, cutoff);
  for (const r of stale) {
    await authRun(`UPDATE stripe_receipts SET failed_at = ?, last_error = coalesce(last_error, 'facture introuvable ou jamais finalisée') WHERE source_id = ? AND sent_at IS NULL`, nowStr(), r.source_id);
    log("error", "receipt.abandoned", { source: r.source_id, message: "Reçu Cortex jamais parti en 7 jours : à envoyer à la main (facture depuis Mon compte)." });
  }
  const rows = await authAll<Row>(
    `SELECT source_id, kind, user_id, invoice_id, plan, attempts, created_at FROM stripe_receipts
     WHERE sent_at IS NULL AND failed_at IS NULL AND created_at >= ?${o.only ? " AND source_id = ?" : ""} ORDER BY created_at`,
    ...(o.only ? [cutoff, o.only] : [cutoff]),
  );
  for (const row of rows) await sendOne(row, o.stripe, o.send ?? sendEmail, report);
  return report;
}

async function sendOne(row: Row, stripe: ReceiptStripe, send: Send, report: ReceiptReport): Promise<void> {
  const key = `receipt:${row.source_id}`;
  const context = { source: row.source_id, user: row.user_id };
  const claim = await claimOnce(key);
  if (claim.state === "sent") {
    await authRun(`UPDATE stripe_receipts SET sent_at = coalesce(sent_at, ?) WHERE source_id = ?`, nowStr(), row.source_id);
    return;
  }
  if (claim.state === "busy") { report.pending++; return; }
  const later = async (reason: string) => {
    await releaseClaim(key, claim.token);
    await authRun(`UPDATE stripe_receipts SET last_error = ? WHERE source_id = ?`, reason, row.source_id);
    report.pending++;
    log("warn", "receipt.not_sent", { ...context, reason });
  };
  const fail = async (reason: string) => {
    await releaseClaim(key, claim.token);
    await authRun(`UPDATE stripe_receipts SET failed_at = ?, last_error = ? WHERE source_id = ?`, nowStr(), reason, row.source_id);
    report.failed++;
    log("error", "receipt.failed", { ...context, reason });
  };

  const origin = publicOrigin();
  if (!origin) return later("AUTH_URL manquante");
  let loaded: Awaited<ReturnType<typeof loadOrder>>;
  try {
    loaded = await loadOrder(stripe, { sourceId: row.source_id, kind: row.kind, invoiceId: row.invoice_id, plan: row.plan });
  } catch (e) {
    return later(`Stripe : ${message(e)}`);
  }
  if (!loaded) return later("facture Stripe pas encore finalisée");
  if (!row.invoice_id) await authRun(`UPDATE stripe_receipts SET invoice_id = ? WHERE source_id = ?`, loaded.invoiceId, row.source_id);
  const email = (await authGet<{ email: string | null }>(`SELECT email FROM users WHERE id = ?`, row.user_id))?.email;
  if (!email) return fail("compte sans adresse e-mail");

  const mail = receiptEmail(loaded.order, {
    locale: (await accountLocale(row.user_id).catch(() => null)) ?? "fr",
    accountUrl: `${origin}/compte`,
    invoiceUrl: `${origin}/api/billing/invoices/${encodeURIComponent(row.source_id)}`,
    contact: contactEmail(),
  });
  const outcome = await send({ to: email, ...mail, idempotencyKey: `${key}:${claim.chain}` });
  if (outcome.ok) {
    await settleClaim(key, claim.token, `${SENT} ${new Date().toISOString()}`);
    await authRun(`UPDATE stripe_receipts SET sent_at = ?, last_error = NULL WHERE source_id = ?`, nowStr(), row.source_id);
    report.sent++;
    log("info", "receipt.sent", context);
    return;
  }
  if (outcome.uncertain) {
    // La réclamation reste : la reprise (process mort, ou passage suivant après le délai) garde la clé.
    report.pending++;
    log("warn", "receipt.not_sent", { ...context, reason: outcome.reason, uncertain: true });
    return;
  }
  const attempts = Number(row.attempts) + 1;
  await authRun(`UPDATE stripe_receipts SET attempts = ? WHERE source_id = ?`, attempts, row.source_id);
  // Un 4xx (clé, expéditeur, destinataire) se répétera à l'identique ; un 429 passe tout seul.
  const lasting = !!outcome.status && outcome.status < 500 && outcome.status !== 429;
  if (lasting || attempts >= MAX_REFUSALS) return fail(`Resend : ${outcome.reason}`);
  return later(`Resend : ${outcome.reason}`);
}

/** Envoi coupé (CORTEX_RECEIPTS=0), ou impossible : raison, sinon null. */
export function receiptsBlocker(env: Partial<NodeJS.ProcessEnv> = process.env): string | null {
  if (env.BILLING_ENABLED !== "1") return "facturation désactivée";
  if (env.CORTEX_RECEIPTS === "0") return "CORTEX_RECEIPTS=0";
  if (!env.STRIPE_SECRET_KEY) return "STRIPE_SECRET_KEY absente";
  if (!env.RESEND_API_KEY) return "RESEND_API_KEY absente";
  return null;
}

/** Envoi juste après le webhook : ne lève jamais (la file reprend au passage suivant). */
export async function sendReceiptSoon(stripe: ReceiptStripe, sourceId: string): Promise<void> {
  if (receiptsBlocker()) return;
  await sendPendingReceipts({ stripe, only: sourceId }).catch((e) => log("warn", "receipt.not_sent", { source: sourceId, reason: message(e) }));
}

/** Passage périodique (une minuterie par process, hot-reload safe). null si l'envoi est coupé ou impossible. */
export function startReceiptScheduler(stripe: () => ReceiptStripe): NodeJS.Timeout | null {
  const g = globalThis as { __cortexReceiptTimer?: NodeJS.Timeout };
  if (g.__cortexReceiptTimer) clearInterval(g.__cortexReceiptTimer);
  const blocked = receiptsBlocker();
  if (blocked) {
    if (process.env.BILLING_ENABLED === "1") log("warn", "receipt.disabled", { reason: blocked, message: `Reçus Cortex non envoyés (${blocked}).` });
    return null;
  }
  const tick = () => sendPendingReceipts({ stripe: stripe() })
    .then((r) => { if (r.sent || r.failed) log("info", "receipt.sweep", r); })
    .catch((e) => log("error", "receipt.sweep_failed", { message: message(e) }));
  g.__cortexReceiptTimer = setInterval(tick, RECEIPT_TICK_MS);
  g.__cortexReceiptTimer.unref?.();
  return g.__cortexReceiptTimer;
}
