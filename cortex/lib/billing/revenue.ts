import { authAll, authRun, type AuthTx } from "@/db/auth-store";
import { nowStr } from "@/db/q";
import { log } from "@/lib/metrics";

/**
 * REVENU RÉELLEMENT ENCAISSÉ, par compte : la base du budget IA (lib/billing/budget).
 *
 * Règle de Ben : ce que Cortex dépense en IA pour un compte reste inférieur à ce
 * que ce compte a payé sur Stripe, NET des frais Stripe, des taxes collectées,
 * des remboursements et des litiges.
 *
 * Deux tables, écrites par le webhook (lib/billing/stripe-events) et par la
 * reprise de l'historique (scripts/stripe-revenue-backfill.ts) :
 *  - `stripe_payments` : un paiement (pack ou facture d'abonnement), son montant,
 *    sa devise, la taxe, les frais Stripe (réels, ou ESTIMÉS si Stripe n'a pas
 *    répondu — `fee_estimated`, remplacés par la reprise) ;
 *  - `stripe_payment_losses` : ce qui a été perdu sur ce paiement, par
 *    payment_intent (remboursé CUMULÉ, montant contesté, frais de litige). Séparé
 *    pour qu'un remboursement arrivé avant l'achat s'applique quand l'achat arrive.
 *
 * Net d'un paiement = gardé − taxe au prorata du gardé − frais − frais de litige,
 * où gardé = montant − min(montant, remboursé + contesté). Les frais Stripe ne
 * sont pas rendus sur un remboursement : un paiement remboursé coûte ses frais.
 * Un litige est compté PERDU dès son ouverture (charge.dispute.closed n'est pas
 * écouté) : prudent.
 *
 * Conversion en dollars (la dépense IA est en dollars) : FX_USD_JSON, dollars
 * pour une unité de devise. Défaut {"usd":1,"eur":1} : l'euro compté au pair,
 * sous son cours réel, donc prudent. Une devise absente du tableau vaut 0.
 */

export type PaymentKind = "pack" | "subscription";

export type PaymentInput = {
  /** cs_… (pack) ou in_… (facture) : un paiement n'est enregistré qu'une fois. */
  sourceId: string;
  kind: PaymentKind;
  paymentIntent: string | null;
  userId: string;
  currency: string;
  amountCents: number;
  taxCents?: number;
  /** Frais Stripe réels ; null → estimés (STRIPE_FEE_PERCENT / STRIPE_FEE_FIXED_CENTS). */
  feeCents: number | null;
  livemode?: boolean;
  /** "YYYY-MM-DD HH:MM:SS" UTC, date du paiement chez Stripe. */
  paidAt?: string | null;
};

export type Revenue = {
  payments: number;
  grossUsd: number;
  netUsd: number;
  /** Paiements dont les frais sont encore estimés. */
  estimatedFees: number;
  /** Devises rencontrées sans taux : comptées 0. */
  unconverted: string[];
};

const DAY_MS = 86400_000;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Frais Stripe estimés d'un paiement (carte hors EEE par défaut : 3,25 % + 25 c, au centime supérieur). */
export function estimateFeeCents(amountCents: number): number {
  if (!(amountCents > 0)) return 0;
  return Math.ceil((amountCents * envNumber("STRIPE_FEE_PERCENT", 3.25)) / 100) + Math.round(envNumber("STRIPE_FEE_FIXED_CENTS", 25));
}

/** Frais de litige estimés quand Stripe ne les donne pas (20 € en zone euro). */
export function estimateDisputeFeeCents(): number {
  return Math.round(envNumber("STRIPE_DISPUTE_FEE_CENTS", 2000));
}

