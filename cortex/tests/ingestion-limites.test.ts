/**
 * AUDIT FUITES DU 17/11, I9 — l'import n'avait ni délai, ni plafond de mémoire, ni limite de
 * pages, dans le même conteneur que le site : un PDF piégé (bombe de décompression, boucle)
 * pouvait tenir le CPU ou la mémoire jusqu'à faire tomber tout le monde. Désormais :
 *  - au dépôt, un PDF de plus de PDF_MAX_PAGES pages est refusé (413), avec quoi faire ;
 *  - le process d'import a un tas plafonné (INGEST_MAX_HEAP_MB) et un délai (INGEST_TIMEOUT_MS)
 *    au-delà duquel il est tué ; il reste dans le groupe du worker, qu'une annulation tue.
 *
 * Seams : lib/document-check unreadableDocument, lib/ingest-limits.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";

after(() => { for (const k of ["PDF_MAX_PAGES"]) delete process.env[k]; });

/** PDF minimal de `pages` pages vides. */
function pdfWithPages(pages: number): Buffer {
  const kids = Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(" ");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    ...Array.from({ length: pages }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"),
  ];
  let out = "%PDF-1.4\n";
  const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("I9 : un PDF au-delà de PDF_MAX_PAGES pages est refusé au dépôt (413), avec quoi faire", async () => {
  process.env.PDF_MAX_PAGES = "3";
  const { unreadableDocument } = await import("../lib/document-check");
  assert.equal(await unreadableDocument(pdfWithPages(3), ".pdf"), null);
  const refused = await unreadableDocument(pdfWithPages(4), ".pdf");
  assert.equal(refused?.status, 413);
  assert.match(refused!.message, /4 pages/);
  assert.match(refused!.message, /découpe/i);
});

test("I9 : import qui ne finit pas — tué au bout du délai", async () => {
  const { spawnBounded } = await import("../lib/ingest-limits");
  const started = Date.now();
  const run = spawnBounded(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 800, maxHeapMb: 256 });
  const r = await run.done;
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 5000, "arrêté au délai");
  assert.equal(alive(run.child.pid!), false);
});

test("I9 : l'import reste dans le groupe du worker — annuler le job (kill du groupe) l'arrête aussi", async () => {
  const { spawnBounded } = await import("../lib/ingest-limits");
  const { pgidOf } = await import("../lib/process-group");
  const run = spawnBounded(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 10_000, maxHeapMb: 256 });
  try {
    const mine = pgidOf(process.pid);
    assert.ok(mine !== null);
    assert.equal(pgidOf(run.child.pid!), mine, "même groupe que le process qui l'a lancé");
  } finally {
    run.child.kill("SIGKILL");
    await run.done;
  }
});

test("I9 : le tas du process d'import est plafonné (INGEST_MAX_HEAP_MB)", async () => {
  const { spawnBounded } = await import("../lib/ingest-limits");
  const run = spawnBounded(process.execPath, ["-e", "console.log(require('node:v8').getHeapStatistics().heap_size_limit)"], { timeoutMs: 10_000, maxHeapMb: 300 });
  let out = "";
  run.child.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
  const r = await run.done;
  assert.equal(r.code, 0);
  assert.equal(r.timedOut, false);
  const mb = Number(out.trim()) / (1024 * 1024);
  assert.ok(mb > 250 && mb < 400, `plafond observé : ${mb} Mo`);
});

test("I9 : un NODE_OPTIONS existant est gardé, seul le plafond de tas est remplacé", async () => {
  const { withHeapCap } = await import("../lib/ingest-limits");
  const env = withHeapCap({ NODE_OPTIONS: "--enable-source-maps --max-old-space-size=8192" }, 512);
  assert.equal(env.NODE_OPTIONS, "--enable-source-maps --max-old-space-size=512");
  assert.equal(withHeapCap({}, 512).NODE_OPTIONS, "--max-old-space-size=512");
});
