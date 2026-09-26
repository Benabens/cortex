import { execFileSync } from "node:child_process";

/**
 * TUER UN ARBRE DE PROCESSUS (annulation de job).
 *
 * `tsx` re-spawne le script : le PID enregistré n'est pas forcément le leader
 * du groupe. On cherche le vrai groupe via `ps` ; sans `ps` (image minimale,
 * PATH restreint), on se rabat sur -pid : le worker est lancé `detached`, il
 * est donc leader de son propre groupe et kill(-pid) emporte ses enfants.
 * Dernier repli : le PID seul.
 */
export function pgidOf(pid: number): number | null {
  try {
    const out = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const n = Number(out);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** SIGTERM au groupe (puis SIGKILL après `graceMs`). Renvoie la cible utilisée (négatif = groupe). */
export function killProcessGroup(pid: number, opts: { pgidLookup?: (pid: number) => number | null; graceMs?: number } = {}): number {
  const lookup = opts.pgidLookup ?? pgidOf;
  const pgid = lookup(pid);
  const target = -(pgid ?? pid);
  const send = (sig: NodeJS.Signals) => {
    try { process.kill(target, sig); return; } catch { /* groupe introuvable */ }
    try { process.kill(pid, sig); } catch { /* déjà mort */ }
  };
  send("SIGTERM");
  const t = setTimeout(() => send("SIGKILL"), opts.graceMs ?? 3_000);
  (t as { unref?: () => void }).unref?.();
  return target;
}
