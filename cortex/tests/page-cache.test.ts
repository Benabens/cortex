/**
 * STOCKAGE — audit du 14/11/2026, 🔴 2 et 🟠 15.
 *
 * Images de pages : rendues UNE fois dans un cache (data/.page-cache/), hors du
 * dossier du compte (donc hors quota), hors sauvegarde, purgé au retrait de
 * l'annale et à la suppression du cours ; les rendus des anciennes versions
 * (refs/figref, refs/figref-full) sont retirés du compte au passage ; une image
 * posée à la main reste.
 *
 * Quota : base modeste pour un compte gratuit (STORAGE_QUOTA_MB, au plus 5 % du
 * volume), + 100 Mo par dollar de revenu net sur 12 mois, plafonné à 3 Go et à
 * 20 % du volume par compte ; le propriétaire a le plafond, borné par la place
 * utile du volume. Volume presque plein : le cache des pages est purgé d'abord.
 *
 * Seams : exam-index.renderExamPages, course-vision.renderCourseRefImages /
 * courseRefImages, sources.removeUploadedRef, course-deletion.deleteCourseWithData,
 * backup.createBackup, storage-quota.storageQuotaBytesFor / checkStorage.
 * pdftoppm réel sur des PDF minimaux (sauté s'il est absent).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-pagecache-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.AUTH_ENABLED = "1";
process.env.STORAGE_QUOTA_MB = "150";
process.env.STORAGE_QUOTA_MAX_MB = "3072";
process.env.STORAGE_QUOTA_MB_PER_USD = "100";
process.env.FX_USD_JSON = JSON.stringify({ eur: 1 });
process.env.CORTEX_OWNER_USER_ID = "boss";
delete process.env.CORTEX_USER;
const MiB = 1024 * 1024;

/** PDF minimal de `pages` pages. */
function pdf(pages: number): Buffer {
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(" ");
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    ...Array.from({ length: pages }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>")];
  let out = "%PDF-1.4\n";
  const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

let refsDir = "";
let userDir = "";
let hasPdftoppm = false;
const inCourse = async <T,>(fn: () => Promise<T> | T): Promise<T> => {
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  return runWithUser("alice", () => runWithCourse("pgcache", async () => fn()));
};
const pngsUnder = (dir: string): string[] => {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.png$/i.test(e.name)) out.push(p); } };
  walk(dir);
  return out;
};

