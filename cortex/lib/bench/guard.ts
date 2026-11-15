/**
 * GARDE DU BANC (scripts/bench) — décision de Ben du 04/11/2026 : aucun appel à l'API
 * payante. Tout passe par le provider codex-cli (abonnement Codex), et aucune clé API n'est
 * chargée : le CLI pourrait la prendre à la place de l'abonnement si elle
 * passait jusqu'à lui. Les données vivent dans une base Postgres LOCALE et un dossier jetable.
 *
 * Seule exception, sur opt-in explicite (CORTEX_BENCH_PAID=anthropic) : une mesure réelle du
 * coût de prod, autorisée par Ben pour le chantier coût du 15/11 (15 $ au total). La clé
 * Anthropic passe alors, et elle seule ; SPEND_CAP_USD plafonne chaque run (kill-switch de
 * lib/billing/usage, compté sur la base jetable du run). Le juge reste sur codex-cli.
 */

const API_KEYS = ["ANTHROPIC_API_KEY", "LLM_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"] as const;
/** Clés qu'une mesure réelle sur l'API Anthropic peut porter. */
const ANTHROPIC_KEYS = new Set<string>(["ANTHROPIC_API_KEY", "LLM_API_KEY"]);
/** Plafond le plus haut accepté pour UN run payant (le budget du chantier entier). */
const PAID_RUN_MAX_USD = 15;

type Env = Record<string, string | undefined>;

/** Mesure payante du moteur demandée (opt-in explicite). */
export function isPaidBench(env: Env): boolean {
  return env.CORTEX_BENCH_PAID === "anthropic";
}

/** L'environnement du juge : sur une mesure payante, la clé et l'opt-in retirés, provider codex-cli. */
export function judgeEnv<E extends Env>(env: E): E {
  if (!isPaidBench(env)) return env;
  const out: Env = { ...env, LLM_PROVIDER: "codex-cli" };
  for (const k of ["CORTEX_BENCH_PAID", "SPEND_CAP_USD", ...ANTHROPIC_KEYS]) delete out[k];
  return out as E;
}

/** `judge` : le juge tourne toujours sur l'abonnement Codex, jamais sur l'API payante. */
export function assertBenchEnv(env: Env = process.env, opts: { judge?: boolean } = {}): void {
  const problems: string[] = [];
  const paid = isPaidBench(env);
  if (paid && opts.judge) problems.push("le juge ne tourne jamais sur l'API : retire CORTEX_BENCH_PAID (le juge passe par codex-cli)");
  else if (paid) {
    if (env.LLM_PROVIDER !== "anthropic") problems.push(`une mesure payante (CORTEX_BENCH_PAID=anthropic) exige LLM_PROVIDER=anthropic (reçu : ${env.LLM_PROVIDER ?? "non posé"})`);
    const cap = Number(env.SPEND_CAP_USD);
    if (!(env.SPEND_CAP_USD ?? "").trim() || !Number.isFinite(cap) || cap <= 0 || cap > PAID_RUN_MAX_USD) {
      problems.push(`une mesure payante exige SPEND_CAP_USD entre 0 et ${PAID_RUN_MAX_USD} $ (reçu : ${env.SPEND_CAP_USD ?? "non posé"})`);
    }
  } else if (env.LLM_PROVIDER !== "codex-cli") {
    problems.push(`le banc exige LLM_PROVIDER=codex-cli (reçu : ${env.LLM_PROVIDER ?? "non posé"}) — aucun appel à l'API payante`);
  }
  for (const k of API_KEYS) {
    if (paid && ANTHROPIC_KEYS.has(k)) continue;
    if ((env[k] ?? "").trim()) problems.push(`${k} est chargée dans l'environnement : retire-la avant de lancer le banc`);
  }
  if (!env.CORTEX_DATA_DIR) problems.push("pose CORTEX_DATA_DIR sur un dossier jetable");
  if (!env.DATABASE_URL) problems.push("pose DATABASE_URL sur une base Postgres locale jetable");
  else {
    let host = "";
    try { host = new URL(env.DATABASE_URL).hostname; } catch { /* host vide : refusé ci-dessous */ }
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) problems.push(`DATABASE_URL doit viser une base locale (hôte reçu : ${host || "illisible"}) — jamais la prod`);
  }
  if (problems.length) throw new Error(`Banc refusé :\n- ${problems.join("\n- ")}`);
}
