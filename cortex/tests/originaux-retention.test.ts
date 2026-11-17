/**
 * FIN DU PREMIUM ET QUOTA D'INDEX (décision de Ben du 17/11/2026). Un compte qui n'est plus
 * Premium garde ses originaux dans le cloud 30 jours après la fin, puis ils sont supprimés : leur
 * index reste, le fichier pourra être renvoyé depuis l'ordinateur. Un compte gratuit est borné par
 * la taille de son index (ses originaux ne restent pas). Seams : sweepAccount, originalsNotice,
 * checkIndexQuota, putUpload. Vrai script d'ingestion, cours fictif, aucun réseau.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { textPdf } from "./helpers/pdf";
import { ingest, newCourse, sourcePaths } from "./helpers/ingest-course";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-retention-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";
process.env.BILLING_ENABLED = "1";
process.env.STORAGE_QUOTA_MB = "unlimited";
process.env.ORIGINALS_PURGE = "1";
delete process.env.CORTEX_OWNER_EMAIL;
delete process.env.CORTEX_OWNER_USER_ID;

const KEYS = ["CORTEX_DATA_DIR", "MAX_COURSES_CREATED_PER_HOUR", "BILLING_ENABLED", "STORAGE_QUOTA_MB", "INDEX_QUOTA_MB", "ORIGINALS_PURGE"];
after(() => {
  for (const k of KEYS) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const DAY_MS = 86400_000;
const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 19).replace("T", " ");
const USER = "owner"; // propriétaire des cours de tests/helpers/ingest-course, pas le propriétaire de l'instance

let retention: typeof import("../lib/originals/retention");
let registry: typeof import("../lib/originals/registry");
before(async () => {
  retention = await import("../lib/originals/retention");
  registry = await import("../lib/originals/registry");
  const { authRun } = await import("../db/auth-store");
  // Règle en vigueur depuis longtemps : seule la fin du Premium décide de l'échéance.
  await authRun(`INSERT INTO app_meta (key, value) VALUES ('originals_rule_since', '2026-01-01 00:00:00') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
});

async function inCourse<T>(course: string, fn: () => Promise<T>): Promise<T> {
  const { runWithCourse } = await import("../db/client");
  return runWithCourse(course, fn);
}

async function pay(id: string, paidAt: string) {
  const { recordPayment } = await import("../lib/billing/revenue");
  await recordPayment({ sourceId: `cs_${id}`, kind: "pack", paymentIntent: `pi_${id}`, userId: USER, currency: "eur", amountCents: 900, feeCents: 40, paidAt });
}

/** Un support rangé dans le cloud du temps du Premium (écrit comme avant la règle), puis indexé. */
async function cloudSource(name: string): Promise<{ id: string; file: string }> {
  const c = await newCourse(`Retention ${name}`);
  const file = path.join(c.contentRoot, "lectures", `${name}.pdf`);
  const { storage } = await import("../lib/storage");
  await storage().put(file, textPdf(`Le cours ${name} sur les spectres`));
  const r = ingest(c.id);
  assert.equal(r.status, 0, r.output);
  return { id: c.id, file };
}

test("purge non armée (sans ORIGINALS_PURGE=1) : rien n'est annoncé ni supprimé du cloud", async () => {
  await pay("unarmed", at(400)); // Premium fini depuis 35 jours
  const { file } = await cloudSource("unarmed");
  delete process.env.ORIGINALS_PURGE;
  try {
    assert.equal((await retention.originalsNotice(USER)).purgeOn, null);
    const r = await retention.sweepAccount(USER);
    assert.equal(r.cloudPurged, 0);
    assert.equal(fs.existsSync(file), true);
  } finally {
    process.env.ORIGINALS_PURGE = "1";
    const { authRun } = await import("../db/auth-store");
    await authRun(`DELETE FROM stripe_payments WHERE user_id = ?`, USER);
  }
});

