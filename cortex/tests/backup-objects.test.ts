/**
 * SAUVEGARDE DES OBJETS DU SEAU (lib/backup-objects) — le seau de fichiers
 * (Railway Buckets) n'a ni versionnage ni corbeille : la sauvegarde quotidienne
 * en garde une copie dans le stockage de sauvegarde (BACKUP_S3_*).
 *  - copie incrémentale par empreinte : un contenu n'est envoyé qu'une fois,
 *    un objet inchangé n'est même pas relu ;
 *  - chaque sauvegarde porte l'index du seau à son instant (objects.json) ;
 *  - un objet supprimé du seau reste restaurable tant qu'une sauvegarde retenue
 *    (14 j) le cite ; ensuite son contenu est effacé ;
 *  - la restauration vérifie chaque empreinte.
 */
import assert from "node:assert/strict";
import { after, test } from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createBackup } from "../lib/backup";
import { backupS3Config, listRemoteBackups, pruneBackups, pushBackup } from "../lib/backup-s3";
import { pruneBlobs, readRemoteIndex, restoreObjects, snapshotObjects, verifyRemoteObjects } from "../lib/backup-objects";
import { fakeBucket } from "./helpers/fake-bucket";

const tmps: string[] = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });
function mkTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmps.push(d);
  return d;
}

const cfg = backupS3Config({
  BACKUP_S3_ENDPOINT: "https://backup.example.test", BACKUP_S3_BUCKET: "cortex-backups",
  BACKUP_S3_ACCESS_KEY_ID: "k", BACKUP_S3_SECRET_ACCESS_KEY: "s",
})!;
const quiet = { log: () => {} };
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** Seau de fichiers (source) : quelques objets sous le préfixe « prod/ ». */
async function filesBucket(objects: Record<string, string>) {
  const f = fakeBucket();
  for (const [k, v] of Object.entries(objects)) await f.bucket.put(`prod/${k}`, Buffer.from(v));
  return f;
}

test("une capture copie chaque contenu une fois dans le stockage de sauvegarde ; la restauration rend les mêmes octets", async () => {
  const source = await filesBucket({ "u/ben/ml/refs/final.pdf": "%PDF-final", "u/ben/ml/exams/exam-1.pdf": "%PDF-exam" });
  const backup = fakeBucket();
  const snap = await snapshotObjects({ source: source.bucket, sourcePrefix: "prod/", store: backup.bucket, cfg, ...quiet });

  assert.deepEqual(snap.index.objects.map((o) => [o.key, o.size, o.sha256]).sort(), [
    ["u/ben/ml/exams/exam-1.pdf", 9, sha("%PDF-exam")],
    ["u/ben/ml/refs/final.pdf", 10, sha("%PDF-final")],
  ]);
  assert.deepEqual([...backup.objects.keys()].sort(), [
    `cortex/_objets/${sha("%PDF-exam").slice(0, 2)}/${sha("%PDF-exam")}`,
    `cortex/_objets/${sha("%PDF-final").slice(0, 2)}/${sha("%PDF-final")}`,
  ].sort(), "contenu rangé par empreinte, hors des dossiers de sauvegarde");

  const dest = mkTmp("cortex-objrestore-");
  const r = await restoreObjects({ store: backup.bucket, cfg, index: snap.index, toDir: dest, ...quiet });
  assert.equal(r.restored, 2);
  assert.equal(fs.readFileSync(path.join(dest, "u/ben/ml/refs/final.pdf"), "utf8"), "%PDF-final");
  assert.equal(fs.readFileSync(path.join(dest, "u/ben/ml/exams/exam-1.pdf"), "utf8"), "%PDF-exam");
});

