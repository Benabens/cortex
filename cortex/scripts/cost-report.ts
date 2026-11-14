/**
 * Rapport de coût réel (llm_usage) par type de job et par appel d'assistance,
 * comparé au prix en crédits et au revenu net d'un crédit. Pour fixer les prix
 * sur des mesures :
 *   npm run cost:report                                  (store local)
 *   DATABASE_URL=<DATABASE_PUBLIC_URL> npm run cost:report   (prod, LECTURE SEULE)
 *   npm run cost:report -- --since=2026-11-13            (moteur récent seulement)
 * Variables : CREDIT_NET_USD (revenu net d'un crédit, défaut 0,47 $),
 * AI_BUDGET_MARGIN (défaut 0,6), CREDITS_COST_JSON (tarif courant).
 * Aucune écriture, aucune migration : cf. lib/billing/report-source.
 */
import { costReport } from "../lib/billing/cost-report";
import { openReportReader } from "../lib/billing/report-source";

(async () => {
  const reader = await openReportReader();
  try {
    const since = process.argv.find((a) => a.startsWith("--since="))?.slice("--since=".length);
    console.log((await costReport(reader, process.env, { since })).text);
  } finally {
    await reader.close();
  }
  process.exit(0);
})().catch((e) => { console.error("[cost:report] échec :", (e as Error)?.message ?? e); process.exit(1); });
