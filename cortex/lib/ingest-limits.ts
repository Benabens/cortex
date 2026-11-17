import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

/**
 * Bornes de l'IMPORT (audit fuites I9). L'ingestion tourne dans le conteneur du site : un PDF
 * piégé (bombe de décompression, boucle de pdf.js) ne doit pas pouvoir tenir le CPU ni la
 * mémoire indéfiniment. Le process d'import a donc un tas plafonné et un délai ; au dépôt, un
 * PDF trop long est refusé avant d'être rangé.
 */

const positive = (raw: string | undefined, def: number) => {
  const n = Number(raw?.trim());
  return raw?.trim() && Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
};

/** Délai d'UNE passe d'import (INGEST_TIMEOUT_MS, défaut 20 min) : au-delà, elle est tuée. */
export function ingestTimeoutMs(): number {
  return positive(process.env.INGEST_TIMEOUT_MS, 20 * 60_000);
}

/** Tas maximal du process d'import (INGEST_MAX_HEAP_MB, défaut 2048 Mo). */
export function ingestMaxHeapMb(): number {
  return positive(process.env.INGEST_MAX_HEAP_MB, 2048);
}

/** Pages au plus par PDF déposé (PDF_MAX_PAGES, défaut 1500 : un manuel entier passe). */
export function pdfMaxPages(): number {
  return positive(process.env.PDF_MAX_PAGES, 1500);
}

/** NODE_OPTIONS avec ce plafond de tas, les autres options gardées. */
export function withHeapCap(env: Partial<NodeJS.ProcessEnv>, maxHeapMb: number): NodeJS.ProcessEnv {
  const kept = (env.NODE_OPTIONS ?? "").split(/\s+/).filter((o) => o && !o.startsWith("--max-old-space-size"));
  return { ...env, NODE_OPTIONS: [...kept, `--max-old-space-size=${maxHeapMb}`].join(" ") } as NodeJS.ProcessEnv;
}

export type BoundedRun = { child: ChildProcess; done: Promise<{ code: number | null; timedOut: boolean }> };

/**
 * Lance un process borné : tas plafonné, et au délai SIGKILL à tout son GROUPE. Le process est
 * détaché (chef de son groupe) parce que tsx relance node : tuer tsx seul laisserait node tourner.
 * `done` se résout à la fermeture (jamais rejeté : `timedOut` dit pourquoi elle a eu lieu).
 */
export function spawnBounded(
  cmd: string,
  args: string[],
  o: { timeoutMs: number; maxHeapMb: number; env?: NodeJS.ProcessEnv } & Pick<SpawnOptions, "cwd">,
): BoundedRun {
  const child = spawn(cmd, args, { cwd: o.cwd, env: withHeapCap(o.env ?? process.env, o.maxHeapMb), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid!, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* déjà sorti */ } }
  }, o.timeoutMs);
  const done = new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
    child.on("error", () => { clearTimeout(timer); resolve({ code: null, timedOut }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Un enfant resté dans le groupe après la sortie du chef ne survit pas à l'import.
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* groupe déjà vide */ }
      resolve({ code, timedOut });
    });
  });
  return { child, done };
}
