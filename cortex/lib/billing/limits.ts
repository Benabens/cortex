import { authAll, authGet, type AuthTx } from "@/db/auth-store";
import { currentUser } from "@/db/context";
import { nowStr } from "@/db/q";
import { defaultProviderName } from "@/lib/llm/config";
import { MiB, storageQuotaBytesFor, userStorageBytes } from "@/lib/storage-quota";
import { accountBudget, aiBudgetMargin, clientMonthSpendUsd, dailySpendCapUsd, expectedJobCostUsd, globalRevenueCapUsd, purchasedLedgerCenti } from "./budget";
import { DELTA_CENTI, billingEnabled, creditCost, ensureLedgerUnit, ensureSignupCredits, fromCenti, insufficient, subscriptionLive, type SubRow } from "./credits";
import { quotaFor, quotaTrackingActive, ratePerUserPerMin, type QuotaBucket } from "./guards";
import { intLimit } from "./env";
import { isOwner } from "./owner";
import { rechargeDue, nextRechargeDate } from "./subscription-windows";
import { isPaidProvider, spendCapPerUserUsd, spendCapUsd, spendMonth } from "./usage";
import { formatReset, type LimitKey, type LaunchKind, type UsageLimits, type UsageLimit, type KindUsage } from "./limits-text";
import { currentLocale } from "@/lib/i18n/current";
import type { Messages } from "@/lib/i18n/messages";
import { translator } from "@/lib/i18n/translate";
import { refusal, type Refusal, type UserError } from "@/lib/i18n/user-error";

export type { LimitKey, LaunchKind, UsageLimits, UsageLimit, KindUsage } from "./limits-text";

/**
 * LIMITES D'USAGE — LA source de vérité de tout ce qui peut empêcher un étudiant
 * de lancer une génération : crédits, quotas du jour, débit par minute,
 * générations simultanées, plafonds de calcul (par compte et par jour, budget
 * lié au revenu, capacité offerte du mois, fusible global du mois) et stockage.
 *
 * Trois consommateurs, UNE règle :
 *  - l'affichage (page compte, indicateur à côté des boutons, get_account_status) ;
 *  - les pré-contrôles AVANT de créer un job (routes de l'app, devis MCP) ;
 *  - la réservation atomique (lib/billing/reserve), qui relit les compteurs sous
 *    verrou et rend le MÊME verdict, avec le même message.
 * Chacun lit un `LimitsState` puis appelle `launchVerdict` (pur) : il n'existe
 * pas de second jeu de conditions qui pourrait dériver.
 *
 * Les plafonds en dollars ne sortent jamais d'ici en dollars : l'étudiant voit
 * des crédits, des générations, des pourcentages et des dates.
 *
 * Plafonds de calcul : un job est admis si dépense du jour + coût attendu des
 * jobs déjà admis et encore en cours + coût attendu du nouveau ≤ plafond. Le
 * coût attendu des jobs en cours est réservé dans `active_jobs` sous le verrou :
 * deux lancements simultanés ne peuvent pas passer tous les deux sous la limite.
 * Le premier job du jour passe toujours (comme avant : un plafond réglé sous le
 * coût d'un job ne doit pas bloquer à vie). Ces plafonds ne comptent que si le
 * fournisseur du modèle est payant (CLI local : 0 dépense, rien à borner).
 */

/** Ce que l'on veut lancer, tel que la réservation le facture. */
export type LaunchSpec = {
  bucket: QuotaBucket;
  /** Type facturé (clé de CREDITS_COST_JSON / coût attendu) : exam, qcm, prepare, assist… */
  kind: string;
  costCenti: number;
  /** Un job (place « génération en cours », coût réservé dans active_jobs) ; faux pour l'assistance. */
  jobSlot: boolean;
};

/** Les générations que l'étudiant lance, à leur taille standard. */
export const LAUNCH_KINDS: Record<LaunchKind, { label: string; plural: string; bucket: QuotaBucket; jobType: string | null }> = {
  exam: { label: "examen écrit", plural: "examens écrits", bucket: "gen", jobType: "exam" },
  qcm: { label: "examen QCM (20 questions)", plural: "examens QCM", bucket: "gen", jobType: "qcm" },
  exercise: { label: "exercice", plural: "exercices", bucket: "gen", jobType: "exercise" },
  prepare: { label: "préparation de cours", plural: "préparations de cours", bucket: "gen", jobType: "prepare" },
  check: { label: "vérification de réponse", plural: "vérifications", bucket: "assist", jobType: null },
  drill: { label: "question d'entraînement", plural: "questions d'entraînement", bucket: "assist", jobType: null },
};