before(async () => {
  const { findPdftoppm } = await import("../lib/pdftoppm");
  hasPdftoppm = !!findPdftoppm();
  const { authRun } = await import("../db/auth-store");
  const { userSlug } = await import("../db/context");
  const { ensureCoursesLoaded, reloadCourses, coursePaths } = await import("../lib/courses");
  await ensureCoursesLoaded();
  await authRun(`INSERT INTO users (id, email, name) VALUES (?,?,?)`, "alice", "alice@example.com", "Alice");
  const { insertCourse } = await import("../db/courses-store");
  await insertCourse({
    id: "pgcache", owner_user_id: "alice", name: "Pgcache", short: "PGC", code: null, exam_name: "Pgcache", exam_kind: "Final", university: null,
    university_lines: "[]", faculty: null, teachers: "[]", language: "fr", profile_id: null, duration_min: 120, exam_date: null,
    db_file: null, refs_rel: null, exams_rel: null, uploads_rel: null, content_rel: null, created_at: "2026-09-01 00:00:00",
  });
  await reloadCourses();
  refsDir = await inCourse(() => coursePaths("pgcache").refsDir);
  userDir = path.join(tmp, "u", userSlug("alice"));
  fs.mkdirSync(refsDir, { recursive: true });
  fs.writeFileSync(path.join(refsDir, "final 2024.pdf"), pdf(5));
  fs.writeFileSync(path.join(refsDir, "midterm.pdf"), pdf(2));
});
after(async () => {
  const { setStatfsForTests } = await import("../lib/storage-quota");
  setStatfsForTests(null);
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres?.();
  for (const k of ["CORTEX_DATA_DIR", "DB_DRIVER", "DATABASE_URL", "AUTH_ENABLED", "STORAGE_QUOTA_MB", "STORAGE_QUOTA_MAX_MB",
    "STORAGE_QUOTA_MB_PER_USD", "FX_USD_JSON", "CORTEX_OWNER_USER_ID"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("rendu des pages : dans le cache, hors du dossier du compte (hors quota), un seul rendu pour l'index et la vision", async (t) => {
  if (!hasPdftoppm) return t.skip("pdftoppm absent");
  // Rendus d'une ancienne version, dans le dossier du compte : régénérables, retirés au passage.
  fs.mkdirSync(path.join(refsDir, "figref-full"), { recursive: true });
  fs.mkdirSync(path.join(refsDir, "figref"), { recursive: true });
  fs.writeFileSync(path.join(refsDir, "figref-full", "final_2024-1.png"), Buffer.alloc(4096));
  fs.writeFileSync(path.join(refsDir, "figref", "final 2024-1.png"), Buffer.alloc(4096));
  fs.writeFileSync(path.join(refsDir, "figref", "schema-prof.png"), Buffer.alloc(100)); // posée à la main

  const { renderExamPages } = await import("../lib/exam-index");
  const { renderCourseRefImages, courseRefImages } = await import("../lib/course-vision");
  const { userStorageBytes } = await import("../lib/storage-quota");

  const pages = await inCourse(() => renderExamPages("pgcache", "final 2024.pdf"));
  assert.deepEqual(pages.map((p) => p.page), [1, 2, 3, 4, 5]);
  for (const p of pages) {
    const abs = path.resolve(p.rel);
    assert.ok(abs.startsWith(path.join(tmp, ".page-cache") + path.sep), abs);
    assert.ok(fs.existsSync(abs));
  }
  // La vision réutilise les mêmes images : rien de neuf pour « final 2024 », seulement « midterm » (2 pages).
  const before = pngsUnder(path.join(tmp, ".page-cache")).length;
  await inCourse(() => renderCourseRefImages("pgcache"));
  assert.equal(pngsUnder(path.join(tmp, ".page-cache")).length, before + 2);
  const imgs = await inCourse(() => courseRefImages());
  assert.ok(imgs.some((p) => p.endsWith("schema-prof.png")), "l'image posée à la main reste");
  assert.equal(imgs.filter((p) => /final_2024[^/]*-\d+\.png$/.test(p)).length, 3, "vision : les 3 premières pages");
  assert.equal(imgs.filter((p) => /midterm-\d+\.png$/.test(p)).length, 2);

  // Plus aucune image de page dans le dossier du compte (hors celle posée à la main).
  assert.deepEqual(pngsUnder(userDir).map((p) => path.basename(p)), ["schema-prof.png"]);
  const pdfBytes = fs.statSync(path.join(refsDir, "final 2024.pdf")).size + fs.statSync(path.join(refsDir, "midterm.pdf")).size;
  assert.equal(await userStorageBytes("alice"), pdfBytes + 100);
});

test("cache purgeable : supprimé, il est rendu à nouveau à la demande", async (t) => {
  if (!hasPdftoppm) return t.skip("pdftoppm absent");
  fs.rmSync(path.join(tmp, ".page-cache"), { recursive: true, force: true });
  const { courseRefImages } = await import("../lib/course-vision");
  const imgs = await inCourse(() => courseRefImages());
  assert.equal(imgs.filter((p) => /final_2024[^/]*-\d+\.png$/.test(p)).length, 3);
});

test("retrait d'une annale : ses images de pages sont purgées, celles des autres restent", async (t) => {
  if (!hasPdftoppm) return t.skip("pdftoppm absent");
  const { renderExamPages } = await import("../lib/exam-index");
  await inCourse(() => renderExamPages("pgcache", "final 2024.pdf"));
  await inCourse(() => renderExamPages("pgcache", "midterm.pdf"));
  const { removeUploadedRef } = await import("../lib/sources");
  const { q } = await import("../db/q");
  await inCourse(async () => {
    await q.run(`INSERT INTO exam_refs (path, title, year, kind, uploaded) VALUES (?,?,?,?,1)`, "refs/final 2024.pdf", "final 2024", 2024, "final");
    await removeUploadedRef("refs/final 2024.pdf");
  });
  const left = pngsUnder(path.join(tmp, ".page-cache")).map((p) => path.basename(p));
  assert.ok(!left.some((f) => f.startsWith("final_2024")), left.join(","));
  assert.ok(left.some((f) => f.startsWith("midterm-")));
});

test("annales aux noms voisins (« a b.pdf », « a_b.pdf ») : rendus distincts, retirer l'une garde l'autre", async (t) => {
  if (!hasPdftoppm) return t.skip("pdftoppm absent");
  fs.writeFileSync(path.join(refsDir, "a b.pdf"), pdf(2));
  fs.writeFileSync(path.join(refsDir, "a_b.pdf"), pdf(4));
  try {
    const { renderExamPages } = await import("../lib/exam-index");
    const { purgePdfPages } = await import("../lib/page-cache");
    assert.equal((await inCourse(() => renderExamPages("pgcache", "a b.pdf"))).length, 2);
    const other = await inCourse(() => renderExamPages("pgcache", "a_b.pdf"));
    assert.equal(other.length, 4, "les pages de « a b.pdf » ne passent pas pour celles de « a_b.pdf »");
    purgePdfPages("pgcache", "a b.pdf");
    assert.ok(other.every((p) => fs.existsSync(path.resolve(p.rel))), "retirer « a b.pdf » garde les pages de « a_b.pdf »");
  } finally {
    fs.rmSync(path.join(refsDir, "a b.pdf"), { force: true });
    fs.rmSync(path.join(refsDir, "a_b.pdf"), { force: true });
  }
});

test("volume presque plein : le cache des pages (régénérable) est purgé avant de refuser un envoi", async () => {
  const { setStatfsForTests, checkStorage } = await import("../lib/storage-quota");
  const root = path.join(tmp, ".page-cache");
  fs.mkdirSync(path.join(root, "u", "x"), { recursive: true });
  fs.writeFileSync(path.join(root, "u", "x", "p-1.png"), Buffer.alloc(10));
  // Mesure simulée : le volume ne repasse au-dessus de la marge qu'une fois le cache parti.
  setStatfsForTests(() => (fs.existsSync(root) ? { free: 50 * MiB, total: 10240 * MiB } : { free: 9000 * MiB, total: 10240 * MiB }));
  try {
    assert.equal(await checkStorage("alice", MiB), null);
    assert.equal(fs.existsSync(root), false);
  } finally { setStatfsForTests(null); }
});

test("sauvegarde : le cache n'est pas archivé", async () => {
  const dataDir = path.join(tmp, "backup-src");
  fs.mkdirSync(path.join(dataDir, ".page-cache", "u", "x"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, ".page-cache", "u", "x", "p-1.png"), Buffer.alloc(10));
  fs.writeFileSync(path.join(dataDir, "keep.txt"), "garde");
  const { createBackup } = await import("../lib/backup");
  const { dir } = await createBackup({ dataDir, backupDir: path.join(tmp, "backups"), dbDriver: "sqlite", log: () => {} });
  const list = execFileSync("tar", ["-tzf", path.join(dir, "data.tar.gz")], { encoding: "utf8" });
  assert.match(list, /keep\.txt/);
  assert.doesNotMatch(list, /page-cache/);
});

test("suppression du cours : son cache est purgé aussi", async (t) => {
  if (!hasPdftoppm) return t.skip("pdftoppm absent");
  const { renderExamPages } = await import("../lib/exam-index");
  const pages = await inCourse(() => renderExamPages("pgcache", "midterm.pdf"));
  const cacheDir = path.dirname(path.resolve(pages[0].rel));
  assert.ok(fs.existsSync(cacheDir));
  const { deleteCourseWithData } = await import("../lib/course-deletion");
  await deleteCourseWithData("alice", "pgcache");
  assert.equal(fs.existsSync(cacheDir), false);
});

test("quota lié au revenu : base modeste (≤ 5 % du volume), +100 Mo par dollar net, plafonné (3 Go, 20 % du volume) ; propriétaire au plafond", async () => {
  const { setStatfsForTests, storageQuotaBytesFor, checkStorage } = await import("../lib/storage-quota");
  const { recordPayment } = await import("../lib/billing/revenue");
  // Volume de 500 Mo (la prod) : base = min(150 Mo, 25 Mo).
  setStatfsForTests(() => ({ free: 400 * MiB, total: 500 * MiB }));
  assert.equal(await storageQuotaBytesFor("free-user"), 25 * MiB);
  // Volume de 10 Go : base 150 Mo ; 9 $ nets → +900 Mo.
  setStatfsForTests(() => ({ free: 9000 * MiB, total: 10240 * MiB }));
  assert.equal(await storageQuotaBytesFor("free-user"), 150 * MiB);
  await recordPayment({ sourceId: "cs_store", kind: "pack", paymentIntent: "pi_store", userId: "payer", currency: "eur", amountCents: 900, feeCents: 0 });
  assert.equal(await storageQuotaBytesFor("payer"), 1050 * MiB);
  await recordPayment({ sourceId: "cs_store2", kind: "pack", paymentIntent: "pi_store2", userId: "payer", currency: "eur", amountCents: 900_00, feeCents: 0 });
  // Un compte ne prend jamais plus de 20 % du volume (2 Go sur 10) : un payant ne remplit pas le disque de tous.
  assert.equal(await storageQuotaBytesFor("payer"), Math.floor(0.2 * 10240 * MiB));
  assert.equal(await storageQuotaBytesFor("boss"), 3072 * MiB);
  // Volume de 2 Go : 20 % pour un compte ; le propriétaire, la place utile (90 %).
  setStatfsForTests(() => ({ free: 1500 * MiB, total: 2048 * MiB }));
  assert.equal(await storageQuotaBytesFor("payer"), Math.floor(0.2 * 2048 * MiB));
  assert.equal(await storageQuotaBytesFor("boss"), Math.floor(0.9 * 2048 * MiB));
  // checkStorage applique le quota du compte : un payant envoie ce qu'un gratuit ne peut pas.
  setStatfsForTests(() => ({ free: 9000 * MiB, total: 10240 * MiB }));
  assert.equal((await checkStorage("free-user", 200 * MiB))?.status, 413);
  assert.equal(await checkStorage("payer", 200 * MiB), null);
});
