import { authAll, authGet } from "@/db/auth-store";
import { runWithCourse } from "@/db/client";
import { runWithUser } from "@/db/context";
import { dbDriverName, q } from "@/db/q";
import { DELTA_CENTI } from "@/lib/billing/credits";
import { GENERATION_DEBIT_SQL } from "@/lib/billing/usage";
import { claimOnce, releaseClaim, settleClaim } from "@/lib/claim-once";
import { ensureCoursesLoaded, listCourses } from "@/lib/courses";
import { JOB_TYPES } from "@/lib/jobs";
import { log } from "@/lib/metrics";
import type { EmailOutcome } from "@/lib/email";

/**
 * BILAN D'EXPLOITATION PAR E-MAIL (décision du 25/11/2026) : Ben est prévenu sans aller voir,
 * et sans consommer d'appel au modèle — tout ici est du SQL et de l'arithmétique.
 *
 * Chaque jour à OPS_DIGEST_HOUR (8 h, heure de Zurich), un passage regarde les dernières 24 h :
 * le mail ne part que si un seuil est franchi. Le lundi, il part toujours, avec le bilan des
 * 7 derniers jours. Une clé par jour dans app_meta (lib/claim-once) : deux process, ou une
 * relance dix minutes plus tard, n'envoient jamais deux fois ; un jour calme est clos aussi.
 *
 * Lecture seule, tous comptes confondus : le mail ne porte que des types de job, des codes
 * d'erreur et des chiffres — jamais d'e-mail, d'identifiant de compte ni de nom de cours.
 * Désactivé sans OPS_DIGEST_ENABLED=1 (invariant 6).
 */

export type OpsMail = { to: string; subject: string; text: string; html?: string; idempotencyKey?: string };
export type DigestStatus = "disabled" | "too_early" | "already_done" | "busy" | "no_recipient" | "quiet" | "sent" | "failed";
export type DigestResult = { status: DigestStatus; subject?: string; alerts?: string[]; reason?: string };

type Deps = {
  now?: Date;
  /** Envoi (lib/email sendEmail par défaut). */
  send?: (m: OpsMail) => Promise<EmailOutcome>;
  /** Envoi de test à la main : part tout de suite, bilan complet, sans clore le jour. */
  test?: boolean;
  /** N'envoie rien : rend le mail (scripts/ops-digest.ts --dry-run). */
  dryRun?: boolean;
};

// ── seuils (variables d'environnement, défauts documentés dans DEPLOY.md) ────────────────

function num(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function digestThresholds() {
  return {
    /** Heure de Zurich à partir de laquelle le passage du jour a lieu. */
    hour: Math.min(23, num("OPS_DIGEST_HOUR", 8)),
    /** Taux d'échec des générations (fraction) au-delà duquel on alerte… */
    failRate: num("OPS_ALERT_FAIL_RATE", 0.05),
    /** …sur au moins ce nombre de jobs terminés. */
    failMinJobs: num("OPS_ALERT_FAIL_MIN_JOBS", 5),
    /** Remboursements automatiques en 24 h à partir desquels on alerte. */
    refundsMin: num("OPS_ALERT_REFUNDS_MIN", 1),
    /** Job plus long que ce facteur × la médiane de son type (7 derniers jours)… */
    slowFactor: num("OPS_ALERT_SLOW_FACTOR", 2),
    /** …quand la médiane repose sur au moins ce nombre de jobs. */
    slowMinJobs: num("OPS_ALERT_SLOW_MIN_JOBS", 3),
    /** Coût du modèle d'un job au-delà de cette fraction de son plafond (crédits × JOB_SPEND_CAP_USD_PER_CREDIT). */
    costCapRatio: num("OPS_ALERT_COST_CAP_RATIO", 0.8),
    /** Job « running » sans mise à jour depuis ce nombre de minutes. */
    stuckMinutes: num("OPS_ALERT_STUCK_MIN", 60),
    /** Taille de la base Postgres en Mo au-delà de laquelle on alerte (0 = pas mesuré). */
    dbLimitMb: num("OPS_DB_LIMIT_MB", 0),
    /** Fraction de OPS_DB_LIMIT_MB qui déclenche l'alerte. */
    dbRatio: num("OPS_ALERT_DB_RATIO", 0.8),
  };
}

// ── heure de Zurich ──────────────────────────────────────────────────────────────────────

function zurich(d: Date): { day: string; hour: number; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" })
      .formatToParts(d).map((p) => [p.type, p.value]),
  );
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday) + 1;
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), weekday };
}

