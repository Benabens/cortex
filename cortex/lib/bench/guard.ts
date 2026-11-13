/**
 * GARDE DU BANC (scripts/bench) — décision de Ben du 04/11/2026 : aucun appel à l'API
 * payante. Tout passe par le provider codex-cli (abonnement Codex), et aucune clé API n'est
 * chargée : le CLI pourrait la prendre à la place de l'abonnement si elle
 * passait jusqu'à lui. Les données vivent dans une base Postgres LOCALE et un dossier jetable.
 */

const API_KEYS = ["ANTHROPIC_API_KEY", "LLM_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"] as const;

export function assertBenchEnv(env: Record<string, string | undefined> = process.env): void {
  const problems: string[] = [];
  if (env.LLM_PROVIDER !== "codex-cli") problems.push(`le banc exige LLM_PROVIDER=codex-cli (reçu : ${env.LLM_PROVIDER ?? "non posé"}) — aucun appel à l'API payante`);
  for (const k of API_KEYS) if ((env[k] ?? "").trim()) problems.push(`${k} est chargée dans l'environnement : retire-la avant de lancer le banc`);
  if (!env.CORTEX_DATA_DIR) problems.push("pose CORTEX_DATA_DIR sur un dossier jetable");
  if (!env.DATABASE_URL) problems.push("pose DATABASE_URL sur une base Postgres locale jetable");
  else {
    let host = "";
    try { host = new URL(env.DATABASE_URL).hostname; } catch { /* host vide : refusé ci-dessous */ }
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) problems.push(`DATABASE_URL doit viser une base locale (hôte reçu : ${host || "illisible"}) — jamais la prod`);
  }
  if (problems.length) throw new Error(`Banc refusé :\n- ${problems.join("\n- ")}`);
}