/** Spécification d'un job (coût proportionnel à sa taille, cf. lib/jobs costForJob). */
export function jobSpec(type: string, costCenti: number): LaunchSpec {
  return { bucket: "gen", kind: type, costCenti, jobSlot: true };
}

/** Spécification d'un appel d'assistance (drill, correction, analyses) : tarif « assist ». */
export function assistSpec(): LaunchSpec {
  return { bucket: "assist", kind: "assist", costCenti: creditCost("assist"), jobSlot: false };
}

// ───────────────────────────── état lu ─────────────────────────────

type Db = Pick<AuthTx, "get" | "all">;
const authDb: Db = { get: authGet, all: authAll };

/** Plafonds de dépense en vigueur pour ce compte (null = levé ou sans objet). */
type SpendState = {
  /** Fournisseur payant : les plafonds de calcul s'appliquent. */
  paid: boolean;
  /** Fusible du jour par compte (SPEND_CAP_PER_USER_USD) ; le propriétaire en est exempt. */
  userFuseUsd: number | null;
  userSpentTodayUsd: number;
  /** Budget lié au revenu (facturation active, hors propriétaire). */
  budget: { budgetUsd: number; spentUsd: number; spentTodayUsd: number } | null;
  /** Capacité offerte du mois (dépense non couverte par un paiement). */
  freeMonth: { capUsd: number; spentUsd: number } | null;
  /** Fusible global du mois (SPEND_CAP_USD) : vaut pour tous, propriétaire compris. */
  globalCapUsd: number | null;
  globalSpentUsd: number;
};

/** Compteurs du compte, lus hors verrou (affichage) ou sous verrou (réservation). */
type CounterState = {
  quota: Record<QuotaBucket, { used: number; cap: number | null }>;
  rate: { used: number; cap: number | null; oldestAt: string | null };
  slots: { used: number; cap: number | null };
  /** Coût attendu des jobs admis encore en cours : ceux du compte, ceux de tous. */
  committedUserUsd: number;
  committedGlobalUsd: number;
  credits: { balanceCenti: number; subCenti: number; paidCenti: number; rechargeWindow: string | null; rechargeAt: string | null } | null;
};

export type LimitsState = SpendState & CounterState & {
  now: string;
  owner: boolean;
  billing: boolean;
  storage: { usedBytes: number; quotaBytes: number } | null;
};

/** Plafond de générations simultanées par compte (défaut 2 en déploiement gardé ; « unlimited » pour lever). */
export function maxActiveJobsLimit(): number | null {
  return intLimit("MAX_ACTIVE_JOBS", 2);
}

/** Au-delà de cet âge, une place active est orpheline (worker mort sans état terminal). */
export const SLOT_MAX_AGE_MS = 6 * 3600_000;

const sumUsd = async (db: Db, sql: string, ...p: (string | number)[]) =>
  Number((await db.get<{ total: number | string | null }>(sql, ...p))?.total ?? 0);

/** Plafonds de dépense : lus HORS de la transaction (la dépense s'écrit pendant les appels, pas au lancement). */
export async function readSpendState(userId: string, owner: boolean, billing: boolean): Promise<SpendState> {
  const paid = isPaidProvider(defaultProviderName());
  const now = nowStr();
  const day = now.slice(0, 10);
  const userFuseUsd = owner ? null : spendCapPerUserUsd();
  const globalCapUsd = spendCapUsd();
  const needUserDay = paid && userFuseUsd !== null;
  const userSpentTodayUsd = needUserDay
    ? await sumUsd(authDb, `SELECT coalesce(sum(cost_usd), 0) AS total FROM llm_usage WHERE user_id = ? AND substr(created_at, 1, 10) = ?`, userId, day)
    : 0;
  const globalSpentUsd = paid && globalCapUsd !== null
    ? await sumUsd(authDb, `SELECT coalesce(sum(cost_usd), 0) AS total FROM llm_usage WHERE substr(created_at, 1, 7) = ?`, spendMonth())
    : 0;
  let budget: SpendState["budget"] = null;
  let freeMonth: SpendState["freeMonth"] = null;
  if (billing && !owner && aiBudgetMargin() !== null) {
    const b = await accountBudget(userId);
    if (b) budget = { budgetUsd: b.budgetUsd, spentUsd: b.spentUsd, spentTodayUsd: b.spentTodayUsd };
    const cap = await globalRevenueCapUsd();
    if (cap !== null) freeMonth = { capUsd: cap, spentUsd: await clientMonthSpendUsd() };
  }
  return { paid, userFuseUsd, userSpentTodayUsd, budget, freeMonth, globalCapUsd, globalSpentUsd };
}