/** Semaine ISO 8601 d'un jour « AAAA-MM-JJ ». */
export function isoWeek(day: string): number {
  const d = new Date(`${day}T00:00:00Z`);
  // Le jeudi de la semaine donne l'année ISO ; la semaine 1 est celle du premier jeudi.
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

// ── lecture des données ─────────────────────────────────────────────────────────────────

/** Horodatage du store (« AAAA-MM-JJ HH:MM:SS », UTC). */
const stamp = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");
const parseStamp = (s: string | Date) => (s instanceof Date ? s.getTime() : Date.parse(`${String(s).replace(" ", "T")}Z`));

type JobRow = { owner: string; type: string; status: string; created: number; updated: number; alive: number; code: string | null; ref: string | null };
type RawJob = { type: string; status: string; created_at: string; updated_at: string; heartbeat_at: string | null; error_json: string | null; credit_ref: string | null };

const JOB_COLUMNS = `type, status, created_at, updated_at, heartbeat_at, error_json, credit_ref`;
/** États où un worker travaille (lib/jobs ACTIVE_STATES, la file en moins). */
const WORKING = new Set(["running", "verifying", "compiling"]);
/** Jobs qui génèrent pour l'étudiant (le taux d'échec ne compte qu'eux, pas ingestion ni préparation). */
const GENERATIONS = new Set(["exam", "exercise", "lab-exercise", "qcm", "drill", "check"]);

function errorCode(json: string | null): string | null {
  if (!json) return null;
  try {
    const c = (JSON.parse(json) as { code?: unknown }).code;
    return typeof c === "string" && /^[a-z0-9_]{1,48}$/.test(c) ? c : "invalid";
  } catch {
    return "invalid";
  }
}

/**
 * Jobs de tous les tenants terminés depuis `since`, et tous ceux encore actifs. Postgres : un
 * schéma par (compte, cours), nommé par public.tenants (lecture qualifiée, comme le rapport de
 * coût) ; SQLite : une base par cours.
 */
async function readJobs(since: Date): Promise<JobRow[]> {
  const where = `WHERE updated_at >= ? OR status IN ('queued', 'running', 'verifying', 'compiling')`;
  const out: JobRow[] = [];
  const push = (owner: string, rows: RawJob[]) => {
    for (const r of rows) {
      // Un type hors de la liste ne part pas tel quel dans le mail : la colonne est du texte.
      const updated = parseStamp(r.updated_at);
      // Dernier signe de vie : le battement du worker (toutes les 30 s), sinon la dernière étape.
      const alive = Math.max(updated, r.heartbeat_at ? parseStamp(r.heartbeat_at) : 0);
      out.push({ owner, type: (JOB_TYPES as readonly string[]).includes(r.type) ? r.type : "autre", status: r.status, created: parseStamp(r.created_at), updated, alive, code: errorCode(r.error_json), ref: r.credit_ref });
    }
  };
  if (dbDriverName() === "postgres") {
    const tenants = await authAll<{ user_id: string; schema_name: string }>(`SELECT user_id, schema_name FROM public.tenants`);
    let skipped = 0;
    for (const t of tenants) {
      if (!/^[a-z0-9_]+$/.test(t.schema_name)) continue;
      try {
        // Exception à l'invariant 4 (search_path), comme le rapport de coût et l'export de compte :
        // lecture seule d'un schéma nommé par public.tenants et filtré ci-dessus, sans passer par le
        // store (qui amorcerait le tenant, donc écrirait).
        push(t.user_id, await authAll<RawJob>(`SELECT ${JOB_COLUMNS} FROM "${t.schema_name}".jobs ${where}`, stamp(since)));
      } catch {
        // Sans table jobs, ou jamais rouvert depuis l'ajout d'une colonne : compté, pour qu'un sous-comptage se voie.
        skipped++;
      }
    }
    if (skipped) log("warn", "ops_digest.tenants_skipped", { skipped, total: tenants.length });
    return out;
  }
  await ensureCoursesLoaded();
  for (const c of listCourses()) {
    try {
      push(c.ownerUserId, await runWithUser(c.ownerUserId, () => runWithCourse(c.id, () => q.all<RawJob>(`SELECT ${JOB_COLUMNS} FROM jobs ${where}`, stamp(since)))));
    } catch { /* cours sans base ou sans table jobs */ }
  }
  return out;
}

type Ledger = {
  /** Débit (centièmes) de chaque réservation, avant remboursement. */
  billed: Map<string, number>;
  /** Remboursé (centièmes) par réservation. */
  refunded: Map<string, number>;
  /** Remboursements de la fenêtre : compte et montant. */
  refunds: Array<{ user: string; centi: number; at: number }>;
};

async function readLedger(since: Date): Promise<Ledger> {
  const billed = new Map<string, number>();
  const refunded = new Map<string, number>();
  const refunds: Ledger["refunds"] = [];
  const byMarker = new Map<string, Ledger["refunds"][number]>();
  try {
    for (const r of await authAll<{ ref: string; delta: number | string; sub_amount: number | string | null }>(
      `SELECT ref, ${DELTA_CENTI} AS delta, sub_amount FROM credit_transactions WHERE ${GENERATION_DEBIT_SQL} AND created_at >= ?`, stamp(new Date(since.getTime() - 86_400_000)),
    )) {
      billed.set(r.ref, Math.max(0, -Number(r.delta)) + Math.max(0, Number(r.sub_amount ?? 0)));
    }
    for (const r of await authAll<{ user_id: string; ref: string; delta: number | string; created_at: string }>(
      `SELECT user_id, ref, ${DELTA_CENTI} AS delta, created_at FROM credit_transactions WHERE (ref LIKE 'refund:%' OR ref LIKE 'offered:refund:%') AND created_at >= ? ORDER BY id`, stamp(since),
    )) {
      const marker = r.ref.startsWith("offered:") ? r.ref.slice("offered:".length) : r.ref;
      const target = marker.slice("refund:".length).replace(/:(?:[a-z_]+)$/, "");
      const centi = Math.max(0, Number(r.delta));
      refunded.set(target, (refunded.get(target) ?? 0) + centi);
      // La part d'abonnement (offered:refund:…) accompagne SON marqueur : un seul remboursement compté.
      const one = byMarker.get(marker) ?? { user: r.user_id, centi: 0, at: parseStamp(r.created_at) };
      one.centi += centi;
      if (!byMarker.has(marker)) { byMarker.set(marker, one); refunds.push(one); }
    }
  } catch { /* registre absent (facturation jamais activée) */ }
  return { billed, refunded, refunds };
}

/** Coût du modèle ($) par réservation, sur la fenêtre (appels en vol compris à leur estimation). */
async function readCosts(since: Date): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    for (const r of await authAll<{ credit_ref: string; cost: number | string }>(
      `SELECT credit_ref, SUM(cost_usd) AS cost FROM llm_usage WHERE credit_ref IS NOT NULL AND created_at >= ? GROUP BY credit_ref`, stamp(new Date(since.getTime() - 86_400_000)),
    )) out.set(r.credit_ref, Number(r.cost) || 0);
  } catch { /* table absente */ }
  return out;
}