test("Premium fini depuis moins de 30 jours : les originaux restent, la date de suppression est annoncée", async () => {
  await pay("recent", at(380)); // Premium jusqu'à il y a 15 jours
  const { id, file } = await cloudSource("recent");
  const notice = await retention.originalsNotice(USER);
  assert.equal(notice.home, "local");
  const expected = new Date(Date.now() + 15 * DAY_MS).toISOString().slice(0, 10);
  assert.equal(notice.purgeOn?.slice(0, 10), expected);
  await retention.sweepAccount(USER);
  assert.equal(fs.existsSync(file), true, "encore dans le délai de 30 jours");
  assert.deepEqual(await inCourse(id, () => registry.localOriginals()), []);
});

test("Premium fini depuis plus de 30 jours : originaux supprimés, index gardé, fichier renvoyable", async () => {
  const { authRun } = await import("../db/auth-store");
  await authRun(`DELETE FROM stripe_payments WHERE user_id = ?`, USER);
  await pay("old", at(400)); // Premium jusqu'à il y a 35 jours
  const { id, file } = await cloudSource("ancien");
  const r = await retention.sweepAccount(USER);
  assert.ok(r.cloudPurged >= 1, JSON.stringify(r));
  assert.equal(fs.existsSync(file), false);
  const row = await inCourse(id, () => registry.localOriginal("lectures/ancien.pdf"));
  assert.equal(row?.state, "local");
  assert.equal(row?.origin, "purge");
  assert.match(row?.sha256 ?? "", /^[0-9a-f]{64}$/, "empreinte gardée : le même fichier pourra revenir");
  const again = ingest(id);
  assert.equal(again.status, 0, again.output);
  assert.deepEqual(await sourcePaths(id), ["lectures/ancien.pdf"], "l'index reste");

  const { returnOriginal } = await import("../lib/originals/intake");
  const back = await inCourse(id, () => returnOriginal(id, "lectures/ancien.pdf", textPdf("Le cours ancien sur les spectres")));
  assert.deepEqual(back, { ok: true, home: "local" }, "gratuit : revient en transit, pour une préparation");
  const other = await inCourse(id, () => returnOriginal(id, "lectures/ancien.pdf", textPdf("Un autre fichier")));
  assert.equal(other.ok, false);
});

test("quota d'index : un compte gratuit qui l'a rempli ne dépose plus ; Premium n'est pas concerné", async () => {
  const quota = await import("../lib/originals/index-quota");
  process.env.INDEX_QUOTA_MB = "1";
  try {
    await quota.recordIndexUsage(USER, "cours-plein", 2 * 1024 * 1024);
    const refused = await quota.checkIndexQuota(USER);
    assert.equal(refused?.status, 413);
    assert.match(refused?.error ?? "", /Index plein : 2 Mo de texte indexé sur 1 Mo/);
    process.env.BILLING_ENABLED = "";
    assert.equal(await quota.checkIndexQuota(USER), null);
  } finally {
    process.env.BILLING_ENABLED = "1";
    delete process.env.INDEX_QUOTA_MB;
  }
});

test("pièce jointe d'un gratuit (photo de copie) : en transit, supprimée après 24 h", async () => {
  const c = await newCourse("Retention photo");
  const { coursePaths } = await import("../lib/courses");
  const photo = path.join(coursePaths(c.id).uploadsDir, "copie.png");
  const { putUpload } = await import("../lib/originals/intake");
  await inCourse(c.id, () => putUpload(c.id, photo, Buffer.from("png")));
  assert.equal((await inCourse(c.id, () => registry.localOriginal("uploads/copie.png")))?.state, "transit");
  await retention.sweepAccount(USER);
  assert.equal(fs.existsSync(photo), true, "lue par le modèle dans la journée");
  await retention.sweepAccount(USER, at(-2));
  assert.equal(fs.existsSync(photo), false);
  assert.equal(await inCourse(c.id, () => registry.localOriginal("uploads/copie.png")), null);
});