test("incrémental : rien n'est relu ni renvoyé si le seau n'a pas bougé ; un contenu déjà connu n'est jamais renvoyé", async () => {
  const source = await filesBucket({ "u/ben/ml/refs/a.pdf": "%PDF-a", "u/ben/ml/refs/b.pdf": "%PDF-b" });
  const backup = fakeBucket();
  const day1 = await snapshotObjects({ source: source.bucket, sourcePrefix: "prod/", store: backup.bucket, cfg, ...quiet });
  const reads = () => source.calls.filter((c) => c.startsWith("stream ")).length;
  const before = reads();

  const day2 = await snapshotObjects({ source: source.bucket, sourcePrefix: "prod/", store: backup.bucket, cfg, previous: day1.index, ...quiet });
  assert.deepEqual([day2.downloaded, day2.uploaded, reads() - before], [0, 0, 0]);
  assert.deepEqual(day2.index, day1.index);

  // b.pdf modifié ; c.pdf est une copie de a.pdf sous une autre clé.
  source.objects.get("prod/u/ben/ml/refs/b.pdf")!.at = new Date(Date.now() + 60_000);
  source.objects.get("prod/u/ben/ml/refs/b.pdf")!.body = Buffer.from("%PDF-b2");
  await source.bucket.put("prod/u/ben/ml/refs/c.pdf", Buffer.from("%PDF-a"));
  const day3 = await snapshotObjects({ source: source.bucket, sourcePrefix: "prod/", store: backup.bucket, cfg, previous: day2.index, ...quiet });
  assert.equal(day3.downloaded, 2, "b (modifié) et c (nouveau) relus, a non");
  assert.equal(day3.uploaded, 1, "seul le nouveau contenu de b part ; c réutilise celui de a");
  assert.equal(day3.index.objects.find((o) => o.key === "u/ben/ml/refs/c.pdf")?.sha256, sha("%PDF-a"));
});

test("un objet supprimé du seau reste restaurable 14 j, puis son contenu est effacé avec la dernière sauvegarde qui le cite", async () => {
  const DAY = 86_400_000;
  const t0 = new Date("2026-11-01T03:00:00Z");
  const clock = { now: t0 };
  const backup = fakeBucket(clock);
  const source = await filesBucket({ "u/ben/ml/refs/a.pdf": "%PDF-a", "u/ben/ml/refs/b.pdf": "%PDF-b" });
  const dataDir = mkTmp("cortex-objdata-");
  fs.writeFileSync(path.join(dataDir, "auth.db"), "db");

  /** La sauvegarde du jour, comme le planificateur : capture, dossier local, envoi. */
  async function daily(previous: Awaited<ReturnType<typeof snapshotObjects>>["index"] | null) {
    const snap = await snapshotObjects({ source: source.bucket, sourcePrefix: "prod/", store: backup.bucket, cfg, previous, ...quiet });
    const { dir } = await createBackup({
      dataDir, backupDir: mkTmp("cortex-objout-"), dbDriver: "sqlite", now: clock.now, log: () => {},
      objectStore: { location: "s3://cortex-files/prod/", inBucket: () => false, index: snap.index },
    });
    return { ...(await pushBackup(backup.bucket, cfg, dir, quiet)), index: snap.index };
  }

  const day0 = await daily(null);
  await source.bucket.remove(["prod/u/ben/ml/refs/b.pdf"]); // supprimé par l'utilisateur le 1er
  clock.now = new Date(t0.getTime() + DAY);
  const day1 = await daily(day0.index);
  assert.deepEqual(day1.index.objects.map((o) => o.key), ["u/ben/ml/refs/a.pdf"]);
  assert.deepEqual((await listRemoteBackups(backup.bucket, cfg)).map((b) => b.folder).sort(), [day0.folder, day1.folder].sort(),
    "le dossier des contenus n'est jamais pris pour une sauvegarde");

  // Le 11 : b se restaure encore depuis la sauvegarde du 1er.
  clock.now = new Date(t0.getTime() + 10 * DAY);
  assert.deepEqual(await pruneBackups(backup.bucket, cfg, clock.now, quiet), []);
  const old = await readRemoteIndex(backup.bucket, cfg, day0.folder);
  const dest = mkTmp("cortex-objrestore-");
  await restoreObjects({ store: backup.bucket, cfg, index: old!, toDir: dest, ...quiet });
  assert.equal(fs.readFileSync(path.join(dest, "u/ben/ml/refs/b.pdf"), "utf8"), "%PDF-b");

  // Le 17 : la sauvegarde du 1er expire, et avec elle le contenu de b ; celui de a reste cité.
  clock.now = new Date(t0.getTime() + 16 * DAY);
  assert.deepEqual(await pruneBackups(backup.bucket, cfg, clock.now, quiet), [day0.folder]);
  const blobs = [...backup.objects.keys()].filter((k) => k.startsWith("cortex/_objets/"));
  assert.deepEqual(blobs, [`cortex/_objets/${sha("%PDF-a").slice(0, 2)}/${sha("%PDF-a")}`]);
  const latest = await readRemoteIndex(backup.bucket, cfg, day1.folder);
  const dest2 = mkTmp("cortex-objrestore-");
  assert.equal((await restoreObjects({ store: backup.bucket, cfg, index: latest!, toDir: dest2, ...quiet })).restored, 1);
});

