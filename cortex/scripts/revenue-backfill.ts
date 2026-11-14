/**
 * Reprise de l'historique Stripe dans le revenu encaissé (stripe_payments) :
 * packs et factures antérieurs au 14/11/2026, frais réels, remboursements et
 * litiges — cf. lib/billing/revenue-backfill.
 *   npm run billing:backfill                    (dry-run : lecture seule, rien n'est écrit)
 *   npm run billing:backfill -- --write         (enregistre, par le store global)
 * Variables : STRIPE_SECRET_KEY (lue seulement), DATABASE_URL (sinon le store local).
 * Stripe n'est que LU (retrieve / list).
 */
import { backfillRevenue } from "../lib/billing/revenue-backfill";
import { openReportReader } from "../lib/billing/report-source";

(async () => {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new Error("STRIPE_SECRET_KEY absente.");
  const write = process.argv.includes("--write");
  const { stripeClient } = await import("../lib/billing/stripe-client");
  const { stripeBackfillApi } = await import("../lib/billing/stripe-fees");
  const api = stripeBackfillApi(stripeClient(key));
  let report;
  let label: string;
  if (write) {
    const { authAll } = await import("../db/auth-store");
    label = "store global (écriture)";
    report = await backfillRevenue({ read: (sql, ...p) => authAll(sql, ...p), api, write });
  } else {
    const reader = await openReportReader();
    label = reader.label;
    try { report = await backfillRevenue({ read: (sql, ...p) => reader.all(sql, ...p), api, write }); }
    finally { await reader.close(); }
  }
  console.log(`[billing:backfill] ${write ? "ÉCRITURE" : "dry-run (rien n'est écrit)"} — ${label}`);
  console.log(`  paiements à reprendre : ${report.toRecord} (${report.recordedGrossUsd.toFixed(2)} $ bruts)`);
  console.log(`  frais estimés → réels : ${report.feesToFix}`);
  console.log(`  remboursements repris : ${report.refunds} ; litiges repris : ${report.disputes}`);
  for (const s of report.skipped) console.log(`  écarté ${s.sourceId} : ${s.why}`);
  if (!write && (report.toRecord || report.feesToFix)) console.log("  → relancer avec --write pour enregistrer.");
  process.exit(0);
})().catch((e) => { console.error("[billing:backfill] échec :", (e as Error)?.message ?? e); process.exit(1); });
