import fs from "node:fs";

/**
 * TRACE DU BANC — `CORTEX_BENCH_TRACE=<fichier>` : le moteur y note ce que le run exporté ne
 * garde pas (un QCM rejeté puis régénéré disparaît de la base). Le banc s'en sert pour juger les
 * faux rejets « hors cours ». Hors banc, la variable n'est pas posée : rien n'est écrit.
 */
export function benchTrace(event: string, data: Record<string, unknown>): void {
  const file = process.env.CORTEX_BENCH_TRACE;
  if (!file) return;
  try {
    fs.appendFileSync(file, `${JSON.stringify({ event, at: Date.now(), ...data })}\n`);
  } catch { /* best-effort : la trace ne casse jamais une génération */ }
}