/** Espace libre du volume (fraction), ou null hors mesure. */
async function volumeFree(): Promise<number | null> {
  const { volumeSpace } = await import("@/lib/storage-quota");
  const v = volumeSpace();
  return v ? v.free / v.total : null;
}

/** Taille de la base Postgres (Mo), ou null en SQLite. */
async function databaseMb(): Promise<number | null> {
  if (dbDriverName() !== "postgres") return null;
  try {
    const r = await authGet<{ n: number | string }>(`SELECT pg_database_size(current_database()) AS n`);
    return r ? Number(r.n) / (1024 * 1024) : null;
  } catch {
    return null;
  }
}

// ── calculs ──────────────────────────────────────────────────────────────────────────────

const TERMINAL = new Set(["done", "error"]);
const minutes = (j: JobRow) => Math.max(0, (j.updated - j.created) / 60_000);

function quantile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  // Rang le plus proche : une valeur observée, jamais une interpolation.
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const usd = (x: number) => `${x < 0 ? "−" : ""}${Math.abs(x).toFixed(2).replace(".", ",")} $`;
const pct = (x: number) => `${Math.round(x * 100)} %`;
const credits = (centi: number) => {
  const c = centi / 100;
  return `${Number.isInteger(c) ? c : c.toFixed(1).replace(".", ",")} crédit${Math.abs(c) >= 2 ? "s" : ""}`;
};
const plural = (n: number, one: string, many: string) => `${n} ${n >= 2 ? many : one}`;
const mins = (x: number) => `${Math.round(x)} min`;