/**
 * Compteurs du compte. `db` = la transaction verrouillée de la réservation, ou
 * le store en lecture simple pour l'affichage : mêmes requêtes dans les deux cas.
 * N'écrit rien (la recharge d'une fenêtre d'abonnement est rendue, pas posée).
 */
export async function readCounterState(db: Db, userId: string, owner: boolean, billing: boolean, now = nowStr()): Promise<CounterState> {
  const tracking = quotaTrackingActive();
  const day = now.slice(0, 10);
  const quota = {} as CounterState["quota"];
  for (const bucket of ["gen", "assist"] as const) {
    const cap = owner || !tracking ? null : quotaFor(bucket);
    const used = tracking
      ? Number((await db.get<{ n: number }>(`SELECT count(*) n FROM gen_events WHERE user_id = ? AND bucket = ? AND day = ?`, userId, bucket, day))?.n ?? 0)
      : 0;
    quota[bucket] = { used, cap };
  }
  const rateCap = owner || !tracking ? null : ratePerUserPerMin();
  let rate: CounterState["rate"] = { used: 0, cap: rateCap, oldestAt: null };
  if (rateCap !== null) {
    const r = await db.get<{ n: number; oldest: string | null }>(
      `SELECT count(*) n, min(created_at) oldest FROM gen_events WHERE user_id = ? AND bucket <> 'ingest' AND created_at >= ?`, userId, isoOffset(now, -60_000),
    );
    rate = { used: Number(r?.n ?? 0), cap: rateCap, oldestAt: r?.oldest ?? null };
  }
  const slotCap = owner ? null : maxActiveJobsLimit();
  let slotsUsed = 0;
  let committedUserUsd = 0;
  let committedGlobalUsd = 0;
  if (tracking || slotCap !== null || spendCapUsd() !== null) {
    const fresh = isoOffset(now, -SLOT_MAX_AGE_MS);
    const rows = await db.all<{ user_id: string; expected_usd: number | string | null }>(
      `SELECT user_id, expected_usd FROM active_jobs WHERE created_at >= ?`, fresh,
    ).catch(() => [] as Array<{ user_id: string; expected_usd: number | string | null }>);
    for (const r of rows) {
      const usd = Number(r.expected_usd ?? 0) || 0;
      committedGlobalUsd += usd;
      if (r.user_id === userId) { slotsUsed++; committedUserUsd += usd; }
    }
  }
  let credits: CounterState["credits"] = null;
  if (billing && !owner) {
    const sub = await db.get<SubRow>(`SELECT * FROM subscriptions WHERE user_id = ?`, userId);
    let subCenti = 0;
    let rechargeWindow: string | null = null;
    if (subscriptionLive(sub, now)) {
      rechargeWindow = rechargeDue(sub!, now);
      subCenti = rechargeWindow ? Number(sub!.monthly_credits) || 0 : Math.max(0, Number(sub!.remaining) || 0);
    }
    const ledger = Number((await db.get<{ total: number | null }>(
      `SELECT coalesce(sum(${DELTA_CENTI}), 0) total FROM credit_transactions WHERE user_id = ?`, userId,
    ))?.total ?? 0);
    const paidCenti = subCenti + (await purchasedLedgerCenti(db as AuthTx, userId, ledger));
    credits = { balanceCenti: ledger + subCenti, subCenti, paidCenti, rechargeWindow, rechargeAt: sub ? nextRechargeDate(sub, now) : null };
  }
  return { quota, rate, slots: { used: slotsUsed, cap: slotCap }, committedUserUsd, committedGlobalUsd, credits };
}