let warnedFx = "";
/** Dollars pour une unité de `currency`, ou null sans taux connu. */
export function usdPerUnit(currency: string): number | null {
  let table: Record<string, unknown> = { usd: 1, eur: 1 };
  const raw = process.env.FX_USD_JSON?.trim();
  if (raw) {
    try {
      table = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      if (warnedFx !== raw) log("error", "billing.fx_json_invalid", { value: raw.slice(0, 80) });
      warnedFx = raw;
      return null; // configuration illisible : aucun revenu compté plutôt qu'un revenu faux
    }
  }
  const rate = Number(table[currency.toLowerCase()]);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** Enregistre un paiement encaissé (idempotent par sourceId). Dans `tx` si fourni : même transaction que le crédit. */
export async function recordPayment(p: PaymentInput, tx?: AuthTx): Promise<void> {
  if (!(p.amountCents > 0)) return; // rien d'encaissé, rien à compter
  const estimated = p.feeCents == null;
  const fee = estimated ? estimateFeeCents(p.amountCents) : Math.max(0, Math.round(p.feeCents!));
  const now = nowStr();
  const params = [
    p.sourceId, p.kind, p.paymentIntent, p.userId, p.currency.toLowerCase(), Math.round(p.amountCents),
    Math.max(0, Math.round(p.taxCents ?? 0)), fee, estimated ? 1 : 0, p.livemode ? 1 : 0, p.paidAt ?? now, now,
  ] as const;
  const sql = `INSERT INTO stripe_payments (source_id, kind, payment_intent, user_id, currency, amount_cents, tax_cents, fee_cents,
      fee_estimated, livemode, paid_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (source_id) DO NOTHING`;
  if (tx) await tx.run(sql, ...params);
  else await authRun(sql, ...params);
}

/** Remplace des frais estimés par les frais réels (reprise de l'historique). */
export async function setRealFee(sourceId: string, feeCents: number): Promise<void> {
  await authRun(`UPDATE stripe_payments SET fee_cents = ?, fee_estimated = 0, updated_at = ? WHERE source_id = ?`, Math.max(0, Math.round(feeCents)), nowStr(), sourceId);
}

async function ensureLossRow(paymentIntent: string): Promise<void> {
  await authRun(`INSERT INTO stripe_payment_losses (payment_intent, updated_at) VALUES (?, ?) ON CONFLICT (payment_intent) DO NOTHING`, paymentIntent, nowStr());
}

/**
 * Remboursé CUMULÉ d'un paiement (Stripe envoie `amount_refunded` cumulé) : on
 * garde le plus grand vu, donc un rejeu ou un événement livré en retard ne
 * l'additionne pas et ne le fait pas baisser.
 */
export async function recordRefund(paymentIntent: string | null, refundedCents: number): Promise<void> {
  if (!paymentIntent || !(refundedCents > 0)) return;
  await ensureLossRow(paymentIntent);
  const v = Math.round(refundedCents);
  await authRun(
    `UPDATE stripe_payment_losses SET refunded_cents = ?, updated_at = ? WHERE payment_intent = ? AND refunded_cents < ?`,
    v, nowStr(), paymentIntent, v,
  );
}

/** Litige ouvert : montant contesté et frais de litige (réels si Stripe les donne, sinon estimés). */
export async function recordDispute(paymentIntent: string | null, amountCents: number, feeCents: number | null): Promise<void> {
  if (!paymentIntent || !(amountCents > 0)) return;
  await ensureLossRow(paymentIntent);
  const amount = Math.round(amountCents);
  const est = feeCents == null ? 1 : 0;
  const fee = est ? estimateDisputeFeeCents() : Math.max(0, Math.round(feeCents!));
  // Des frais réels remplacent toujours ; une estimation ne remplit qu'un vide.
  // (Les CASE lisent les valeurs d'avant la mise à jour, en Postgres comme en SQLite.)
  await authRun(
    `UPDATE stripe_payment_losses SET disputed_cents = CASE WHEN disputed_cents < ? THEN ? ELSE disputed_cents END,
       dispute_fee_cents = CASE WHEN ? = 0 OR dispute_fee_cents = 0 THEN ? ELSE dispute_fee_cents END,
       dispute_fee_estimated = CASE WHEN ? = 0 THEN 0 WHEN dispute_fee_cents = 0 THEN 1 ELSE dispute_fee_estimated END,
       updated_at = ?
     WHERE payment_intent = ?`,
    amount, amount, est, fee, est, nowStr(), paymentIntent,
  );
}

/**
 * Facture enregistrée sans payment_intent (format récent de Stripe) puis
 * retrouvée par la reprise : le paiement prend ce payment_intent, ce qui le relie
 * à ses pertes.
 */
export async function linkInvoicePaymentIntent(paymentIntent: string | null): Promise<void> {
  if (!paymentIntent) return;
  await authRun(
    `UPDATE stripe_payments SET payment_intent = ? WHERE payment_intent IS NULL
       AND source_id IN (SELECT invoice_id FROM stripe_invoices WHERE payment_intent = ?)`,
    paymentIntent, paymentIntent,
  );
}

type Row = {
  currency: string; amount_cents: number | string; tax_cents: number | string; fee_cents: number | string;
  fee_estimated: number | string; refunded_cents: number | string | null; disputed_cents: number | string | null;
  dispute_fee_cents: number | string | null;
};

/** Net d'un paiement, en unités mineures de sa devise (peut être négatif : frais d'un paiement remboursé). */
export function netCents(r: { amount: number; tax: number; fee: number; refunded: number; disputed: number; disputeFee: number }): number {
  if (!(r.amount > 0)) return -r.fee - r.disputeFee;
  const kept = r.amount - Math.min(r.amount, Math.max(0, r.refunded) + Math.max(0, r.disputed));
  return kept - (r.tax * kept) / r.amount - r.fee - r.disputeFee;
}

function sumRevenue(rows: Row[]): Revenue {
  let gross = 0;
  let net = 0;
  let estimated = 0;
  const unconverted = new Set<string>();
  for (const r of rows) {
    const amount = Number(r.amount_cents);
    const n = netCents({
      amount, tax: Number(r.tax_cents), fee: Number(r.fee_cents),
      refunded: Number(r.refunded_cents ?? 0), disputed: Number(r.disputed_cents ?? 0), disputeFee: Number(r.dispute_fee_cents ?? 0),
    });
    if (Number(r.fee_estimated)) estimated++;
    const rate = usdPerUnit(r.currency);
    if (rate == null) {
      unconverted.add(r.currency);
      continue;
    }
    gross += (amount * rate) / 100;
    net += (n * rate) / 100;
  }
  return { payments: rows.length, grossUsd: round6(gross), netUsd: round6(net), estimatedFees: estimated, unconverted: [...unconverted].sort() };
}
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

const SELECT_ROWS = `SELECT p.currency, p.amount_cents, p.tax_cents, p.fee_cents, p.fee_estimated,
    l.refunded_cents, l.disputed_cents, l.dispute_fee_cents
  FROM stripe_payments p LEFT JOIN stripe_payment_losses l ON l.payment_intent = p.payment_intent`;

/** Date "YYYY-MM-DD HH:MM:SS" il y a `days` jours. */
export function sinceDays(days: number, now = Date.now()): string {
  return new Date(now - days * DAY_MS).toISOString().slice(0, 19).replace("T", " ");
}

/** Revenu net d'un compte sur les `days` derniers jours (12 mois glissants par défaut). */
export async function accountRevenue(userId: string, opts: { days?: number } = {}): Promise<Revenue> {
  const rows = await authAll<Row>(`${SELECT_ROWS} WHERE p.user_id = ? AND p.paid_at >= ?`, userId, sinceDays(opts.days ?? 365));
  return sumRevenue(rows);
}

/** Revenu net de tous les comptes (plafond global), hors comptes exclus (propriétaire). */
export async function totalRevenue(opts: { days?: number; excludeUserIds?: string[] } = {}): Promise<Revenue> {
  const excluded = (opts.excludeUserIds ?? []).filter(Boolean);
  const notIn = excluded.length ? ` AND p.user_id NOT IN (${excluded.map(() => "?").join(",")})` : "";
  const rows = await authAll<Row>(`${SELECT_ROWS} WHERE p.paid_at >= ?${notIn}`, sinceDays(opts.days ?? 365), ...excluded);
  return sumRevenue(rows);
}
