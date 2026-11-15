import { authAll } from "@/db/auth-store";
import { creditCost, fromCenti } from "./credits";
import type { ReportReader } from "./report-source";

/**
 * RAPPORT DE COÛT — ce que les générations coûtent VRAIMENT (llm_usage), par
 * type de job et par appel d'assistance, face au prix facturé en crédits.
 * Sert à fixer les prix sur des mesures plutôt qu'à l'estime :
 *   npm run cost:report                       (store local)
 *   DATABASE_URL=<Postgres> npm run cost:report   (lecture seule, cf. report-source)
 *
 * Un job = (compte, cours, id) — les ids sont séquentiels par tenant. Son type
 * est le préfixe de call_site (`exam:generateBatch` → exam), posé par lib/llm
 * depuis le job courant du worker. Sur Postgres, le statut de chaque job est lu
 * dans la table `jobs` de son tenant : un job ÉCHOUÉ est remboursé à
 * l'étudiant mais payé au fournisseur, donc le prix d'un job doit couvrir le
 * coût de tous les jobs du type, divisé par les seuls jobs LIVRÉS.
 *
 * Prix minimal en crédits = coût par job livré ÷ revenu net d'un crédit
 * (CREDIT_NET_USD, défaut : le canal le moins rémunérateur, Pro annuel), au
 * seuil de rentabilité et avec la marge sûre du budget IA (AI_BUDGET_MARGIN).
 */

export type JobTypeCost = {
  type: string;
  /** Jobs comptés (en cours exclus). */
  jobs: number;
  delivered: number | null;
  failed: number | null;
  calls: number;
  estimatedCalls: number;
  totalUsd: number;
  avgUsd: number;
  medianUsd: number;
  maxUsd: number;
  /** Coût total du type ÷ jobs livrés (la moyenne quand les statuts sont inconnus). */
  perDeliveredUsd: number;
  priceCredits: number;
  minCreditsBreakEven: number;
  minCreditsSafe: number;
};

export type AssistCost = {
  callSite: string;
  calls: number;
  estimatedCalls: number;
  avgUsd: number;
  maxUsd: number;
  priceCredits: number;
  minCreditsBreakEven: number;
  minCreditsSafe: number;
};

export type CostReport = {
  source: string;
  rows: number;
  totalUsd: number;
  first: string | null;
  last: string | null;
  jobs: JobTypeCost[];
  assist: AssistCost[];
  netUsdPerCredit: number;
  margin: number;
  text: string;
};

const r2 = (x: number) => Math.round(x * 100) / 100;
/** Arrondi au dixième de crédit SUPÉRIEUR : un prix minimal ne s'arrondit jamais vers la perte. */
const up1 = (x: number) => Math.ceil(Math.round(x * 1e6) / 1e5) / 10;

/** Revenu net d'un crédit (USD) : CREDIT_NET_USD, défaut 0,47 $ (Pro annuel : 119 € pour 240 crédits, frais Stripe estimés). */
export function creditNetUsd(env: Partial<NodeJS.ProcessEnv> = process.env): number {
  const n = Number(env.CREDIT_NET_USD);
  return Number.isFinite(n) && n > 0 ? n : 0.47;
}