type Facts = {
  jobs: JobRow[];
  ledger: Ledger;
  costs: Map<string, number>;
  netPerCredit: number;
  capPerCredit: number | null;
};

/** Alertes des dernières 24 h : une ligne de texte par seuil franchi. */
async function dailyAlerts(f: Facts, now: Date): Promise<string[]> {
  const t = digestThresholds();
  const since = now.getTime() - 86_400_000;
  const alerts: string[] = [];
  const recent = f.jobs.filter((j) => TERMINAL.has(j.status) && j.updated >= since);

  const gens = recent.filter((j) => GENERATIONS.has(j.type));
  const failed = gens.filter((j) => j.status === "error");
  if (gens.length >= t.failMinJobs && gens.length > 0 && failed.length / gens.length > t.failRate) {
    const codes = new Map<string, number>();
    for (const j of failed) codes.set(j.code ?? "inconnu", (codes.get(j.code ?? "inconnu") ?? 0) + 1);
    const top = [...codes].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c, n]) => `${c} × ${n}`).join(", ");
    alerts.push(`Taux d'échec : ${plural(failed.length, "échec", "échecs")} sur ${gens.length} jobs (${pct(failed.length / gens.length)}) — codes : ${top}.`);
  }

  const refunds = f.ledger.refunds.filter((r) => r.at >= since);
  if (t.refundsMin > 0 && refunds.length >= t.refundsMin) {
    const total = refunds.reduce((s, r) => s + r.centi, 0);
    alerts.push(`Remboursements : ${plural(refunds.length, "remboursement automatique", "remboursements automatiques")} (${credits(total)}).`);
  }

  // Médiane de chaque type sur les 7 jours lus : un seul job lent ne la déplace pas.
  const byType = new Map<string, number[]>();
  for (const j of f.jobs) if (TERMINAL.has(j.status)) byType.set(j.type, [...(byType.get(j.type) ?? []), minutes(j)]);
  for (const [type, ds] of byType) {
    if (ds.length < t.slowMinJobs) continue;
    const m = median(ds);
    const slow = recent.filter((j) => j.type === type && m > 0 && minutes(j) > t.slowFactor * m);
    if (slow.length) {
      const worst = Math.max(...slow.map(minutes));
      alerts.push(`Durée : ${type} : ${plural(slow.length, "job", "jobs")} de ${mins(worst)}${slow.length > 1 ? " au plus" : ""}, médiane ${mins(m)}.`);
    }
  }

  if (f.capPerCredit !== null) {
    const over: Array<{ type: string; cost: number; cap: number }> = [];
    for (const j of recent) {
      const billed = j.ref ? f.ledger.billed.get(j.ref) ?? 0 : 0;
      const cost = j.ref ? f.costs.get(j.ref) ?? 0 : 0;
      if (billed <= 0) continue;
      const cap = (billed / 100) * f.capPerCredit;
      if (cost > t.costCapRatio * cap) over.push({ type: j.type, cost, cap });
    }
    // Les trois pires seulement : un mauvais jour ne fait pas un mail de cent lignes.
    over.sort((a, b) => b.cost / b.cap - a.cost / a.cap);
    for (const o of over.slice(0, 3)) alerts.push(`Coût : ${o.type} : ${usd(o.cost)} pour un plafond de ${usd(o.cap)} (${pct(o.cost / o.cap)}).`);
    if (over.length > 3) alerts.push(`Coût : ${over.length - 3} autres jobs au-delà de ${pct(t.costCapRatio)} de leur plafond.`);
  }

  const stuck = f.jobs.filter((j) => WORKING.has(j.status) && now.getTime() - j.alive > t.stuckMinutes * 60_000);
  if (stuck.length) {
    const types = [...new Set(stuck.map((j) => j.type))].join(", ");
    alerts.push(`Bloqués : ${plural(stuck.length, "job", "jobs")} sans avancer depuis plus de ${t.stuckMinutes} min (${types}).`);
  }

  const free = await volumeFree();
  const { storageMinFreeRatio } = await import("@/lib/storage-quota");
  // Même seuil que l'alerte Sentry du volume (lib/storage-quota) : le double de la marge des envois.
  if (free !== null && free < 2 * storageMinFreeRatio()) alerts.push(`Volume : ${pct(free)} libres (envois refusés sous ${pct(storageMinFreeRatio())}).`);

  const db = await databaseMb();
  if (db !== null && t.dbLimitMb > 0 && db > t.dbRatio * t.dbLimitMb) alerts.push(`Base : ${Math.round(db)} Mo sur ${t.dbLimitMb} Mo (${pct(db / t.dbLimitMb)}).`);

  return alerts;
}