test("vérification : un contenu absent ou altéré du stockage de sauvegarde est signalé, et la restauration refuse une empreinte fausse", async () => {
  const source = await filesBucket({ "u/ben/ml/refs/a.pdf": "%PDF-a", "u/ben/ml/refs/b.pdf": "%PDF-b" });
  const backup = fakeBucket();
  const { index } = await snapshotObjects({ source: source.bucket, sourcePrefix: "prod/", store: backup.bucket, cfg, ...quiet });
  assert.deepEqual(await verifyRemoteObjects({ store: backup.bucket, cfg, index, ...quiet }), { objects: 2, missing: [] });

  const blobA = `cortex/_objets/${sha("%PDF-a").slice(0, 2)}/${sha("%PDF-a")}`;
  const blobB = `cortex/_objets/${sha("%PDF-b").slice(0, 2)}/${sha("%PDF-b")}`;
  backup.objects.delete(blobB);
  assert.deepEqual(await verifyRemoteObjects({ store: backup.bucket, cfg, index, ...quiet }), { objects: 2, missing: ["u/ben/ml/refs/b.pdf"] });

  backup.objects.get(blobA)!.body = Buffer.from("%PDF-x"); // même taille, autre contenu
  await assert.rejects(
    restoreObjects({ store: backup.bucket, cfg, index: { version: 1, objects: index.objects.filter((o) => o.key.endsWith("a.pdf")) }, toDir: mkTmp("cortex-objrestore-"), ...quiet }),
    /empreinte.*u\/ben\/ml\/refs\/a\.pdf/,
  );
});

test("restauration : une clé d'index qui sortirait du dossier cible est refusée", async () => {
  const backup = fakeBucket();
  const evil = { version: 1 as const, objects: [{ key: "../../evil.txt", size: 1, sha256: sha("x"), lastModified: new Date().toISOString() }] };
  await backup.bucket.put(`cortex/_objets/${sha("x").slice(0, 2)}/${sha("x")}`, Buffer.from("x"));
  const dest = mkTmp("cortex-objrestore-");
  // Cible à deux niveaux sous un dossier jetable : même un échec de la garde n'écrirait que dans `dest`.
  await assert.rejects(restoreObjects({ store: backup.bucket, cfg, index: evil, toDir: path.join(dest, "a", "cible"), ...quiet }), /clé invalide/);
  assert.equal(fs.existsSync(path.join(dest, "evil.txt")), false);
});

test("restauration vers un seau de fichiers neuf : mêmes clés sous son préfixe, mêmes octets", async () => {
  const source = await filesBucket({ "u/ben/ml/refs/a.pdf": "%PDF-a", "u/ben/ml/exams/e.pdf": "%PDF-e" });
  const backup = fakeBucket();
  const { index } = await snapshotObjects({ source: source.bucket, sourcePrefix: "prod/", store: backup.bucket, cfg, ...quiet });
  const fresh = fakeBucket();
  const r = await restoreObjects({ store: backup.bucket, cfg, index, toBucket: { bucket: fresh.bucket, prefix: "neuf/" }, ...quiet });
  assert.equal(r.restored, 2);
  assert.deepEqual([...fresh.objects.keys()].sort(), ["neuf/u/ben/ml/exams/e.pdf", "neuf/u/ben/ml/refs/a.pdf"]);
  assert.equal(fresh.objects.get("neuf/u/ben/ml/refs/a.pdf")?.body.toString(), "%PDF-a");
  assert.equal(fresh.objects.get("neuf/u/ben/ml/refs/a.pdf")?.contentType, "application/pdf");
});

