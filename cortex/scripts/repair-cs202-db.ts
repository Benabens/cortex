/**
 * RÉPARATION de data/cortex.db (cs-202).
 *
 * Contexte : cas observé où la DB locale ET le blob commité étaient corrompus
 * (pages FTS5 cross-linkées ; items/topics/exam_refs illisibles en scan complet).
 * Recette PROUVÉE : sqlite3 .recover → rebuild FTS → swap → `npm run ingest`
 * (reconstruit items/sources/vocab/FTS/exam_refs depuis les sources commitées)
 * → régression byte-identique aux hashes canoniques.
 *
 *   npx tsx scripts/repair-cs202-db.ts            # DIAGNOSTIC + dry-run (ne touche à rien)
 *   npx tsx scripts/repair-cs202-db.ts --yes      # répare vraiment (backup d'abord)
 *   npx tsx scripts/repair-cs202-db.ts --yes --ingest   # + relance l'ingestion
 *   (--ci = --yes --ingest, pour le workflow GitHub Actions)
 *
 * Les tables UTILISATEUR (schedule, weaknesses, exams…) sont préservées par la
 * récupération ; le corpus est reconstruit par l'ingestion. L'original est
 * sauvegardé dans data/backup-corrupt-<date>/ avant tout remplacement.
 */
import BetterSqlite3 from "better-sqlite3";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { allDdl } from "../db/tables";

const argv = process.argv.slice(2);
const CI = argv.includes("--ci");
const YES = CI || argv.includes("--yes");
const INGEST = CI || argv.includes("--ingest");

const DB = path.join(process.cwd(), "data", "cortex.db");

function integrity(file: string): string {
  const d = new BetterSqlite3(file, { readonly: true });
  try {
    const rows = d.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
    return rows.map((r) => r.integrity_check).join(" | ");
  } finally {
    d.close();
  }
}

function sqlite3CliAvailable(): boolean {
  try { execFileSync("sqlite3", ["--version"], { timeout: 5_000 }); return true; } catch { return false; }
}

function runIngest(): void {
  console.log("\n→ npm run ingest (reconstruction du corpus)…");
  const r = spawnSync(path.join(process.cwd(), "node_modules", ".bin", "tsx"), ["scripts/ingest.ts"], {
    stdio: "inherit",
    env: { ...process.env, CORTEX_COURSE: "cs-202" },
  });
  if (r.status !== 0) { console.error("✗ ingestion échouée"); process.exit(1); }
}

(async () => {
  // 1. DB absente (clone frais sans data/) → base neuve au schéma complet.
  if (!fs.existsSync(DB)) {
    console.log(`data/cortex.db absente → création d'une base neuve (schéma complet db/tables.ts).`);
    if (!YES) { console.log("(dry-run — relance avec --yes)"); process.exit(0); }
    fs.mkdirSync(path.dirname(DB), { recursive: true });
    const d = new BetterSqlite3(DB);
    for (const stmt of allDdl("sqlite")) d.exec(stmt);
    d.close();
    if (INGEST) runIngest();
    console.log("✓ Base neuve prête.");
    process.exit(0);
  }

  // 2. Diagnostic.
  const diag = integrity(DB);
  if (diag === "ok") {
    console.log("✓ data/cortex.db est SAINE (integrity_check ok) — rien à réparer.");
    if (INGEST) runIngest();
    process.exit(0);
  }
  console.log(`✗ data/cortex.db CORROMPUE :\n   ${diag.split(" | ").slice(0, 4).join("\n   ")}`);

  if (!sqlite3CliAvailable()) {
    console.error("\nLe binaire `sqlite3` (CLI) est requis pour la récupération (.recover).");
    console.error("macOS : il est fourni par le système ; Linux : apt install sqlite3.");
    process.exit(1);
  }

  if (!YES) {
    console.log("\nDRY-RUN — la réparation ferait :");
    console.log("  1. backup de data/cortex.db{,-wal,-shm} → data/backup-corrupt-<date>/");
    console.log("  2. sqlite3 .recover → nouvelle base + rebuild de l'index FTS5");
    console.log("  3. remplacement de data/cortex.db (WAL/SHM purgés)");
    console.log("  4. npm run ingest (corpus canonique) si --ingest");
    console.log("\nRelance avec --yes (ou --yes --ingest). ⚠ Ferme d'abord le serveur dev.");
    process.exit(2);
  }

  // 3. Backup (copie, pas déplacement).
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const bak = path.join(process.cwd(), "data", `backup-corrupt-${stamp}`);
  fs.mkdirSync(bak, { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = DB + suffix;
    if (fs.existsSync(f)) fs.copyFileSync(f, path.join(bak, path.basename(f)));
  }
  console.log(`✓ Backup → ${path.relative(process.cwd(), bak)}/`);

  // 4. Récupération (le CLI lit db+wal ; .recover extrait tout ce qui est lisible).
  const recovered = DB + ".recovered";
  try { fs.unlinkSync(recovered); } catch {}
  const dump = execFileSync("sqlite3", [DB, ".recover"], { maxBuffer: 1024 * 1024 * 512, timeout: 300_000 });
  execFileSync("sqlite3", [recovered], { input: dump, maxBuffer: 1024 * 1024 * 64, timeout: 300_000 });
  const dr = new BetterSqlite3(recovered);
  try { dr.exec(`INSERT INTO fts_items(fts_items) VALUES('rebuild')`); } catch { /* fts absente : recréée par ingest */ }
  dr.close();
  const check = integrity(recovered);
  if (check !== "ok") { console.error(`✗ La base récupérée n'est pas saine (${check.slice(0, 120)}) — rien n'a été remplacé.`); process.exit(1); }

  // 5. Swap.
  for (const suffix of ["-wal", "-shm"]) { try { fs.unlinkSync(DB + suffix); } catch {} }
  fs.renameSync(recovered, DB);
  console.log("✓ data/cortex.db remplacée par la version récupérée (integrity ok).");

  // 6. Comptes utilisateur préservés (info).
  const d = new BetterSqlite3(DB, { readonly: true });
  for (const t of ["schedule", "weaknesses", "exams", "exam_refs", "items"]) {
    try { console.log(`   ${t}: ${(d.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n}`); } catch {}
  }
  d.close();

  if (INGEST) runIngest();
  else console.log("\n→ Termine par : npm run ingest   (corpus canonique + FTS)");
  console.log("✓ Réparation terminée.");
})();
