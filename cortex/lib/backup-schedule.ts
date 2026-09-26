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
import { authAll, authGet, authRun } from "@/db/auth-store";
import { backupS3Config, type Env } from "./backup-s3";

const KEY = "backup:daily";
/** Compte rendu de la dernière sauvegarde réussie : {day, folder, postgres}. */
const RESULT_KEY = "backup:daily_result";
export const BACKUP_TICK_MS = 30 * 60_000;

export type BackupResult = { day: string; folder: string; postgres: boolean; at?: string };

/** Écrit par le script de sauvegarde après un envoi réussi (lu par le planificateur). */
export async function recordBackupResult(day: string, r: { postgres: boolean; folder: string }): Promise<void> {
  const value = JSON.stringify({ day, folder: r.folder, postgres: r.postgres, at: new Date().toISOString() } satisfies BackupResult);
  await authRun(
    `INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    RESULT_KEY, value,
  );
}
export async function lastBackupResult(): Promise<BackupResult | null> {
  const row = await authGet<{ value: string }>(`SELECT value FROM app_meta WHERE key = ?`, RESULT_KEY);
  if (!row) return null;
  try { return JSON.parse(row.value) as BackupResult; } catch { return null; }
}

/** La base courante exige-t-elle un dump ? (Postgres réseau — pas PGlite, pas sqlite.) */
export function dumpExpected(env: Env = process.env): boolean {
  const url = env.DATABASE_URL ?? "";
  return (env.DB_DRIVER ?? "sqlite") === "postgres" && /^postgres(ql)?:\/\//i.test(url);
}

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
  await authRun(`UPDATE app_meta SET value = ? WHERE key = ? AND value LIKE ?`, `${dayKey}:failed`, KEY, `${dayKey}%`);
}

/**
 * Le jour est marqué « fait » mais rien ne le PROUVE : pas de compte rendu pour
 * ce jour, ou compte rendu sans dump alors que la base est Postgres (cas de la
 * première sauvegarde de prod). UNE instance reprend la main : l'UPDATE
 * conditionnel ne réussit que pour elle.
 */
async function reclaimUnproven(dayKey: string, expectDump: boolean): Promise<boolean> {
  const r = await lastBackupResult();
  const proven = !!r && r.day === dayKey && (!expectDump || r.postgres);
  if (proven) return false;
  const rows = await authAll<{ key: string }>(
    `UPDATE app_meta SET value = ? WHERE key = ? AND value = ? RETURNING key`, `${dayKey}:redo`, KEY, dayKey,
  );
  return rows.length === 1;
}

export type TickOutcome = "skipped:not-configured" | "skipped:too-early" | "skipped:done" | "ok" | "failed";

export async function dailyBackupTick(opts: {
  now?: Date; env?: Env; run: () => Promise<number>; log?: (m: string) => void;
  /** la base exige un dump (défaut : DB_DRIVER=postgres avec une URL postgres(ql)://) */
  expectDump?: boolean;
}): Promise<TickOutcome> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const log = opts.log ?? console.log;
  const expectDump = opts.expectDump ?? dumpExpected(env);
  if (!backupS3Config(env)) return "skipped:not-configured";
  if (now.getUTCHours() < backupHourUtc(env)) return "skipped:too-early";
  const day = backupDayKey(now);
  if (!(await claimDailyBackup(day))) {
    // Marqué fait : vérifier que c'est PROUVÉ (compte rendu du jour, avec dump si requis).
    if (!(await reclaimUnproven(day, expectDump))) return "skipped:done";
    log(`[backup] sauvegarde du ${day} marquée faite mais sans preuve${expectDump ? " (dump Postgres attendu)" : ""} : relance`);
  }
  log(`[backup] sauvegarde quotidienne du ${day} : démarrage`);
  let code: number;
  try {
    code = await opts.run();
  } catch (e) {
    log(`[backup] sauvegarde quotidienne : exception ${(e as Error).message}`);
    code = -1;
  }
  if (code === 0) {
    const r = await lastBackupResult();
    if (r && r.day === day && (!expectDump || r.postgres)) {
      // Après une relance (« :redo »), le marqueur revient à l'état « fait » du jour.
      await authRun(`UPDATE app_meta SET value = ? WHERE key = ? AND value LIKE ?`, day, KEY, `${day}%`);
      log(`[backup] sauvegarde quotidienne du ${day} : OK (${r.folder}${r.postgres ? ", dump Postgres" : ""})`);
      return "ok";
    }
    log(`[backup] sauvegarde quotidienne du ${day} : terminée SANS preuve${expectDump ? " (aucun dump Postgres)" : " (aucun compte rendu)"} — considérée en ÉCHEC`);
    code = -2;
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
