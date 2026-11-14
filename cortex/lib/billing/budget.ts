import { authAll, type AuthTx } from "@/db/auth-store";
import { nowStr } from "@/db/q";
import { log } from "@/lib/metrics";
import { creditCost, DELTA_CENTI, fmtCredits } from "./credits";
import { floatLimit } from "./env";
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
 * Crédits achetés, dans la poche du ledger : tout sauf les crédits offerts à
 * l'inscription (`signup:*`), consommés EN DERNIER — le client qui a payé 10
 * crédits a toujours ses 10 générations ; ce qui reste au-delà vient du cadeau.
 * Les crédits d'abonnement de la période en cours sont achetés.
 *
 * Marge 0,6 par défaut : le coût réel d'un job varie du simple au triple
 * (QCM mesuré en prod du 13 au 14/11/2026 : médiane 4,48 $, maximum 6,01 $) et
 * deux jobs peuvent tourner en même temps ; 40 % de marge absorbent un job plus
 * cher que prévu sans faire passer le compte en perte. Elle ne peut dépasser 1.
 *
 * Plafond du jour par compte : min(SPEND_CAP_PER_USER_USD, max(plancher, ¼ B)),
 * vérifié AU LANCEMENT (429 « reviens demain », les crédits restent acquis). Le
 * plancher (8 $) est au-dessus du QCM le plus cher mesuré : un job lancé n'est
 * jamais coupé en route par ce plafond. SPEND_CAP_PER_USER_USD reste le fusible
 * vérifié à chaque appel (lib/billing/usage).
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
 * Coût IA ATTENDU d'un job, en dollars, par unité de prix : moyenne mesurée en
 * prod (cost:report, moteur du 13/11/2026). Surcharge : AI_JOB_COST_USD_JSON.
 * Inconnu → 1 $.
 */
const DEFAULT_JOB_COST_USD: Record<string, number> = { qcm: 4.3, exam: 2.1, prepare: 0.15, assist: 0.1 };

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

/** Plafond de dépense du JOUR d'un compte, cohérent avec son budget. null : pas de plafond. */
export function dailySpendCapUsd(budgetUsd: number): number | null {
  const fuse = floatLimit("SPEND_CAP_PER_USER_USD", 15);
  const floorRaw = Number(process.env.SPEND_CAP_PER_USER_FLOOR_USD);
  const floor = Number.isFinite(floorRaw) && floorRaw >= 0 ? floorRaw : 8;
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

export type BudgetCheck = {
  budget: AccountBudget;
  expectedUsd: number;
  /** Plafond global du mois lié au revenu et dépense des clients du mois ; null si levé. */
  global: { capUsd: number; spentUsd: number } | null;
};

/** Ce qu'il faut lire AVANT la transaction de réservation (rien n'y dépend du verrou). */
export async function budgetCheckFor(userId: string, kind: string, costCenti: number): Promise<BudgetCheck | null> {
  const budget = await accountBudget(userId);
  if (!budget) return null;
  const cap = await globalRevenueCapUsd();
  const global = cap === null ? null : { capUsd: cap, spentUsd: round4(await clientMonthSpendUsd()) };
  return { budget, expectedUsd: expectedJobCostUsd(kind, costCenti), global };
}

/** Crédits ACHETÉS disponibles dans le ledger (tout sauf les crédits offerts, consommés en dernier), en centièmes. */
export async function purchasedLedgerCenti(tx: AuthTx, userId: string, ledgerCenti: number): Promise<number> {
  const r = await tx.get<{ total: number | string | null }>(
    `SELECT coalesce(sum(${DELTA_CENTI}), 0) total FROM credit_transactions WHERE user_id = ? AND ref LIKE 'signup:%'`, userId,
  );
  return Math.max(0, ledgerCenti - Math.max(0, Number(r?.total ?? 0)));
}

const BUY_URL = "https://app.cortexexam.com/compte#credits";

/**
 * Verdict, dans la transaction verrouillée : null = passe. `paidCenti` = crédits
 * achetés disponibles (abonnement de la période + ledger hors cadeau).
 */
export function budgetVerdict(
  check: BudgetCheck, costCenti: number, paidCenti: number, ctx: { userId: string; kind: string },
): { status: number; error: string } | null {
  const { budget, expectedUsd, global } = check;
  // Dépense que les paiements ne couvrent pas (crédits offerts) : bornée aussi par le plafond global du mois.
  if (costCenti > paidCenti && global && global.spentUsd + expectedUsd > global.capUsd) {
    log("warn", "billing.revenue_cap_refused", { user: ctx.userId, kind: ctx.kind, spentUsd: global.spentUsd, capUsd: global.capUsd, expectedUsd });
    return {
      status: 402,
      error: "La capacité de génération offerte ce mois-ci est épuisée. Les crédits achetés restent toujours utilisables : "
        + `achète un pack ou abonne-toi pour continuer, sinon elle rouvre le 1er du mois. ${BUY_URL}`,
    };
  }
  if (budget.spentUsd + expectedUsd > budget.budgetUsd) {
    if (costCenti <= paidCenti) {
      // Crédits achetés : toujours servis. Le signal sert à corriger le PRIX.
      log("warn", "billing.budget_exceeded_paid_credits", {
        user: ctx.userId, kind: ctx.kind, spentUsd: budget.spentUsd, budgetUsd: budget.budgetUsd, expectedUsd, revenueUsd: budget.revenueUsd,
      });
    } else {
      log("info", "billing.budget_refused", { user: ctx.userId, kind: ctx.kind, spentUsd: budget.spentUsd, budgetUsd: budget.budgetUsd, expectedUsd });
      return {
        status: 402,
        error: `Cette génération dépasse ce que ton compte peut utiliser sans achat (il te reste ${fmtCredits(Math.max(0, paidCenti))} crédit(s) acheté(s), il en faut ${fmtCredits(costCenti)}). `
          + `Les crédits achetés restent toujours utilisables : achète un pack ou abonne-toi pour continuer. ${BUY_URL}`,
      };
    }
  }
  const dayCap = dailySpendCapUsd(budget.budgetUsd);
  // Le premier job du jour passe toujours : le plafond du jour ne bloque qu'un job de plus.
  if (dayCap !== null && budget.spentTodayUsd > 0 && budget.spentTodayUsd + expectedUsd > dayCap) {
    log("info", "billing.daily_cap_refused", { user: ctx.userId, kind: ctx.kind, spentTodayUsd: budget.spentTodayUsd, dayCapUsd: dayCap, expectedUsd });
    return {
      status: 429,
      error: "Limite de calcul du jour atteinte pour ton compte. Tes crédits restent acquis : réessaie demain.",
    };
  }
  return null;
}

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