/** État complet, hors verrou : pour l'affichage et les pré-contrôles. */
export async function readLimitsState(userId = currentUser()): Promise<LimitsState> {
  const owner = await isOwner(userId);
  const billing = billingEnabled();
  if (billing && !owner) {
    await ensureLedgerUnit();
    await ensureSignupCredits(userId);
  }
  const now = nowStr();
  const guarded = guardedStore();
  const spend = guarded ? await readSpendState(userId, owner, billing) : emptySpend();
  const counters = guarded ? await readCounterState(authDb, userId, owner, billing, now) : emptyCounters();
  let storage: LimitsState["storage"] = null;
  const quotaBytes = await storageQuotaBytesFor(userId).catch(() => null);
  if (quotaBytes !== null) storage = { usedBytes: await userStorageBytes(userId).catch(() => 0), quotaBytes };
  return { ...spend, ...counters, now, owner, billing, storage };
}

/** Un store global existe-t-il à lire ? Sans garde-fou (dev €0 nu), aucune lecture ne doit le créer. */
function guardedStore(): boolean {
  return quotaTrackingActive() || billingEnabled() || spendCapUsd() !== null;
}

function emptySpend(): SpendState {
  return { paid: false, userFuseUsd: null, userSpentTodayUsd: 0, budget: null, freeMonth: null, globalCapUsd: null, globalSpentUsd: 0 };
}
function emptyCounters(): CounterState {
  return {
    quota: { gen: { used: 0, cap: null }, assist: { used: 0, cap: null } },
    rate: { used: 0, cap: null, oldestAt: null }, slots: { used: 0, cap: null },
    committedUserUsd: 0, committedGlobalUsd: 0, credits: null,
  };
}

// ───────────────────────────── verdict ─────────────────────────────

