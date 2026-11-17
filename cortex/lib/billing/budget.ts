import { authAll, type AuthTx } from "@/db/auth-store";
import { nowStr } from "@/db/q";
import { log } from "@/lib/metrics";
import { creditCost, DELTA_CENTI } from "./credits";
import { floatLimit } from "./env";
import { quotaFor } from "./guards";
import { ownerUserIds } from "./owner";
import { accountRevenue, sinceDays, totalRevenue } from "./revenue";

/**
 * BUDGET IA LIÉ AU REVENU — règle de Ben (verrouillée) : ce que Cortex dépense
 * en IA pour un compte, jobs échoués et remboursés compris, reste inférieur à ce
 * que ce compte a réellement payé sur Stripe, net de frais, taxes,
 * remboursements et litiges (lib/billing/revenue).
 *
 *   B = AI_BUDGET_FREE_USD + AI_BUDGET_MARGIN × revenu net 12 mois glissants
 *
 * La dépense est celle de `llm_usage` sur 12 mois : chaque appel y est écrit,
 * que le job réussisse ou non (un remboursement rend des crédits, pas des
 * dollars). Une génération est refusée (402) quand dépense + coût attendu du job
 * dépasse B — SAUF si elle est payée par des crédits ACHETÉS : un crédit vendu
 * reste utilisable, même quand le prix du crédit ne couvre pas le coût réel
 * (c'est alors le prix qu'il faut corriger, pas le crédit qu'il faut bloquer).
 * Le budget arrête donc les crédits OFFERTS (inscription) au-delà de B.
 *
 * Crédits achetés, dans la poche du ledger : tout sauf les crédits OFFERTS
 * (OFFERED_CREDIT_SQL : inscription, crédits rendus après une dépense, pack à 0 €),
 * consommés EN DERNIER — le client qui a payé 10 crédits a toujours ses 10
 * générations ; ce qui reste au-delà vient du cadeau. Un job échoué après des
 * appels payants est remboursé en crédits offerts : sa dépense reste comptée et
 * le budget borne la boucle « échec → remboursement → relance » (audit B1).
 * Les crédits d'abonnement de la période en cours sont achetés.
 *
 * Marge 0,6 par défaut : le coût réel d'un job varie du simple au triple
 * (QCM en prod : 4,48 $ de médiane au 14/11 avant #106, 2 à 2,9 $ au 17/11 après) et
 * deux jobs peuvent tourner en même temps ; 40 % de marge absorbent un job plus
 * cher que prévu sans faire passer le compte en perte. Elle ne peut dépasser 1.
 *
 * Plafond du jour par compte : min(SPEND_CAP_PER_USER_USD, max(plancher, ¼ B)),
 * vérifié AU LANCEMENT avec le coût attendu des jobs encore en cours (429 « reviens
 * demain », les crédits restent acquis). Le plancher couvre DAILY_GEN_QUOTA générations
 * au coût attendu le plus cher, et 8 $ au moins (audit fuites I10) : ce plafond ne refuse
 * jamais avant les générations du jour annoncées, ni ne coupe un job lancé.
 * SPEND_CAP_PER_USER_USD reste le fusible vérifié à chaque appel (lib/billing/usage).
 *
 * Plafond global du mois lié au revenu (globalRevenueCapUsd) : vérifié au
 * lancement aussi, pour la seule dépense que les paiements ne couvrent pas.
 *
 * Le propriétaire est exempt (lib/billing/owner) ; AI_BUDGET_MARGIN=unlimited
 * retire le budget.
 */

export function aiBudgetMargin(): number | null {
  const m = floatLimit("AI_BUDGET_MARGIN", 0.6);
  return m === null ? null : Math.min(1, m);
}

