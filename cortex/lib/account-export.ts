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
 * Bornes : refus au-delà de EXPORT_MAX_MB (défaut 2048), mesurés sur les
 * fichiers du compte ET sur tout ce qui est écrit dans le dossier temporaire ;
 * un export à la fois par compte, EXPORT_MAX_CONCURRENT (2) au total ; jamais
 * une table entière en mémoire (pages de 500 lignes) ; le tar sort en flux.
 *
 * SÛRETÉ : les fichiers du compte sont reliés par LIENS DURS (même volume :
 * le temporaire vit sous CORTEX_DATA_DIR/.export-tmp) ; tout lien symbolique
 * rencontré sous data/u/<slug>/ est IGNORÉ (jamais suivi : `tar` tourne sans
 * -h) ; l'export ne passe JAMAIS par ensureTenant — il ne lit que les schémas
 * déjà enregistrés dans public.tenants, en lecture seule : aucun schéma ni
 * ligne de registre n'est créé. Le temporaire est nettoyé dans tous les cas.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { authAll, authGet } from "@/db/auth-store";
import { runWithCourse } from "@/db/client";
import { runWithUser, userSlug } from "@/db/context";
import { dbDriverName, q } from "@/db/q";
import { DELTA_CENTI } from "@/lib/billing/credits";
import { courseDbPath, dataRoot, ensureCoursesLoaded, listCoursesOf } from "@/lib/courses";
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
export function exportMaxConcurrent(): number {
  const n = Number(process.env.EXPORT_MAX_CONCURRENT);
  return Number.isInteger(n) && n >= 0 ? n : 2;
}

/** Compteur d'octets écrits dans le temporaire : dépassement → ExportTooLarge. */
class Budget {
  used = 0;
  constructor(readonly max: number) {}
  add(n: number): void {
    this.used += n;
    if (this.used > this.max) {
      throw new ExportTooLarge(`L'export dépasse la limite (${(this.max / 1024 / 1024).toFixed(0)} Mo). Supprime des annales ou des fichiers importés, puis réessaie.`);
    }
  }
}

async function writeJsonPaged(file: string, budget: Budget, fetchPage: (offset: number) => Promise<unknown[]>): Promise<number> {
  const fd = fs.openSync(file, "w");
  let n = 0;
  try {
    budget.add(fs.writeSync(fd, "["));
    for (let offset = 0; ; offset += PAGE) {
      const rows = await fetchPage(offset);
      for (const row of rows) {
        budget.add(fs.writeSync(fd, (n ? ",\n" : "\n") + JSON.stringify(row)));
        n++;
      }
      if (rows.length < PAGE) break;
    }
    budget.add(fs.writeSync(fd, "\n]\n"));
  } finally { fs.closeSync(fd); }
  return n;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Tenants à exporter, en LECTURE SEULE et sans rien amorcer :
 *  - Postgres : uniquement les schémas déjà enregistrés dans public.tenants,
 *    lus directement (`"schema"."table"`), jamais via runWithCourse/ensureTenant ;
 *  - sqlite (dev) : les cours possédés dont la base existe déjà sur le disque.
 */
type TenantReader = { course: string; tables: () => Promise<string[]>; page: (table: string, offset: number) => Promise<unknown[]> };
async function tenantReaders(userId: string): Promise<TenantReader[]> {
  await ensureCoursesLoaded();
  if (dbDriverName() === "postgres") {
    const rows = await authAll<{ course: string; schema_name: string }>(`SELECT course, schema_name FROM tenants WHERE user_id = ? ORDER BY course`, userId);
    return rows.filter((r) => IDENT.test(r.schema_name)).map((r) => ({
      course: r.course,
      tables: async () => (await authAll<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name`, r.schema_name,
      )).map((t) => t.table_name).filter((t) => IDENT.test(t) && !SKIP_TABLES.has(t)),
      page: (table, offset) => authAll(`SELECT * FROM "${r.schema_name}"."${table}" LIMIT ? OFFSET ?`, PAGE, offset),
    }));
  }
  return listCoursesOf(userId).filter((c) => fs.existsSync(courseDbPath(c.id))).map((c) => ({
    course: c.id,
    tables: () => runWithUser(userId, () => runWithCourse(c.id, async () =>
      (await q.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`))
        .map((t) => t.name).filter((t) => IDENT.test(t) && !SKIP_TABLES.has(t)))),
    page: (table, offset) => runWithUser(userId, () => runWithCourse(c.id, () => q.all(`SELECT * FROM "${table}" LIMIT ? OFFSET ?`, PAGE, offset))),
  }));
}

