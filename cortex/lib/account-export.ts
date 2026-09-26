/**
 * EXPORT DES DONNÉES D'UN COMPTE (portabilité) — archive tar.gz produite EN FLUX.
 *
 * Contenu, tout sous un dossier temporaire puis `tar -czhf -` (le `h` suit le
 * lien symbolique vers les fichiers du volume : rien n'est copié) :
 *   export/manifest.json   — date, compte, cours exportés
 *   export/profil.json     — ligne users, acceptations CGV, abonnement
 *   export/cours.json      — fiches des cours possédés
 *   export/credits.json    — ledger (centièmes), achats, factures, usage agrégé
 *   export/cours/<id>/<table>.json — chaque table du tenant, écrite par pages
 *   fichiers/              — data/u/<slug>/ (annales importées, artefacts)
 *
 * Bornes : refus au-delà de EXPORT_MAX_MB (défaut 2048) mesurés sur les
 * fichiers du compte ; un seul export à la fois par compte ; jamais une table
 * entière en mémoire (pages de 500 lignes) ; le tar sort en flux.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { authAll, authGet } from "@/db/auth-store";
import { runWithCourse } from "@/db/client";
import { runWithUser, userSlug } from "@/db/context";
import { dbDriverName, q } from "@/db/q";
import { TABLES } from "@/db/tables";
import { DELTA_CENTI } from "@/lib/billing/credits";
import { dataRoot, ensureCoursesLoaded, listCoursesOf } from "@/lib/courses";
import { log } from "@/lib/metrics";
import { userStorageBytes } from "@/lib/storage-quota";

const PAGE = 500;
/** Tables techniques sans valeur pour la personne : exclues. */
const SKIP_TABLES = new Set(["llm_cache"]);

export class ExportTooLarge extends Error { readonly status = 413; }
export class ExportBusy extends Error { readonly status = 429; }

export function exportMaxBytes(): number {
  const mb = Number(process.env.EXPORT_MAX_MB);
  return (Number.isFinite(mb) && mb >= 0 ? mb : 2048) * 1024 * 1024;
}

async function writeJsonPaged(file: string, fetchPage: (offset: number) => Promise<unknown[]>): Promise<number> {
  const fd = fs.openSync(file, "w");
  let n = 0;
  try {
    fs.writeSync(fd, "[");
    for (let offset = 0; ; offset += PAGE) {
      const rows = await fetchPage(offset);
      for (const row of rows) {
        fs.writeSync(fd, (n ? ",\n" : "\n") + JSON.stringify(row));
        n++;
      }
      if (rows.length < PAGE) break;
    }
    fs.writeSync(fd, "\n]\n");
  } finally { fs.closeSync(fd); }
  return n;
}

/** Cours dont ce compte a des données : ses fiches, plus ses tenants enregistrés (Postgres). */
async function coursesOf(userId: string): Promise<string[]> {
  await ensureCoursesLoaded();
  const ids = new Set(listCoursesOf(userId).map((c) => c.id));
  if (dbDriverName() === "postgres") {
    for (const t of await authAll<{ course: string }>(`SELECT course FROM tenants WHERE user_id = ?`, userId)) ids.add(t.course);
  }
  return [...ids].sort();
}

