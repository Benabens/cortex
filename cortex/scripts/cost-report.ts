/**
 * Rapport de coût réel (llm_usage) par type de job et par appel d'assistance,
 * comparé au prix en crédits. Pour fixer les prix sur des mesures :
 *   npm run cost:report
 * Variables : CREDIT_PRICE_CHF (défaut 2,08), CHF_PER_USD (défaut 0,86),
 * CREDITS_COST_JSON (tarif courant). Lit le store global (sqlite ou Postgres).
 */
import { costReport } from "../lib/billing/cost-report";

costReport()
  .then((r) => { console.log(r.text); process.exit(0); })
  .catch((e) => { console.error("[cost:report] échec :", (e as Error)?.message ?? e); process.exit(1); });