/**
 * Copie « fichiers/ » par liens durs (même volume), en IGNORANT tout lien
 * symbolique (fichier ou dossier) : rien hors de data/u/<slug>/ ne peut entrer
 * dans l'archive. Repli copie si le lien dur est impossible.
 */
function linkTree(src: string, dest: string, budget: Budget, skipped: string[]): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isSymbolicLink()) { skipped.push(from); continue; }
    if (e.isDirectory()) { linkTree(from, to, budget, skipped); continue; }
    if (!e.isFile()) continue;
    const size = fs.lstatSync(from).size;
    budget.add(size);
    try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); }
  }
}

/** Écrit l'export dans `dir` (export/ + fichiers/). Renvoie les cours exportés. */
export async function writeAccountExport(userId: string, dir: string, budget: Budget = new Budget(exportMaxBytes())): Promise<{ courses: string[]; files: string[] }> {
  const out = path.join(dir, "export");
  fs.mkdirSync(out, { recursive: true });
  const files: string[] = [];
  const write = (name: string, data: unknown) => {
    const text = JSON.stringify(data, null, 2) + "\n";
    budget.add(Buffer.byteLength(text));
    fs.writeFileSync(path.join(out, name), text);
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

  const readers = await tenantReaders(userId);
  const courseIds = readers.map((r) => r.course);
  for (const r of readers) {
    const cdir = path.join(out, "cours", r.course);
    fs.mkdirSync(cdir, { recursive: true });
    for (const table of await r.tables()) {
      const file = path.join(cdir, `${table}.json`);
      try {
        await writeJsonPaged(file, budget, (offset) => r.page(table, offset));
        files.push(`export/cours/${r.course}/${table}.json`);
      } catch (e) {
        if (e instanceof ExportTooLarge) throw e;
        fs.rmSync(file, { force: true });
        log("warn", "export.table_skipped", { course: r.course, table, message: e instanceof Error ? e.message.slice(0, 120) : String(e) });
      }
    }
  }

  const userDir = path.join(dataRoot(), "u", userSlug(userId));
  const skipped: string[] = [];
  if (fs.existsSync(userDir) && !fs.lstatSync(userDir).isSymbolicLink()) {
    linkTree(userDir, path.join(dir, "fichiers"), budget, skipped);
    files.push("fichiers/");
  }
  if (skipped.length) log("warn", "export.symlinks_skipped", { user: userId, count: skipped.length });
  write("manifest.json", { createdAt: new Date().toISOString(), userId, courses: courseIds, files, symlinksIgnored: skipped.length, bytes: budget.used });
  return { courses: courseIds, files };
}

const inFlight = new Set<string>();

/** Prépare l'archive et renvoie un flux web (la route le passe tel quel à la réponse). */
export async function streamAccountExport(userId: string): Promise<{ body: ReadableStream<Uint8Array>; filename: string }> {
  if (inFlight.has(userId)) throw new ExportBusy("Un export est déjà en cours pour ce compte : attends qu'il se termine.");
  if (inFlight.size >= exportMaxConcurrent()) throw new ExportBusy("Trop d'exports en cours sur le serveur : réessaie dans quelques minutes.");
  const bytes = await userStorageBytes(userId);
  const max = exportMaxBytes();
  if (bytes > max) {
    throw new ExportTooLarge(`Tes fichiers pèsent ${(bytes / 1024 / 1024).toFixed(0)} Mo, au-delà de la limite d'export (${(max / 1024 / 1024).toFixed(0)} Mo). Supprime des annales ou des fichiers importés, puis réessaie.`);
  }
  inFlight.add(userId);
  // Temporaire SUR LE VOLUME (liens durs possibles), hors data/u/ (jamais compté ni exporté).
  const tmpRoot = path.join(dataRoot(), ".export-tmp");
  fs.mkdirSync(tmpRoot, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(tmpRoot, "x-"));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    inFlight.delete(userId);
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  try {
    await writeAccountExport(userId, tmp, new Budget(max));
  } catch (e) {
    cleanup();
    throw e;
  }
  const child = spawn("tar", ["-czf", "-", "-C", tmp, "."], { stdio: ["ignore", "pipe", "pipe"] });
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