/** Écrit l'export dans `dir` (export/ + lien fichiers/). Renvoie les cours exportés. */
export async function writeAccountExport(userId: string, dir: string): Promise<{ courses: string[]; files: string[] }> {
  const out = path.join(dir, "export");
  fs.mkdirSync(out, { recursive: true });
  const files: string[] = [];
  const write = (name: string, data: unknown) => {
    fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2) + "\n");
    files.push(`export/${name}`);
  };

  const user = await authGet<Record<string, unknown>>(`SELECT id, email, name, image, email_verified FROM users WHERE id = ?`, userId);
  const terms = await authAll(`SELECT version, accepted_at FROM terms_acceptances WHERE user_id = ? ORDER BY accepted_at`, userId).catch(() => []);
  const subscription = await authGet(`SELECT status, plan, monthly_credits, remaining, period_end, month_anchor, updated_at FROM subscriptions WHERE user_id = ?`, userId).catch(() => undefined);
  write("profil.json", { user: user ?? { id: userId }, terms, subscription: subscription ?? null });

  const courses = await authAll(`SELECT * FROM courses WHERE owner_user_id = ? ORDER BY created_at`, userId);
  write("cours.json", courses);

  const transactions = await authAll(
    `SELECT ${DELTA_CENTI} AS delta_centi, reason, ref, sub_amount AS sub_amount_centi, created_at FROM credit_transactions WHERE user_id = ? ORDER BY id`, userId,
  );
  const purchases = await authAll(`SELECT session_id, payment_intent, credits_centi, created_at FROM stripe_purchases WHERE user_id = ? ORDER BY created_at`, userId).catch(() => []);
  const invoices = await authAll(`SELECT invoice_id, subscription_id, granted_centi, period_end, created_at FROM stripe_invoices WHERE user_id = ? ORDER BY created_at`, userId).catch(() => []);
  const usage = await authGet<{ calls: number | string; cost_usd: number | string | null }>(
    `SELECT count(*) calls, coalesce(sum(cost_usd), 0) cost_usd FROM llm_usage WHERE user_id = ?`, userId,
  ).catch(() => undefined);
  write("credits.json", { unit: "centi (1 crédit = 100)", transactions, purchases, invoices, usage: { calls: Number(usage?.calls ?? 0), costUsd: Number(usage?.cost_usd ?? 0) } });

  const courseIds = await coursesOf(userId);
  for (const course of courseIds) {
    const cdir = path.join(out, "cours", course);
    fs.mkdirSync(cdir, { recursive: true });
    for (const spec of TABLES) {
      if (SKIP_TABLES.has(spec.name)) continue;
      const file = path.join(cdir, `${spec.name}.json`);
      try {
        await runWithUser(userId, () => runWithCourse(course, () =>
          writeJsonPaged(file, (offset) => q.all(`SELECT * FROM ${spec.name} LIMIT ? OFFSET ?`, PAGE, offset)),
        ));
        files.push(`export/cours/${course}/${spec.name}.json`);
      } catch (e) {
        // Table absente de ce tenant (ancienne base) : on le dit plutôt que d'échouer.
        fs.rmSync(file, { force: true });
        log("warn", "export.table_skipped", { course, table: spec.name, message: e instanceof Error ? e.message.slice(0, 120) : String(e) });
      }
    }
  }

  const userDir = path.join(dataRoot(), "u", userSlug(userId));
  if (fs.existsSync(userDir)) {
    fs.symlinkSync(userDir, path.join(dir, "fichiers"), "dir");
    files.push("fichiers/");
  }
  write("manifest.json", { createdAt: new Date().toISOString(), userId, courses: courseIds, files });
  return { courses: courseIds, files };
}

const inFlight = new Set<string>();

/** Prépare l'archive et renvoie un flux web (la route le passe tel quel à la réponse). */
export async function streamAccountExport(userId: string): Promise<{ body: ReadableStream<Uint8Array>; filename: string }> {
  if (inFlight.has(userId)) throw new ExportBusy("Un export est déjà en cours pour ce compte : attends qu'il se termine.");
  const bytes = await userStorageBytes(userId);
  const max = exportMaxBytes();
  if (bytes > max) {
    throw new ExportTooLarge(`Tes fichiers pèsent ${(bytes / 1024 / 1024).toFixed(0)} Mo, au-delà de la limite d'export (${(max / 1024 / 1024).toFixed(0)} Mo). Supprime des annales ou des fichiers importés, puis réessaie.`);
  }
  inFlight.add(userId);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-export-"));
  const cleanup = () => { inFlight.delete(userId); fs.rmSync(tmp, { recursive: true, force: true }); };
  try {
    await writeAccountExport(userId, tmp);
  } catch (e) {
    cleanup();
    throw e;
  }
  const child = spawn("tar", ["-czhf", "-", "-C", tmp, "."], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += String(d).slice(0, 500); });
  child.on("close", (code) => {
    if (code !== 0) log("error", "export.tar_failed", { code, stderr: stderr.slice(0, 300) });
    cleanup();
  });
  child.on("error", cleanup);
  const stamp = new Date().toISOString().slice(0, 10);
  return { body: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>, filename: `cortex-export-${userSlug(userId)}-${stamp}.tar.gz` };
}
