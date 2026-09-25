/**
 * ATTRIBUTION des appels LLM (colonnes `job_id` / `call_site` de `llm_usage`).
 *
 * - `job_id` : les jobs tournent UN PAR PROCESS (scripts/run-job.ts) → un « job
 *   courant » process-global suffit ; les appels inline (drill, check-solution,
 *   analyse…) n'ont pas de job → null.
 * - `call_site` : nom de la fonction applicative à l'origine de l'appel, dérivé
 *   de la pile — best-effort, jamais bloquant.
 */

let _job: { id: string; type: string } | null = null;

/** Déclare le job courant (appelé une fois par process de job). */
export function setCurrentJob(id: number | string, type: string): void {
  _job = { id: String(id), type };
}
export function clearCurrentJob(): void {
  _job = null;
}
export function currentJob(): { id: string; type: string } | null {
  return _job;
}

/**
 * Première frame de pile HORS de l'infrastructure LLM/billing et des internes
 * node = la fonction applicative appelante (ex. `generateBatch`, `generateDrill`).
 * À appeler DEPUIS le point d'entrée LLM (avant l'await), sinon la pile async
 * est tronquée.
 */
export function callerSite(): string | null {
  const stack = new Error().stack;
  if (!stack) return null;
  for (const line of stack.split("\n").slice(1)) {
    if (
      /[/\\]lib[/\\]llm[/\\]/.test(line) ||
      /[/\\]billing[/\\]usage/.test(line) ||
      /node:internal/.test(line)
    ) {
      continue;
    }
    // Formes v8 : "at fn (file:line:col)" ou "at file:line:col".
    const m = line.match(/at\s+(?:async\s+)?([^\s(]+)\s*\(/) ?? line.match(/at\s+(?:async\s+)?(.+?):\d+:\d+/);
    if (!m) continue;
    const name = m[1].trim();
    if (!name || name === "<anonymous>" || name === "Object.<anonymous>") continue;
    return name.replace(/^.*[/\\]/, "").slice(0, 120); // garde le nom, pas le chemin
  }
  return null;
}