test("14 j comptés depuis la suppression : un objet supprimé juste avant la sauvegarde suivante reste restaurable 14 j pleins", async () => {
  const DAY = 86_400_000;
  const HOUR = 3_600_000;
  const t0 = new Date("2026-11-01T03:00:00Z");
  const clock = { now: t0 };
  const backup = fakeBucket(clock);
  const source = await filesBucket({ "u/ben/ml/refs/a.pdf": "%PDF-a", "u/ben/ml/refs/b.pdf": "%PDF-b" });
  const dataDir = mkTmp("cortex-objdata-");
  fs.writeFileSync(path.join(dataDir, "auth.db"), "db");
  async function daily(previous: Awaited<ReturnType<typeof snapshotObjects>>["index"] | null) {
    const snap = await snapshotObjects({ source: source.bucket, sourcePrefix: "prod/", store: backup.bucket, cfg, previous, ...quiet });
    const { dir } = await createBackup({
      dataDir, backupDir: mkTmp("cortex-objout-"), dbDriver: "sqlite", now: clock.now, log: () => {},
      objectStore: { location: "s3://cortex-files/prod/", inBucket: () => false, index: snap.index },
    });
    return { ...(await pushBackup(backup.bucket, cfg, dir, quiet)), index: snap.index };
  }
  const day0 = await daily(null);
  const deletedAt = t0.getTime() + 23 * HOUR; // supprimé une heure avant la sauvegarde du lendemain
  await source.bucket.remove(["prod/u/ben/ml/refs/b.pdf"]);
  let prev = day0.index;
  for (let d = 1; d <= 14; d++) {
    clock.now = new Date(t0.getTime() + d * DAY);
    prev = (await daily(prev)).index;
    await pruneBackups(backup.bucket, cfg, clock.now, quiet);
  }
  // 14 j moins une heure après la suppression : b est encore cité par une sauvegarde retenue.
  const justBefore = new Date(deletedAt + 14 * DAY - HOUR);
  clock.now = justBefore;
  await pruneBackups(backup.bucket, cfg, justBefore, quiet);
  const still = await readRemoteIndex(backup.bucket, cfg, day0.folder);
  assert.ok(still?.objects.some((o) => o.key === "u/ben/ml/refs/b.pdf"), "la sauvegarde d'avant la suppression est retenue");
  const dest = mkTmp("cortex-objrestore-");
  await restoreObjects({ store: backup.bucket, cfg, index: still!, toDir: dest, ...quiet });
  assert.equal(fs.readFileSync(path.join(dest, "u/ben/ml/refs/b.pdf"), "utf8"), "%PDF-b");
});

test("les marqueurs de dossier du seau (clé finissant par /) ne sont pas indexés : la restauration n'échoue pas dessus", async () => {
  const source = await filesBucket({ "u/ben/ml/refs/a.pdf": "%PDF-a" });
  await source.bucket.put("prod/u/ben/ml/refs/", Buffer.alloc(0));
  const backup = fakeBucket();
  const { index } = await snapshotObjects({ source: source.bucket, sourcePrefix: "prod/", store: backup.bucket, cfg, ...quiet });
  assert.deepEqual(index.objects.map((o) => o.key), ["u/ben/ml/refs/a.pdf"]);
  assert.equal((await restoreObjects({ store: backup.bucket, cfg, index, toDir: mkTmp("cortex-objrestore-"), ...quiet })).restored, 1);
});

test("un contenu déjà présent mais qu'aucune sauvegarde ne cite (orphelin ancien) est renvoyé : sa date repart, la rétention ne l'efface pas sous l'index du jour", async () => {
  const DAY = 86_400_000;
  const now = new Date("2026-11-20T03:00:00Z");
  const clock = { now: new Date(now.getTime() - 10 * DAY) };
  const backup = fakeBucket(clock);
  const orphan = `cortex/_objets/${sha("%PDF-a").slice(0, 2)}/${sha("%PDF-a")}`;
  await backup.bucket.put(orphan, Buffer.from("%PDF-a")); // reste d'une sauvegarde purgée, daté d'il y a 10 j
  clock.now = now;
  const source = await filesBucket({ "u/ben/ml/refs/a.pdf": "%PDF-a" });
  const snap = await snapshotObjects({ source: source.bucket, sourcePrefix: "prod/", store: backup.bucket, cfg, previous: null, ...quiet });
  assert.equal(snap.uploaded, 1);
  // Une purge concurrente, avant que l'index du jour ne soit envoyé, ne le voit pas encore cité.
  assert.equal(await pruneBlobs(backup.bucket, cfg, [], now, quiet), 0);
  assert.ok(backup.objects.has(orphan));
});
