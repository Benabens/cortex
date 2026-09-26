/**
 * SAUVEGARDE QUOTIDIENNE — déclenchée depuis le serveur lui-même (aucun cron
 * externe chez Railway), UNE fois par jour UTC, même avec plusieurs instances
 * (redéploiement chevauchant) : le jour courant est réclamé par un UPSERT
 * conditionnel sur `app_meta` — une seule instance obtient la ligne.
 *
 * Échec du job → le marqueur est rendu, le tick suivant (toutes les 30 min)
 * réessaie ; succès → plus rien jusqu'au lendemain. Sans BACKUP_S3_* le
 * planificateur ne démarre pas (rien à pousser hors site).
 */
import path from "node:path";
import { spawn } from "node:child_process";
import { authAll, authRun } from "@/db/auth-store";
import { backupS3Config, type Env } from "./backup-s3";

const KEY = "backup:daily";
export const BACKUP_TICK_MS = 30 * 60_000;

export function backupDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function backupHourUtc(env: Env = process.env): number {
  const n = Number((env.BACKUP_HOUR_UTC ?? "").trim() || 3);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : 3;
}

/** Réclame le jour : vrai pour UNE seule instance par jour. */
export async function claimDailyBackup(dayKey: string): Promise<boolean> {
  const rows = await authAll<{ key: string }>(
    `INSERT INTO app_meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value WHERE app_meta.value <> excluded.value
     RETURNING key`,
    KEY, dayKey,
  );
  return rows.length === 1;
}

/** Rend le jour après un échec (le prochain tick pourra réessayer). */
export async function releaseDailyBackup(dayKey: string): Promise<void> {
  await authRun(`UPDATE app_meta SET value = ? WHERE key = ? AND value = ?`, `${dayKey}:failed`, KEY, dayKey);
}

export type TickOutcome = "skipped:not-configured" | "skipped:too-early" | "skipped:done" | "ok" | "failed";

export async function dailyBackupTick(opts: { now?: Date; env?: Env; run: () => Promise<number>; log?: (m: string) => void }): Promise<TickOutcome> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const log = opts.log ?? console.log;
  if (!backupS3Config(env)) return "skipped:not-configured";
  if (now.getUTCHours() < backupHourUtc(env)) return "skipped:too-early";
  const day = backupDayKey(now);
  if (!(await claimDailyBackup(day))) return "skipped:done";
  log(`[backup] sauvegarde quotidienne du ${day} : démarrage`);
  let code: number;
  try {
    code = await opts.run();
  } catch (e) {
    log(`[backup] sauvegarde quotidienne : exception ${(e as Error).message}`);
    code = -1;
  }
  if (code === 0) {
    log(`[backup] sauvegarde quotidienne du ${day} : OK`);
    return "ok";
  }
  await releaseDailyBackup(day);
  log(`[backup] sauvegarde quotidienne du ${day} : ÉCHEC (code ${code}) — nouvel essai au prochain tick`);
  return "failed";
}

/** Lance `scripts/backup.ts --push --prune --no-local` dans un process enfant ; résout avec le code de sortie. */
export function runBackupChild(): Promise<number> {
  return new Promise((resolve) => {
    const tsx = path.join(process.cwd(), "node_modules", ".bin", "tsx");
    const child = spawn(tsx, ["scripts/backup.ts", "--push", "--prune", "--no-local"], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", () => resolve(-1));
    child.on("exit", (code) => resolve(code ?? -1));
  });
}

/** Démarre le planificateur (une minuterie par process, hot-reload safe). null si non configuré. */
export function startBackupScheduler(): NodeJS.Timeout | null {
  const g = globalThis as { __cortexBackupTimer?: NodeJS.Timeout };
  let cfg: ReturnType<typeof backupS3Config>;
  try {
    cfg = backupS3Config();
  } catch (e) {
    console.error(`[backup] ${(e as Error).message} — sauvegardes hors site DÉSACTIVÉES`);
    return null;
  }
  if (!cfg) return null;
  if (g.__cortexBackupTimer) clearInterval(g.__cortexBackupTimer);
  const tick = () => dailyBackupTick({ run: runBackupChild }).catch((e) => console.error("[backup] tick :", (e as Error).message));
  // Premier passage différé d'une minute : laisser la base et les jobs démarrer.
  setTimeout(tick, 60_000).unref?.();
  g.__cortexBackupTimer = setInterval(tick, BACKUP_TICK_MS);
  g.__cortexBackupTimer.unref?.();
  console.log(`[backup] sauvegardes quotidiennes hors site actives (${backupHourUtc()}h UTC, rétention ${cfg.keepDays} j)`);
  return g.__cortexBackupTimer;
}