/** « AAAA-MM-JJ HH:MM:SS » (UTC, format de nowStr) décalé. */
function isoOffset(now: string, ms: number): string {
  return new Date(new Date(now.replace(" ", "T") + "Z").getTime() + ms).toISOString().slice(0, 19).replace("T", " ");
}
const toIso = (s: string) => `${s.replace(" ", "T")}Z`;
/** Minuit UTC suivant (les compteurs du jour sont datés en UTC). */
export function nextDayReset(now: string): string {
  const d = new Date(`${now.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().replace(".000", "");
}
/** 1er du mois suivant, minuit UTC. */
export function nextMonthReset(now: string): string {
  const d = new Date(`${now.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().replace(".000", "");
}

const EPS = 1e-9;
const INF = Number.POSITIVE_INFINITY;
/** Combien de jobs de coût `unit` tiennent dans `room` ; « premier du jour » : au moins un tant que rien n'est engagé. */
function fit(room: number, unit: number, nothingEngaged: boolean): number {
  if (unit <= 0) return room > 0 || nothingEngaged ? INF : 0;
  const n = Math.max(0, Math.floor(room / unit + EPS));
  return nothingEngaged ? Math.max(1, n) : n;
}

/** Une limite évaluée pour une spécification : combien de lancements elle laisse, et pourquoi elle bloque. */
type Evaluated = {
  key: LimitKey;
  /** Lancements possibles encore permis par cette limite (∞ : elle ne borne pas). */
  capacity: number;
  /** Limite passagère (débit, jobs en cours) : bloque sans réduire le compte du jour. */
  transient: boolean;
  status: number;
  resetAt: string | null;
  userError: (when: string | null) => UserError;
};

/**
 * Toutes les limites qui s'appliquent à `spec`, DANS L'ORDRE de la réservation
 * (rafale, quota du jour, places, solde, budget, calcul du jour, mois, stockage).
 * La première dont la capacité est < 1 est le refus ; le minimum des capacités
 * non passagères est « combien je peux encore en lancer ».
 */
export function evaluateLimits(s: LimitsState, spec: LaunchSpec): Evaluated[] {
  const out: Evaluated[] = [];
  const expected = expectedJobCostUsd(spec.bucket === "assist" ? "assist" : spec.kind, spec.costCenti);
  const cost = spec.costCenti;
  const day = nextDayReset(s.now);
  const month = nextMonthReset(s.now);

  if (!s.owner) {
    if (s.rate.cap !== null) {
      const cap = s.rate.cap;
      const reset = s.rate.oldestAt ? toIso(isoOffset(s.rate.oldestAt, 60_000)) : null;
      out.push({
        key: "rate", capacity: Math.max(0, cap - s.rate.used), transient: true, status: 429, resetAt: reset,
        userError: (when) => ({ code: "billing_rate_limit", params: { max: cap, when: when ?? translator(currentLocale())("limits.in_a_minute") } }),
      });
    }
    const q = s.quota[spec.bucket];
    if (q.cap !== null) {
      const { used, cap } = q;
      out.push({
        key: spec.bucket === "gen" ? "daily_generations" : "daily_assistance",
        capacity: Math.max(0, cap - used), transient: false, status: 429, resetAt: day,
        userError: (when) => ({ code: spec.bucket === "gen" ? "billing_daily_generation_quota" : "billing_daily_assistance_quota", params: { used, max: cap, when: when ?? "" } }),
      });
    }
    if (spec.jobSlot && s.slots.cap !== null) {
      const cap = s.slots.cap;
      out.push({
        key: "active_jobs", capacity: Math.max(0, cap - s.slots.used), transient: true, status: 429, resetAt: null,
        userError: () => ({ code: "billing_active_jobs_limit", params: { max: cap } }),
      });
    }
    if (s.billing && s.credits) {
      const c = s.credits;
      const refusal = insufficient(c.balanceCenti, cost, c.subCenti);
      out.push({
        key: "credits",
        capacity: cost > 0 ? Math.max(0, Math.floor(c.balanceCenti / cost + EPS)) : c.balanceCenti > 0 ? INF : 0,
        transient: false, status: 402, resetAt: c.rechargeAt ? `${c.rechargeAt}T00:00:00Z` : null,
        userError: () => refusal ?? insufficient(0, Math.max(cost, 1))!,
      });
      if (cost > 0 && s.budget) {
        const paidCount = Math.floor(c.paidCenti / cost + EPS);
        const fm = s.freeMonth;
        if (fm) {
          out.push({
            key: "free_capacity",
            capacity: paidCount + Math.max(0, Math.floor((fm.capUsd - fm.spentUsd - s.committedGlobalUsd) / expected + EPS)),
            transient: false, status: 402, resetAt: month,
            userError: (when) => ({ code: "billing_free_capacity_exhausted", params: { when: when ?? "" } }),
          });
        }
        const b = s.budget;
        out.push({
          key: "free_budget",
          capacity: paidCount + Math.max(0, Math.floor((b.budgetUsd - b.spentUsd - s.committedUserUsd) / expected + EPS)),
          transient: false, status: 402, resetAt: null,
          userError: () => ({ code: "billing_free_budget_exceeded", params: { balance: fromCenti(Math.max(0, c.paidCenti)), cost: fromCenti(cost) } }),
        });
      }
    }
    // Calcul du jour du compte : le plus serré du plafond lié au budget (facturation) et
    // du fusible par compte (fournisseur payant seulement, comme à chaque appel).
    {
      const caps = [s.paid ? s.userFuseUsd : null, s.budget && cost > 0 ? dailySpendCapUsd(s.budget.budgetUsd) : null].filter((x): x is number => x !== null);
      if (caps.length) {
        const cap = Math.min(...caps);
        const engaged = Math.max(s.userSpentTodayUsd, s.budget?.spentTodayUsd ?? 0) + s.committedUserUsd;
        out.push({
          key: "daily_compute",
          capacity: cap <= 0 ? 0 : fit(cap - engaged, expected, engaged <= EPS),
          transient: false, status: 429, resetAt: day,
          userError: (when) => ({ code: "billing_daily_compute_limit", params: { when: when ?? "" } }),
        });
      }
    }
  }
  if (s.paid && s.globalCapUsd !== null) {
    const cap = s.globalCapUsd;
    const engaged = s.globalSpentUsd + s.committedGlobalUsd;
    out.push({
      key: "monthly_capacity",
      capacity: cap <= 0 ? 0 : fit(cap - engaged, expected, engaged <= EPS),
      transient: false, status: 429, resetAt: month,
      userError: (when) => ({ code: "billing_monthly_capacity_limit", params: { when: when ?? "" } }),
    });
  }
  if (spec.bucket === "gen" && s.storage) {
    const { usedBytes, quotaBytes } = s.storage;
    const mb = (n: number) => Math.round(n / MiB);
    out.push({
      key: "storage", capacity: usedBytes > quotaBytes ? 0 : INF, transient: false, status: 413, resetAt: null,
      userError: () => ({ code: "storage_quota_reached", params: { usedMb: mb(usedBytes), quotaMb: mb(quotaBytes) } }),
    });
  }
  return out;
}

export type LaunchRefusal = Refusal & { key: LimitKey; resetAt: string | null };

function refusalOf(hit: Evaluated | undefined, now: string): LaunchRefusal | null {
  if (!hit) return null;
  const error = hit.userError(hit.resetAt ? formatReset(hit.resetAt, now) : null);
  const rejected = refusal(hit.status, error.code, error.params);
  return { ...rejected, key: hit.key, resetAt: hit.resetAt };
}

/** Verdict de lancement : null = permis ; sinon le premier refus, avec sa date de remise à zéro. */
export function launchVerdict(s: LimitsState, spec: LaunchSpec): LaunchRefusal | null {
  return refusalOf(evaluateLimits(s, spec).find((e) => e.capacity < 1), s.now);
}

/**
 * Le même verdict restreint à certaines limites — pour les gardes historiques
 * (quota seul, solde seul, plafonds de dépense seuls) : mêmes conditions, mêmes
 * messages, aucun second jeu de règles.
 */
export async function limitGate(spec: LaunchSpec, keys: readonly LimitKey[], userId = currentUser()): Promise<LaunchRefusal | null> {
  const s = await readLimitsState(userId);
  return refusalOf(evaluateLimits(s, spec).find((e) => keys.includes(e.key) && e.capacity < 1), s.now);
}

/** Pré-contrôle hors verrou, À APPELER AVANT de créer un job ou d'appeler le modèle (app, MCP). */
export async function launchGate(spec: LaunchSpec, userId = currentUser()): Promise<LaunchRefusal | null> {
  return launchVerdict(await readLimitsState(userId), spec);
}

/** Spécification standard d'un type lancé par l'étudiant. */
export function specForKind(kind: LaunchKind, costForJob: (type: string) => number): LaunchSpec {
  const k = LAUNCH_KINDS[kind];
  return k.jobType ? jobSpec(k.jobType, costForJob(k.jobType)) : assistSpec();
}

/** Ce qu'il reste à lancer pour une spécification : nombre (null = sans limite), limite qui borne, verdict d'aujourd'hui. */
export function kindUsage(s: LimitsState, spec: LaunchSpec, kind: string, label: string, plural: string): KindUsage {
  const ev = evaluateLimits(s, spec);
  const counting = ev.filter((e) => !e.transient);
  let limiting: Evaluated | null = null;
  for (const e of counting) if (Number.isFinite(e.capacity) && (!limiting || e.capacity < limiting.capacity)) limiting = e;
  const refusal = launchVerdict(s, spec);
  return {
    kind, label, plural,
    costCredits: s.billing && !s.owner ? fromCenti(spec.costCenti) : 0,
    remaining: limiting ? limiting.capacity : null,
    limitedBy: limiting?.key ?? null,
    resetAt: limiting?.resetAt ?? null,
    allowed: !refusal,
    reason: refusal?.error ?? null,
    blockedBy: refusal?.key ?? null,
    blockedUntil: refusal?.resetAt ?? null,
    status: refusal?.status ?? null,
  };
}

/**
 * LIMITES D'USAGE DU COMPTE — chaque limite qui peut bloquer l'étudiant (utilisé,
 * limite, restant, remise à zéro, unité) et, pour chaque type de génération,
 * combien il peut encore en lancer. `costForJob` : le tarif de lib/jobs (injecté
 * pour éviter le cycle jobs → billing).
 */
export async function getUsageLimits(userId = currentUser(), extra?: { spec: LaunchSpec; kind: string; label: string; plural: string }): Promise<UsageLimits> {
  const s = await readLimitsState(userId);
  const { costForJob } = await import("@/lib/jobs");
  const generations = {} as UsageLimits["generations"];
  for (const [kind, k] of Object.entries(LAUNCH_KINDS) as Array<[LaunchKind, (typeof LAUNCH_KINDS)[LaunchKind]]>) {
    generations[kind] = kindUsage(s, specForKind(kind, (t) => costForJob(t as never)), kind, k.label, k.plural);
  }
  return {
    now: toIso(s.now),
    owner: s.owner,
    billing: s.billing,
    limits: describeLimits(s),
    generations,
    check: extra ? kindUsage(s, extra.spec, extra.kind, extra.label, extra.plural) : null,
  };
}

/** Les limites elles-mêmes, pour l'affichage. Les plafonds en dollars deviennent des pourcentages. */
export function describeLimits(s: LimitsState): UsageLimit[] {
  const out: UsageLimit[] = [];
  // Libellés dans la langue du lecteur : page Mon usage (requête) et connecteur MCP (anglais).
  const t = translator(currentLocale());
  const label = (k: keyof Messages["limits"]["label"]) => t(`limits.label.${k}`);
  const unit = (k: keyof Messages["limits"]["unit"]) => t(`limits.unit.${k}`);
  const day = nextDayReset(s.now);
  const month = nextMonthReset(s.now);
  const pct = (used: number, cap: number) => (cap <= 0 ? 100 : Math.min(100, Math.round((100 * used) / cap)));
  if (s.billing && s.credits && !s.owner) {
    const bal = fromCenti(s.credits.balanceCenti);
    out.push({ key: "credits", label: label("credits"), used: null, limit: null, remaining: bal, unit: unit("credits"), resetAt: s.credits.rechargeAt ? `${s.credits.rechargeAt}T00:00:00Z` : null });
  }
  for (const bucket of ["gen", "assist"] as const) {
    const q = s.quota[bucket];
    if (q.cap === null) continue;
    out.push({
      key: bucket === "gen" ? "daily_generations" : "daily_assistance",
      label: label(bucket === "gen" ? "daily_generations" : "daily_assistance"),
      used: q.used, limit: q.cap, remaining: Math.max(0, q.cap - q.used),
      unit: unit(bucket === "gen" ? "generations" : "assistance"), resetAt: day,
    });
  }
  if (s.slots.cap !== null) {
    out.push({ key: "active_jobs", label: label("active_jobs"), used: s.slots.used, limit: s.slots.cap, remaining: Math.max(0, s.slots.cap - s.slots.used), unit: unit("concurrent"), resetAt: null });
  }
  if (s.rate.cap !== null) {
    out.push({
      key: "rate", label: label("rate"), used: s.rate.used, limit: s.rate.cap, remaining: Math.max(0, s.rate.cap - s.rate.used), unit: unit("per_minute"),
      resetAt: s.rate.oldestAt ? toIso(isoOffset(s.rate.oldestAt, 60_000)) : null,
    });
  }
  if (!s.owner) {
    const caps = [s.paid ? s.userFuseUsd : null, s.budget ? dailySpendCapUsd(s.budget.budgetUsd) : null].filter((x): x is number => x !== null);
    if (caps.length) {
      const cap = Math.min(...caps);
      const used = pct(Math.max(s.userSpentTodayUsd, s.budget?.spentTodayUsd ?? 0) + s.committedUserUsd, cap);
      out.push({ key: "daily_compute", label: label("daily_compute"), used, limit: 100, remaining: 100 - used, unit: "%", resetAt: day });
    }
  }
  if (s.paid && s.globalCapUsd !== null) {
    const used = pct(s.globalSpentUsd + s.committedGlobalUsd, s.globalCapUsd);
    out.push({ key: "monthly_capacity", label: label("monthly_capacity"), used, limit: 100, remaining: 100 - used, unit: "%", resetAt: month });
  }
  if (s.storage) {
    const used = Math.round(s.storage.usedBytes / MiB);
    const limit = Math.floor(s.storage.quotaBytes / MiB);
    out.push({ key: "storage", label: label("storage"), used, limit, remaining: Math.max(0, limit - used), unit: unit("mb"), resetAt: null });
  }
  return out;
}
