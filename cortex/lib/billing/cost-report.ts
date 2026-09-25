import { authAll } from "@/db/auth-store";
import { creditCost, fromCenti } from "./credits";

/**
 * RAPPORT DE COÛT — ce que les générations coûtent VRAIMENT (llm_usage), par
 * type de job et par appel d'assistance, face au prix facturé en crédits.
 * Sert à fixer les prix sur des mesures plutôt qu'à l'estime :
 *   npm run cost:report
 * Un job = (compte, cours, id) — les ids sont séquentiels par tenant. Le type
 * d'un job est le préfixe de call_site (`exam:generateBatch` → exam), posé par
 * lib/llm depuis le job courant du worker.
 */

export type JobTypeCost = {
  type: string;
  jobs: number;
  calls: number;
  estimatedCalls: number;
  avgUsd: number;
  maxUsd: number;
  priceCredits: number;
  priceChf: number;
  avgCostChf: number;
  maxCostChf: number;
  /** Marge moyenne : (prix − coût moyen) / prix, en %. Négatif = vendu à perte. */
  marginPct: number;
};

export type AssistCost = {
  callSite: string;
  calls: number;
  estimatedCalls: number;
  avgUsd: number;
  maxUsd: number;
  priceCredits: number;
  priceChf: number;
  avgCostChf: number;
  marginPct: number;
};

export type CostReport = { jobs: JobTypeCost[]; assist: AssistCost[]; text: string; creditPriceChf: number; chfPerUsd: number };

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Prix de vente d'un crédit (CHF) et taux de change : CREDIT_PRICE_CHF (défaut 2,08 — audit), CHF_PER_USD (défaut 0,86). */
function pricing(): { creditPriceChf: number; chfPerUsd: number } {
  const p = Number(process.env.CREDIT_PRICE_CHF);
  const r = Number(process.env.CHF_PER_USD);
  return { creditPriceChf: Number.isFinite(p) && p > 0 ? p : 2.08, chfPerUsd: Number.isFinite(r) && r > 0 ? r : 0.86 };
}

export async function costReport(): Promise<CostReport> {
  const { creditPriceChf, chfPerUsd } = pricing();
  const perJob = await authAll<{ type: string; calls: number; est: number; cost: number }>(
    `SELECT substr(call_site, 1, instr(call_site, ':') - 1) type, count(*) calls, sum(estimated) est, sum(cost_usd) cost
     FROM llm_usage WHERE job_id IS NOT NULL AND call_site LIKE '%:%'
     GROUP BY user_id, course, job_id, substr(call_site, 1, instr(call_site, ':') - 1)`,
  ).catch(async () =>
    // Postgres : position() au lieu de instr()
    authAll<{ type: string; calls: number; est: number; cost: number }>(
      `SELECT split_part(call_site, ':', 1) type, count(*) calls, sum(estimated) est, sum(cost_usd) cost
       FROM llm_usage WHERE job_id IS NOT NULL AND call_site LIKE '%:%'
       GROUP BY user_id, course, job_id, split_part(call_site, ':', 1)`,
    ),
  );
  const byType = new Map<string, { jobs: number; calls: number; est: number; total: number; max: number }>();
  for (const j of perJob) {
    const t = byType.get(j.type) ?? { jobs: 0, calls: 0, est: 0, total: 0, max: 0 };
    t.jobs++; t.calls += Number(j.calls); t.est += Number(j.est); t.total += Number(j.cost); t.max = Math.max(t.max, Number(j.cost));
    byType.set(j.type, t);
  }
  const jobs: JobTypeCost[] = [...byType.entries()].map(([type, t]) => {
    const avgUsd = t.total / t.jobs;
    const priceCredits = fromCenti(creditCost(type));
    const priceChf = r2(priceCredits * creditPriceChf);
    const avgCostChf = r2(avgUsd * chfPerUsd);
    return {
      type, jobs: t.jobs, calls: t.calls, estimatedCalls: t.est,
      avgUsd: r2(avgUsd), maxUsd: r2(t.max), priceCredits, priceChf, avgCostChf, maxCostChf: r2(t.max * chfPerUsd),
      marginPct: priceChf > 0 ? Math.round(((priceChf - avgCostChf) / priceChf) * 100) : 0,
    };
  }).sort((a, b) => b.jobs - a.jobs);

  const inline = await authAll<{ call_site: string; calls: number; est: number; avg: number; max: number }>(
    `SELECT coalesce(call_site, '?') call_site, count(*) calls, sum(estimated) est, avg(cost_usd) avg, max(cost_usd) max
     FROM llm_usage WHERE job_id IS NULL GROUP BY call_site ORDER BY calls DESC`,
  );
  const assistPriceCredits = fromCenti(creditCost("assist"));
  const assistPriceChf = r2(assistPriceCredits * creditPriceChf);
  const assist: AssistCost[] = inline.map((a) => {
    const avgCostChf = r2(Number(a.avg) * chfPerUsd);
    return {
      callSite: a.call_site, calls: Number(a.calls), estimatedCalls: Number(a.est),
      avgUsd: r2(Number(a.avg)), maxUsd: r2(Number(a.max)),
      priceCredits: assistPriceCredits, priceChf: assistPriceChf, avgCostChf,
      marginPct: assistPriceChf > 0 ? Math.round(((assistPriceChf - avgCostChf) / assistPriceChf) * 100) : 0,
    };
  });

  const lines: string[] = [];
  lines.push(`Coût réel vs prix — 1 crédit = ${creditPriceChf} CHF, 1 USD = ${chfPerUsd} CHF (CREDIT_PRICE_CHF / CHF_PER_USD)`);
  lines.push("");
  lines.push("JOBS (par type)");
  lines.push(pad(["type", "jobs", "appels", "estimés", "coût moy $", "coût max $", "prix cr.", "prix CHF", "coût moy CHF", "marge"]));
  for (const j of jobs) {
    lines.push(pad([j.type, j.jobs, j.calls, j.estimatedCalls, j.avgUsd, j.maxUsd, j.priceCredits, j.priceChf, j.avgCostChf, `${j.marginPct}%`]));
  }
  if (!jobs.length) lines.push("  (aucun job dans llm_usage)");
  lines.push("");
  lines.push(`ASSISTANCE (par appel — prix ${assistPriceCredits} cr. = ${assistPriceChf} CHF)`);
  lines.push(pad(["site d'appel", "appels", "estimés", "coût moy $", "coût max $", "coût moy CHF", "marge"]));
  for (const a of assist) lines.push(pad([a.callSite, a.calls, a.estimatedCalls, a.avgUsd, a.maxUsd, a.avgCostChf, `${a.marginPct}%`]));
  if (!assist.length) lines.push("  (aucun appel d'assistance dans llm_usage)");
  return { jobs, assist, text: lines.join("\n"), creditPriceChf, chfPerUsd };
}

function pad(cols: Array<string | number>): string {
  const widths = [26, 6, 7, 8, 11, 11, 9, 9, 13, 7];
  return cols.map((c, i) => String(c).padEnd(widths[i] ?? 10)).join(" ").trimEnd();
}