/** Budget offert à un compte sans paiement (essai gratuit). 0 par défaut : la règle de Ben. */
export function aiBudgetFreeUsd(): number {
  const n = Number(process.env.AI_BUDGET_FREE_USD);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Coût IA ATTENDU d'un job, en dollars, par unité de prix : haut de la fourchette mesurée en
 * prod (QCM 2 à 2,9 $ au 17/11/2026 après #106 ; examen 2,2 $). Surcharge : AI_JOB_COST_USD_JSON.
 * Inconnu → 1 $.
 */
const DEFAULT_JOB_COST_USD: Record<string, number> = { qcm: 2.9, exam: 2.2, prepare: 0.15, assist: 0.1 };

export function expectedJobCostUsd(kind: string, costCenti?: number): number {
  let table = DEFAULT_JOB_COST_USD;
  const raw = process.env.AI_JOB_COST_USD_JSON?.trim();
  if (raw) {
    try {
      table = { ...DEFAULT_JOB_COST_USD, ...(JSON.parse(raw) as Record<string, number>) };
    } catch {
      log("warn", "billing.job_cost_json_invalid", { value: raw.slice(0, 80) });
    }
  }
  const per = Number(table[kind]);
  const unit = Number.isFinite(per) && per >= 0 ? per : 1;
  // Un QCM de 40 questions coûte deux unités de prix : il coûte aussi deux fois plus cher.
  const base = creditCost(kind);
  const units = base > 0 && costCenti && costCenti > base ? costCenti / base : 1;
  return unit * units;
}

/**
 * Plancher du plafond du jour : les générations du jour annoncées (DAILY_GEN_QUOTA) au coût
 * attendu de la plus chère (un QCM de 40 questions vaut deux unités), 8 $ au moins. Le fusible
 * SPEND_CAP_PER_USER_USD reste au-dessus de tout.
 */
function defaultDailyFloorUsd(): number {
  const quota = quotaFor("gen");
  const dearest = 2 * Math.max(expectedJobCostUsd("qcm"), expectedJobCostUsd("exam"));
  return Math.max(8, quota === null ? 0 : quota * dearest);
}

/** Plafond de dépense du JOUR d'un compte, cohérent avec son budget. null : pas de plafond. */
export function dailySpendCapUsd(budgetUsd: number): number | null {
  const fuse = floatLimit("SPEND_CAP_PER_USER_USD", 15);
  const floorRaw = Number(process.env.SPEND_CAP_PER_USER_FLOOR_USD);
  const floor = Number.isFinite(floorRaw) && floorRaw >= 0 ? floorRaw : defaultDailyFloorUsd();
  const v = Math.max(floor, 0.25 * Math.max(0, budgetUsd));
  return fuse === null ? v : Math.min(fuse, v);
}

async function sumSpend(userId: string, since: string): Promise<number> {
  const rows = await authAll<{ total: number | string | null }>(
    `SELECT coalesce(sum(cost_usd), 0) AS total FROM llm_usage WHERE user_id = ? AND created_at >= ?`, userId, since,
  );
  return Number(rows[0]?.total ?? 0);
}

export type AccountBudget = { budgetUsd: number; spentUsd: number; spentTodayUsd: number; revenueUsd: number; margin: number };

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** Budget d'un compte (null si le budget est retiré). Ne lève pas sur une base vide. */
export async function accountBudget(userId: string): Promise<AccountBudget | null> {
  const margin = aiBudgetMargin();
  if (margin === null) return null;
  const rev = await accountRevenue(userId);
  const spent = await sumSpend(userId, sinceDays(365));
  const today = await sumSpend(userId, `${nowStr().slice(0, 10)} 00:00:00`);
  return {
    budgetUsd: round4(aiBudgetFreeUsd() + margin * Math.max(0, rev.netUsd)),
    spentUsd: round4(spent),
    spentTodayUsd: round4(today),
    revenueUsd: rev.netUsd,
    margin,
  };
}

/**
 * Ligne du ledger qui crédite des crédits OFFERTS : marquée `offered` à l'écriture
 * (crédits rendus après dépense, pack à 0 €, inscription), ou inscription d'avant la
 * colonne. Les crédits du relecteur (`review_grant:`) restent achetés : accordés à la
 * main, bornés par le script (scripts/review-account.ts).
 */
export const OFFERED_CREDIT_SQL = `(offered = 1 OR ref LIKE 'signup:%')`;

/** Crédits ACHETÉS disponibles dans le ledger (tout sauf les crédits offerts, consommés en dernier), en centièmes. */
export async function purchasedLedgerCenti(tx: AuthTx, userId: string, ledgerCenti: number): Promise<number> {
  const r = await tx.get<{ total: number | string | null }>(
    `SELECT coalesce(sum(${DELTA_CENTI}), 0) total FROM credit_transactions WHERE user_id = ? AND ${DELTA_CENTI} > 0 AND ${OFFERED_CREDIT_SQL}`, userId,
  );
  return Math.max(0, ledgerCenti - Math.max(0, Number(r?.total ?? 0)));
}

// Le verdict (refus du budget, de la capacité offerte, du calcul du jour) vit dans
// lib/billing/limits, partagé par l'affichage, les pré-contrôles et la réservation.

// ─────────────────────── plafond global des comptes clients ───────────────────────

/**
 * Plafond de dépense du MOIS des comptes clients (hors propriétaire), garanti
 * par les paiements : SPEND_CAP_BASE_USD + marge × revenu du mois — le revenu
 * encaissé depuis le 1er (même fenêtre que la dépense : un paiement ne soutient
 * qu'un mois), ou la moyenne mensuelle des 12 derniers mois si elle est plus
 * haute (un abonnement annuel paie une fois pour douze mois). null : pas de
 * plafond lié au revenu (base ou marge levées).
 *
 * Vérifié AU LANCEMENT, pour la seule dépense que les paiements ne couvrent pas
 * (crédits offerts) : avec les prix actuels, les crédits achetés coûtent plus que
 * ce qu'ils rapportent, et un plafond appliqué à chaque appel les bloquerait —
 * un seul acheteur couperait la génération de tous. Les crédits achetés ne sont
 * bornés que par le fusible SPEND_CAP_USD (lib/billing/usage), à régler au
 * plafond de la console Anthropic ; c'est leur prix qui doit garantir la marge.
 */
export async function globalRevenueCapUsd(): Promise<number | null> {
  const base = floatLimit("SPEND_CAP_BASE_USD", 20);
  const margin = aiBudgetMargin();
  if (base === null || margin === null) return null;
  const owners = await ownerUserIds();
  const month = (await totalRevenue({ since: monthStart(), excludeUserIds: owners })).netUsd;
  const year = (await totalRevenue({ excludeUserIds: owners })).netUsd;
  return Math.round((base + margin * Math.max(0, month, year / 12)) * 100) / 100;
}

function monthStart(): string {
  return `${nowStr().slice(0, 7)}-01 00:00:00`;
}

/** Dépense du mois calendaire (UTC) des comptes clients (hors propriétaire). */
export async function clientMonthSpendUsd(): Promise<number> {
  const owners = await ownerUserIds();
  const notIn = owners.length ? ` AND user_id NOT IN (${owners.map(() => "?").join(",")})` : "";
  const rows = await authAll<{ total: number | string | null }>(
    `SELECT coalesce(sum(cost_usd), 0) AS total FROM llm_usage WHERE created_at >= ?${notIn}`, monthStart(), ...owners,
  );
  return Number(rows[0]?.total ?? 0);
}