/** Marge du prix conseillé : AI_BUDGET_MARGIN bornée à 1 comme le budget ; levée ou invalide → 0,6 (un prix se conseille toujours). */
function safeMargin(env: Partial<NodeJS.ProcessEnv> = process.env): number {
  const n = Number(env.AI_BUDGET_MARGIN);
  return Number.isFinite(n) && n > 0 ? Math.min(1, n) : 0.6;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Site d'appel lisible : `assist:drill` → drill ; un nom de fonction minifié par le bundle Next → « ? (nom illisible) ». */
function siteLabel(site: string | null): string {
  if (!site) return "?";
  if (site.startsWith("assist:")) return site.slice("assist:".length);
  if (/\._\.js$|^lib_[a-z0-9_]+/i.test(site)) return "? (nom illisible)";
  return site;
}

type UsageRow = { user_id: string; course: string; job_id: string | null; call_site: string | null; calls: number; est: number; cost: number };

/** Statut de chaque job (`user|course|id` → statut), lu dans le tenant (Postgres seulement). */
async function jobStatuses(reader: ReportReader, pairs: Set<string>): Promise<Map<string, string> | null> {
  if (reader.dialect !== "postgres") return null;
  const out = new Map<string, string>();
  let tenants: Array<{ user_id: string; course: string; schema_name: string }>;
  try {
    tenants = await reader.all(`SELECT user_id, course, schema_name FROM public.tenants`);
  } catch {
    return null;
  }
  for (const t of tenants) {
    if (!pairs.has(`${t.user_id}|${t.course}`) || !/^[a-z0-9_]+$/.test(t.schema_name)) continue;
    try {
      // Exception à l'invariant 4 (search_path), comme l'export de compte : lecture seule d'un
      // schéma nommé par public.tenants et filtré ci-dessus, sans passer par le store.
      const rows = await reader.all<{ id: number | string; status: string }>(`SELECT id, status FROM "${t.schema_name}".jobs`);
      for (const r of rows) out.set(`${t.user_id}|${t.course}|${r.id}`, r.status);
    } catch { /* tenant sans table jobs */ }
  }
  return out;
}

const storeReader: ReportReader = { dialect: "sqlite", label: "store global", all: (s, ...p) => authAll(s, ...p), close: async () => {} };

/** `since` (« AAAA-MM-JJ ») : seulement les appels à partir de ce jour (UTC) — pour mesurer le moteur actuel. */
export async function costReport(
  reader: ReportReader = storeReader,
  env: Partial<NodeJS.ProcessEnv> = process.env,
  opts: { since?: string } = {},
): Promise<CostReport> {
  const since = opts.since && /^\d{4}-\d{2}-\d{2}$/.test(opts.since) ? opts.since : null;
  const where = since ? `WHERE created_at >= ?` : "";
  const and = since ? `AND created_at >= ?` : "";
  const p = since ? [since] : [];
  const netUsdPerCredit = creditNetUsd(env);
  const margin = safeMargin(env);
  const minCredits = (usd: number) => ({
    minCreditsBreakEven: up1(usd / netUsdPerCredit),
    minCreditsSafe: up1(usd / (margin * netUsdPerCredit)),
  });

  const totals = (await reader.all<{ n: number; total: number | null; first: string | null; last: string | null }>(
    `SELECT count(*) n, sum(cost_usd) total, min(created_at) first, max(created_at) last FROM llm_usage ${where}`, ...p,
  ))[0];
  // Requête portable (ni instr ni split_part) : le type se déduit en JS.
  const usage = await reader.all<UsageRow>(
    `SELECT user_id, course, job_id, call_site, count(*) calls, sum(estimated) est, sum(cost_usd) cost
     FROM llm_usage ${where} GROUP BY user_id, course, job_id, call_site`, ...p,
  );

  const perJob = new Map<string, { type: string; user: string; course: string; id: string; calls: number; est: number; cost: number }>();
  const inline = new Map<string, { calls: number; est: number; total: number; max: number }>();
  for (const u of usage) {
    const site = u.call_site ?? "";
    if (u.job_id != null && site.includes(":")) {
      const type = site.slice(0, site.indexOf(":"));
      const key = `${u.user_id}|${u.course}|${u.job_id}|${type}`;
      const j = perJob.get(key) ?? { type, user: u.user_id, course: u.course, id: String(u.job_id), calls: 0, est: 0, cost: 0 };
      j.calls += Number(u.calls); j.est += Number(u.est); j.cost += Number(u.cost);
      perJob.set(key, j);
    } else if (u.job_id == null) {
      // Une ligne groupée porte plusieurs appels : son max est la moyenne du groupe (borne basse, assumée).
      const label = siteLabel(u.call_site);
      const a = inline.get(label) ?? { calls: 0, est: 0, total: 0, max: 0 };
      a.calls += Number(u.calls); a.est += Number(u.est); a.total += Number(u.cost);
      a.max = Math.max(a.max, Number(u.cost) / Math.max(1, Number(u.calls)));
      inline.set(label, a);
    }
  }
  // Le max d'un drill se lit appel par appel, pas par groupe.
  const maxRows = await reader.all<{ call_site: string | null; max: number }>(
    `SELECT call_site, max(cost_usd) max FROM llm_usage WHERE job_id IS NULL ${and} GROUP BY call_site`, ...p,
  );
  for (const m of maxRows) {
    const a = inline.get(siteLabel(m.call_site));
    if (a) a.max = Math.max(a.max, Number(m.max));
  }

  const statuses = await jobStatuses(reader, new Set([...perJob.values()].map((j) => `${j.user}|${j.course}`)));
  const byType = new Map<string, { costs: number[]; calls: number; est: number; delivered: number; failed: number }>();
  for (const j of perJob.values()) {
    const status = statuses?.get(`${j.user}|${j.course}|${j.id}`);
    if (status && !["done", "error", "canceled"].includes(status)) continue; // en cours : coût pas encore final
    const t = byType.get(j.type) ?? { costs: [], calls: 0, est: 0, delivered: 0, failed: 0 };
    t.costs.push(j.cost); t.calls += j.calls; t.est += j.est;
    if (status === "done") t.delivered++;
    else if (status) t.failed++;
    byType.set(j.type, t);
  }
  const jobs: JobTypeCost[] = [...byType.entries()].map(([type, t]) => {
    const total = t.costs.reduce((s, c) => s + c, 0);
    const avg = total / t.costs.length;
    const perDelivered = statuses ? (t.delivered ? total / t.delivered : total) : avg;
    return {
      type, jobs: t.costs.length,
      delivered: statuses ? t.delivered : null, failed: statuses ? t.failed : null,
      calls: t.calls, estimatedCalls: t.est,
      totalUsd: r2(total), avgUsd: r2(avg), medianUsd: r2(median(t.costs)), maxUsd: r2(Math.max(...t.costs)),
      perDeliveredUsd: r2(perDelivered), priceCredits: fromCenti(creditCost(type)), ...minCredits(perDelivered),
    };
  }).sort((a, b) => b.totalUsd - a.totalUsd);

  const assistPrice = fromCenti(creditCost("assist"));
  const assist: AssistCost[] = [...inline.entries()].map(([callSite, a]) => {
    const avg = a.total / a.calls;
    return {
      callSite, calls: a.calls, estimatedCalls: a.est, avgUsd: r2(avg), maxUsd: r2(a.max),
      priceCredits: assistPrice, ...minCredits(avg),
    };
  }).sort((a, b) => b.calls - a.calls);

  const rows = Number(totals?.n ?? 0);
  const totalUsd = r2(Number(totals?.total ?? 0));
  const lines: string[] = [];
  lines.push(`Source : ${reader.label}${since ? `, depuis le ${since}` : ""} — ${rows} appels, ${totalUsd} $ du ${totals?.first ?? "?"} au ${totals?.last ?? "?"}`);
  lines.push(`1 crédit rapporte ${netUsdPerCredit} $ net (CREDIT_NET_USD) ; marge sûre ${margin} (AI_BUDGET_MARGIN)`);
  if (!statuses) lines.push("Statuts des jobs inconnus (store SQLite) : coût par job livré = coût moyen.");
  lines.push("");
  lines.push("JOBS (par type ; échoués payés au fournisseur, remboursés à l'étudiant)");
  lines.push(pad(["type", "jobs", "livrés", "échecs", "appels", "moy $", "médiane $", "max $", "$/livré", "prix cr.", "min seuil", "min sûr"]));
  for (const j of jobs) {
    lines.push(pad([j.type, j.jobs, j.delivered ?? "?", j.failed ?? "?", j.calls, j.avgUsd, j.medianUsd, j.maxUsd, j.perDeliveredUsd, j.priceCredits, j.minCreditsBreakEven, j.minCreditsSafe]));
  }
  if (!jobs.length) lines.push("  (aucun job dans llm_usage)");
  lines.push("");
  lines.push(`ASSISTANCE (par appel — prix ${assistPrice} crédit)`);
  lines.push(pad(["site d'appel", "appels", "estimés", "moy $", "max $", "min seuil", "min sûr"]));
  for (const a of assist) lines.push(pad([a.callSite, a.calls, a.estimatedCalls, a.avgUsd, a.maxUsd, a.minCreditsBreakEven, a.minCreditsSafe]));
  if (!assist.length) lines.push("  (aucun appel d'assistance dans llm_usage)");
  return { source: reader.label, rows, totalUsd, first: totals?.first ?? null, last: totals?.last ?? null, jobs, assist, netUsdPerCredit, margin, text: lines.join("\n") };
}

function pad(cols: Array<string | number>): string {
  const widths = [18, 6, 7, 7, 7, 7, 10, 7, 8, 9, 10, 8];
  return cols.map((c, i) => String(c).padEnd(widths[i] ?? 10)).join(" ").trimEnd();
}
