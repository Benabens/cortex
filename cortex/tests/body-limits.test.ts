/**
 * Lot 1b/1 — la borne d'envoi ne fait plus confiance au Content-Length
 * déclaré : les octets RÉELS sont comptés pendant la lecture et la lecture
 * s'arrête au plafond (413), pour le multipart comme pour le JSON.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
process.env.UPLOAD_MAX_MB = "1"; // plafond « refs » abaissé pour le test (lu au chargement de lib/upload-limit)

type Init = ConstructorParameters<typeof NextRequest>[1];
const MiB = 1024 * 1024;

/** Corps multipart de `sizeBytes` octets servi par un flux qui compte ce qu'on lui a lu. */
function lyingMultipart(sizeBytes: number, declared: string, url = "http://cortex.test/api/x?course=cs-202") {
  const boundary = "----cortexLiar";
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const chunk = new Uint8Array(64 * 1024).fill(0x41);
  let sent = 0;
  let fed = 0;
  const total = sizeBytes;
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode(head)); },
    pull(c) {
      if (sent >= total) { c.enqueue(new TextEncoder().encode(tail)); c.close(); return; }
      const n = Math.min(chunk.length, total - sent);
      sent += n; fed += n;
      c.enqueue(chunk.subarray(0, n));
    },
  });
  const headers = new Headers({ "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": declared });
  const req = new NextRequest(url, { method: "POST", headers, body: stream, duplex: "half" } as Init);
  return { req, read: () => fed };
}

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  delete process.env.DB_DRIVER; delete process.env.DATABASE_URL; delete process.env.UPLOAD_MAX_MB;
});

test("multipart : Content-Length: 10 mais 5 Mo réels → 413, lecture arrêtée au plafond", async () => {
  const { readFormData, PayloadTooLarge } = await import("../lib/upload-limit");
  const { req, read } = lyingMultipart(5 * MiB, "10");
  await assert.rejects(() => readFormData(req, 1 * MiB), (e: unknown) => e instanceof PayloadTooLarge);
  assert.ok(read() <= 1 * MiB + 128 * 1024, `octets lus au-delà du plafond : ${read()}`);
});

test("multipart : un corps honnête sous le plafond est parsé", async () => {
  const { readFormData } = await import("../lib/upload-limit");
  const { req } = lyingMultipart(100 * 1024, String(100 * 1024 + 200));
  const form = await readFormData(req, 1 * MiB);
  const f = form.get("file");
  assert.ok(f instanceof File && f.size === 100 * 1024);
});

test("routes multipart : le menteur reçoit 413 sur refs/upload (plafond 1 Mo) et sources (plafond 32 Mo)", async () => {
  const refs = await import("../app/api/refs/upload/route");
  const sources = await import("../app/api/sources/route");
  const a = await refs.POST(lyingMultipart(5 * MiB, "10").req);
  assert.equal(a.status, 413, await a.text());
  const big = lyingMultipart(33 * MiB, "10");
  const b = await sources.POST(big.req);
  assert.equal(b.status, 413, await b.text());
  assert.ok(big.read() <= 32 * MiB + 128 * 1024, `octets lus au-delà du plafond : ${big.read()}`);
});

test("JSON : 3 Mo de JSON avec Content-Length: 5 → 413 (plafond 1 Mo), lecture arrêtée", async () => {
  const { readJson, PayloadTooLarge } = await import("../lib/upload-limit");
  let fed = 0;
  const piece = new TextEncoder().encode(`"${"x".repeat(1023)}",`);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode("[")); },
    pull(c) {
      if (sent >= 3 * MiB) { c.enqueue(new TextEncoder().encode('""]')); c.close(); return; }
      sent += piece.length; fed += piece.length; c.enqueue(piece);
    },
  });
  const req = new NextRequest("http://cortex.test/api/x", { method: "POST", headers: { "content-type": "application/json", "content-length": "5" }, body: stream, duplex: "half" } as Init);
  await assert.rejects(() => readJson(req, {}), (e: unknown) => e instanceof PayloadTooLarge);
  assert.ok(fed <= MiB + 64 * 1024, `octets lus : ${fed}`);
  // Un JSON invalide sous le plafond rend le repli, comme l'ancien `.catch(() => repli)`.
  const bad = new NextRequest("http://cortex.test/api/x", { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" } as Init);
  assert.deepEqual(await readJson(bad, { fallback: true }), { fallback: true });
});

test("routes JSON : check-solution avec 3 Mo de JSON → 413", async () => {
  const mod = await import("../app/api/check-solution/route");
  const big = JSON.stringify({ statement: "y".repeat(3 * MiB), answer: "z" });
  const req = new NextRequest("http://cortex.test/api/x?course=cs-202", { method: "POST", headers: { "content-type": "application/json", "content-length": "5" }, body: big, duplex: "half" } as Init);
  const res = await mod.POST(req);
  assert.equal(res.status, 413, await res.text());
});

test("aucune route ne lit plus un corps sans plafond", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const offenders: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "route.ts" && /req\.(json|text|formData)\(\)/.test(fs.readFileSync(p, "utf8"))) offenders.push(path.relative(path.join(__dirname, ".."), p));
    }
  };
  walk(path.join(__dirname, "..", "app"));
  assert.deepEqual(offenders, [], `lectures non bornées : ${offenders.join(", ")}`);
});