type TypeStats = {
  type: string; jobs: number; delivered: number; failed: number;
  /** Par job, dans le même ordre : coût du modèle ($), facturé net de remboursements (centièmes), débit initial (centièmes). */
  costs: number[]; netCenti: number[]; debitCenti: number[]; durations: number[];
  /** Au moins un job débité : sinon (propriétaire, facturation coupée), pas de marge. */
  billed: boolean;
};

function weeklyStats(f: Facts, since: number): { types: TypeStats[]; touched: number; refunds: number; refundedCenti: number } {
  const byType = new Map<string, TypeStats>();
  const touched = new Set<string>();
  for (const j of f.jobs) {
    if (!TERMINAL.has(j.status) || j.updated < since) continue;
    const s = byType.get(j.type) ?? { type: j.type, jobs: 0, delivered: 0, failed: 0, costs: [], netCenti: [], debitCenti: [], durations: [], billed: false };
    s.jobs++;
    if (j.status === "done") s.delivered++;
    else { s.failed++; touched.add(j.owner); }
    s.durations.push(minutes(j));
    // Un job échoué est remboursé mais payé au fournisseur : il compte, à 0 facturé, dans la marge.
    const debit = j.ref ? f.ledger.billed.get(j.ref) ?? 0 : 0;
    s.costs.push(j.ref ? f.costs.get(j.ref) ?? 0 : 0);
    s.debitCenti.push(debit);
    s.netCenti.push(Math.max(0, debit - (j.ref ? f.ledger.refunded.get(j.ref) ?? 0 : 0)));
    if (debit > 0) s.billed = true;
    byType.set(j.type, s);
  }
  const refunds = f.ledger.refunds.filter((r) => r.at >= since);
  for (const r of refunds) touched.add(r.user);
  return {
    types: [...byType.values()].sort((a, b) => b.jobs - a.jobs || a.type.localeCompare(b.type)),
    touched: touched.size,
    refunds: refunds.length,
    refundedCenti: refunds.reduce((s, r) => s + r.centi, 0),
  };
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
/** Facturé moyen par job ($), au revenu net d'un crédit. */
const billedUsd = (s: TypeStats, f: Facts) => (avg(s.netCenti) / 100) * f.netPerCredit;

/** Pistes d'optimisation, par règles fixes (aucun modèle). */
function hints(types: TypeStats[], f: Facts): string[] {
  const t = digestThresholds();
  const out: string[] = [];
  for (const s of types) {
    if (s.billed && avg(s.costs) > billedUsd(s, f)) {
      out.push(`${s.type} : coût moyen ${usd(avg(s.costs))} pour ${credits(avg(s.netCenti))} ≈ ${usd(billedUsd(s, f))} facturé, marge négative.`);
    }
    if (s.jobs >= t.failMinJobs && s.failed / s.jobs > t.failRate) out.push(`${s.type} : ${pct(s.failed / s.jobs)} d'échecs sur la semaine, voir les codes dans Sentry.`);
    // Coût rapporté au plafond de CHAQUE job débité (crédits × JOB_SPEND_CAP_USD_PER_CREDIT).
    const ratios = f.capPerCredit === null ? [] : s.debitCenti.flatMap((d, k) => (d > 0 ? [s.costs[k] / ((d / 100) * f.capPerCredit!)] : []));
    if (ratios.length && quantile(ratios, 0.95) > t.costCapRatio) out.push(`${s.type} : p95 du coût à ${pct(quantile(ratios, 0.95))} du plafond par job, des jobs risquent d'être coupés.`);
    if (s.durations.length >= t.slowMinJobs && quantile(s.durations, 0.95) > t.slowFactor * median(s.durations)) {
      out.push(`${s.type} : p95 de la durée ${mins(quantile(s.durations, 0.95))} pour une médiane de ${mins(median(s.durations))}, à regarder.`);
    }
  }
  return out;
}

// ── mise en forme ────────────────────────────────────────────────────────────────────────

/** « 16/11 08:30 → 23/11 08:30 », heure de Zurich. */
function period(from: number, to: number): string {
  const f = (t: number) => new Intl.DateTimeFormat("fr-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(t)).replace(",", "");
  return `${f(from)} → ${f(to)}`;
}

const pad = (s: string, n: number) => s + " ".repeat(Math.max(2, n - s.length));

function weeklyText(w: ReturnType<typeof weeklyStats>, f: Facts): { text: string; rows: string[][][] } {
  if (!w.types.length) return { text: "Aucun job cette semaine.", rows: [] };
  const width = Math.max(6, ...w.types.map((s) => s.type.length + 2));
  const volume = w.types.map((s) => [s.type, plural(s.jobs, "job", "jobs"), plural(s.delivered, "livré", "livrés"), plural(s.failed, "échec", "échecs")]);
  const cost = w.types.map((s) => {
    const margin = s.billed ? billedUsd(s, f) - avg(s.costs) : null;
    return [s.type, `${usd(avg(s.costs))} moy.`, `${usd(quantile(s.costs, 0.95))} p95`, `${usd(Math.max(...s.costs))} max`,
      s.billed ? `${usd(billedUsd(s, f))} facturé` : "non facturé", margin === null ? "" : `${usd(margin)} marge`];
  });
  const duration = w.types.map((s) => [s.type, `médiane ${mins(median(s.durations))}`, `p95 ${mins(quantile(s.durations, 0.95))}`]);
  const table = (rows: string[][]) => rows.map((r) => r.map((c, i) => (i === 0 ? pad(c, width) : pad(c, 16))).join("").trimEnd()).join("\n");
  const text = [
    "Volumes",
    table(volume),
    "",
    `Coût du modèle par job, face au facturé (${usd(f.netPerCredit)} net par crédit)`,
    table(cost),
    "",
    "Durées",
    table(duration),
    "",
    `Remboursements : ${w.refunds} (${credits(w.refundedCenti)})`,
    `Étudiants touchés par une erreur : ${w.touched}`,
  ].join("\n");
  return { text, rows: [volume, cost, duration] };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function html(title: string, alerts: string[], rows: string[][][], tail: string[], links: string): string {
  const table = (r: string[][]) => `<table style="border-collapse:collapse;font:13px ui-monospace,monospace;margin:8px 0">${r.map((row) => `<tr>${row.map((c) => `<td style="padding:2px 12px 2px 0">${esc(c)}</td>`).join("")}</tr>`).join("")}</table>`;
  return [
    `<div style="font:14px -apple-system,system-ui,sans-serif;color:#111">`,
    `<h2 style="font-size:16px">${esc(title)}</h2>`,
    alerts.length ? `<ul>${alerts.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : "",
    ...rows.map(table),
    ...tail.map((l) => `<p>${esc(l)}</p>`),
    `<p>${links}</p>`,
    `</div>`,
  ].join("\n");
}

function links(): { text: string; html: string } {
  const sentry = process.env.OPS_SENTRY_URL?.trim() || "https://sentry.io/issues/";
  const railway = process.env.OPS_RAILWAY_URL?.trim() || "https://railway.com/dashboard";
  return {
    text: `Sentry : ${sentry}\nRailway : ${railway}`,
    html: `<a href="${esc(sentry)}">Sentry</a> · <a href="${esc(railway)}">Railway</a>`,
  };
}

/** Destinataire : OPS_DIGEST_TO, sinon l'adresse des alertes du propriétaire. */
async function recipient(): Promise<string | null> {
  const to = process.env.OPS_DIGEST_TO?.trim();
  if (to) return to;
  const { ownerAlertRecipient } = await import("@/lib/billing/owner-alert");
  return ownerAlertRecipient();
}

// ── passage ──────────────────────────────────────────────────────────────────────────────

/** Calcule le bilan (sans rien écrire) et l'envoie si c'est dû. Ne lève jamais. */
export async function runOpsDigest(deps: Deps = {}): Promise<DigestResult> {
  const now = deps.now ?? new Date();
  const manual = !!deps.test || !!deps.dryRun;
  if (!manual && process.env.OPS_DIGEST_ENABLED !== "1") return { status: "disabled" };
  const z = zurich(now);
  if (!manual && z.hour < digestThresholds().hour) return { status: "too_early" };
  const to = await recipient();
  if (!to) return { status: "no_recipient" };

  const key = `ops_digest:${z.day}`;
  let token: string | null = null;
  let chain: string | null = null;
  let mailed = false;
  if (!manual) {
    const claim = await claimOnce(key);
    if (claim.state === "sent") return { status: "already_done" };
    if (claim.state === "busy") return { status: "busy" };
    token = claim.token;
    chain = claim.chain;
  }
  try {
    const weekStart = now.getTime() - 7 * 86_400_000;
    const { creditNetUsd } = await import("@/lib/billing/cost-report");
    const { spendCapUsdPerCredit } = await import("@/lib/billing/usage");
    const facts: Facts = {
      jobs: await readJobs(new Date(weekStart)),
      ledger: await readLedger(new Date(weekStart)),
      costs: await readCosts(new Date(weekStart)),
      netPerCredit: creditNetUsd(),
      capPerCredit: spendCapUsdPerCredit(),
    };
    const alerts = await dailyAlerts(facts, now);
    const monday = z.weekday === 1;
    if (!alerts.length && !monday && !manual) {
      await settleClaim(key, token!, "sent quiet");
      return { status: "quiet", alerts };
    }

    const n = plural(alerts.length, "alerte", "alertes");
    const weekly = monday || manual;
    // La semaine couverte est celle qui vient de finir (les 7 jours avant ce lundi).
    const week = isoWeek(zurich(new Date(now.getTime() - 86_400_000)).day);
    const base = weekly ? `Cortex — bilan semaine ${week}${alerts.length ? ` · ${n}` : ""}` : `Cortex — ${n}`;
    const subject = `${deps.test ? "[test] " : ""}${base}`;
    const w = weekly ? weeklyStats(facts, weekStart) : null;
    const body = w ? weeklyText(w, facts) : null;
    const ideas = w ? hints(w.types, facts) : [];
    const l = links();
    const text = [
      alerts.length ? `Alertes (dernières 24 h) :\n${alerts.map((a) => `- ${a}`).join("\n")}` : "Aucune alerte sur les dernières 24 h.",
      ...(body ? ["", `Bilan des 7 derniers jours (${period(weekStart, now.getTime())})`, "", body.text] : []),
      ...(w ? ["", "Pistes d'optimisation :", ...(ideas.length ? ideas.map((h) => `- ${h}`) : ["- Rien à signaler."])] : []),
      "",
      l.text,
      "",
      "Calculé par Cortex en SQL, sans appel au modèle. Seuils : variables OPS_ALERT_* (DEPLOY.md).",
    ].join("\n");
    const mail: OpsMail = {
      to, subject, text,
      html: html(base, alerts, body?.rows ?? [], w ? [`Remboursements : ${w.refunds}`, `Étudiants touchés par une erreur : ${w.touched}`, ...ideas] : [], l.html),
      // La chaîne, pas le jeton : une reprise après un envoi incertain garde la même clé chez Resend.
      idempotencyKey: chain ? `${key}:${chain}` : undefined,
    };
    if (deps.dryRun) return { status: "sent", subject, alerts, reason: text };
    const send = deps.send ?? (await import("@/lib/email")).sendEmail;
    const out = await send(mail);
    if (!out.ok) {
      // Incertain (peut-être parti) : la réclamation reste, reprise dans un quart d'heure avec la
      // même clé d'idempotence, sans doublon. Refus durable (4xx hors 429 : clé, domaine) : le jour
      // est clos, réessayer toutes les dix minutes n'y changerait rien. Sinon la clé est rendue.
      const lasting = !out.uncertain && out.status !== undefined && out.status >= 400 && out.status < 500 && out.status !== 429;
      if (token && lasting) await settleClaim(key, token, `sent refused ${out.status}`);
      else if (token && !out.uncertain) await releaseClaim(key, token);
      log("error", "ops_digest.send_failed", { reason: out.reason.slice(0, 200), uncertain: !!out.uncertain, status: out.status });
      return { status: "failed", subject, alerts, reason: out.reason };
    }
    mailed = true;
    if (token) await settleClaim(key, token, `sent ${new Date().toISOString()}`);
    return { status: "sent", subject, alerts };
  } catch (e) {
    // Rien n'est parti : la clé est rendue, le passage suivant réessaie. Parti, mais la clé n'a pas
    // pu être close : elle reste réclamée, la reprise garde la chaîne (Resend dédoublonne).
    if (token && !mailed) await releaseClaim(key, token).catch(() => {});
    log("error", "ops_digest.failed", { message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    return { status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
}

const TICK_MS = 10 * 60_000;

/** Passage toutes les 10 minutes ; seul celui de 8 h (Zurich) fait quelque chose, une fois par jour. */
export function startOpsDigestScheduler(): NodeJS.Timeout | null {
  const g = globalThis as { __cortexOpsDigestTimer?: NodeJS.Timeout };
  if (g.__cortexOpsDigestTimer) clearInterval(g.__cortexOpsDigestTimer);
  if (process.env.OPS_DIGEST_ENABLED !== "1") return null;
  const tick = () => void runOpsDigest().then((r) => {
    if (r.status === "sent" || r.status === "failed" || r.status === "no_recipient") log(r.status === "sent" ? "info" : "error", `ops_digest.${r.status}`, { subject: r.subject });
  });
  // Premier passage différé : laisser la base et les jobs démarrer.
  setTimeout(tick, 90_000).unref?.();
  g.__cortexOpsDigestTimer = setInterval(tick, TICK_MS);
  g.__cortexOpsDigestTimer.unref?.();
  console.log("[ops-digest] bilan d'exploitation actif (passage quotidien à 8 h, heure de Zurich)");
  return g.__cortexOpsDigestTimer;
}
