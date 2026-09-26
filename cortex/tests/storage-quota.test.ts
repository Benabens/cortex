/**
 * I3 — Quota de stockage par utilisateur et garde d'espace libre du volume :
 * le total occupé par ses fichiers (data/u/<slug>/…) ne dépasse pas
 * STORAGE_QUOTA_MB (défaut 200), et aucun envoi n'est accepté si le volume a
 * moins de 10 % d'espace libre. Refus 413 avec un message clair, AVANT de lire
 * ou d'écrire quoi que ce soit.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-quota-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.AUTH_ENABLED = "0";
process.env.STORAGE_QUOTA_MB = "1";
const MiB = 1024 * 1024;

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
after(async () => {
  const { setStatfsForTests } = await import("../lib/storage-quota");
  setStatfsForTests(null);
  for (const k of ["CORTEX_DATA_DIR", "AUTH_ENABLED", "STORAGE_QUOTA_MB"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("userStorageBytes : somme des fichiers sous data/u/<slug>/ (et rien d'autre)", async () => {
  const { userStorageBytes } = await import("../lib/storage-quota");
  const { userSlug } = await import("../db/context");
  const mine = path.join(tmp, "u", userSlug("owner"), "ml", "exams");
  const other = path.join(tmp, "u", userSlug("quelqu-un-d-autre"), "ml", "exams");
  fs.mkdirSync(mine, { recursive: true }); fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(mine, "a.pdf"), Buffer.alloc(300 * 1024));
  fs.writeFileSync(path.join(mine, "b.pdf"), Buffer.alloc(200 * 1024));
  fs.writeFileSync(path.join(other, "c.pdf"), Buffer.alloc(900 * 1024));
  assert.equal(await userStorageBytes("owner"), 500 * 1024);
});

test("checkStorage : sous le quota → null ; envoi qui ferait dépasser → 413 clair ; volume presque plein → 413", async () => {
  const { checkStorage, setStatfsForTests } = await import("../lib/storage-quota");
  setStatfsForTests(() => ({ free: 80 * 1024 * MiB, total: 100 * 1024 * MiB })); // 80 % libre
  assert.equal(await checkStorage("owner", 100 * 1024), null); // 500 Kio + 100 Kio < 1 Mio
  const r = await checkStorage("owner", 600 * 1024); // 500 + 600 > 1024 Kio
  assert.ok(r && r.status === 413, JSON.stringify(r));
  assert.match(r!.error, /1 Mo/);
  assert.match(r!.error, /libère|supprime/i);
  setStatfsForTests(() => ({ free: 5 * 1024 * MiB, total: 100 * 1024 * MiB })); // 5 % libre
  const full = await checkStorage("owner", 10);
  assert.ok(full && full.status === 413);
  assert.match(full!.error, /espace/i);
  setStatfsForTests(null);
});

test("routes d'envoi : refs/upload refuse en 413 quand le quota est atteint, sans écrire le fichier", async () => {
  const { setStatfsForTests } = await import("../lib/storage-quota");
  setStatfsForTests(() => ({ free: 80 * 1024 * MiB, total: 100 * 1024 * MiB }));
  const { POST } = await import("../app/api/refs/upload/route");
  const boundary = "----cortexQuota";
  const payload = Buffer.alloc(700 * 1024, 0x41);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="gros.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    payload, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const req = new NextRequest("http://cortex.test/api/refs/upload?course=ml", {
    method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(body.length) }, body,
  });
  const res = await POST(req);
  assert.equal(res.status, 413, await res.text());
  assert.ok(!fs.existsSync(path.join(tmp, "ml", "refs", "gros.pdf")), "rien n'a été écrit");
  setStatfsForTests(null);
});
