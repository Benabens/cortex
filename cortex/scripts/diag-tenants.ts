/**
 * DIAGNOSTIC DES TENANTS POSTGRES — LECTURE SEULE.
 *
 *   DATABASE_URL=postgres://… npx tsx scripts/diag-tenants.ts [--json]
 *
 * Contrôles : lib/tenant-diag.ts (index de recherche, vocabulaire, registre, schémas orphelins,
 * passages sans source, annales sans source, relevé d'index, suppressions en plan).
 *
 * Lecture seule GARANTIE par Postgres, pas par discipline : la connexion est ouverte avec
 * `default_transaction_read_only = on`, toute écriture y échoue. Le script n'importe ni la façade
 * `q` ni le store d'auth, dont la première requête crée des schémas et des lignes de registre.
 *
 * Sortie : 0 sans erreur, 1 si au moins un constat de gravité « erreur », 2 si la base est
 * injoignable. Réparer : le prochain prod-boot recalcule text_norm et le vocabulaire vide
 * (repairSearchIndex) ; le reste se décide à la main.
 */
import postgres from "postgres";
import { diagnoseTenants, formatDiag } from "../lib/tenant-diag";

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url || !/^postgres(ql)?:\/\//.test(url)) {
    console.error("DATABASE_URL manquante ou non Postgres (postgres://…).");
    return 2;
  }
  const sql = postgres(url, {
    max: 1,
    onnotice: () => {},
    connection: { default_transaction_read_only: true, application_name: "cortex-diag-tenants" },
  });
  try {
    const ro = await sql.unsafe(`SHOW default_transaction_read_only`);
    if (String(ro[0]?.default_transaction_read_only) !== "on") throw new Error("la connexion n'est pas en lecture seule : arrêt");
    const report = await diagnoseTenants((text, params = []) => sql.unsafe(text, params as never[]) as unknown as Promise<Record<string, unknown>[]>);
    console.log(process.argv.includes("--json") ? JSON.stringify(report, null, 2) : formatDiag(report));
    return report.findings.some((f) => f.severity === "erreur") ? 1 : 0;
  } catch (e) {
    console.error(`diag-tenants : ${(e as Error).message}`);
    return 2;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().then((code) => process.exit(code));
