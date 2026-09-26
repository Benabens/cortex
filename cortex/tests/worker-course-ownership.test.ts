/**
 * Lot 1b/3 — défense en profondeur côté worker : scripts/run-job.ts installait
 * le cours reçu en argument sans vérifier qu'il appartient encore à
 * l'utilisateur du job (cours supprimé ou transféré entre-temps). Le worker
 * doit marquer le job en erreur, SANS remboursement, et ne rien générer.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-worker-own-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.BILLING_ENABLED = "1";
process.env.SIGNUP_FREE_CREDITS = "10";
process.env.DAILY_GEN_QUOTA = "unlimited";
process.env.RATE_LIMIT_PER_USER_MIN = "unlimited";
process.env.MAX_ACTIVE_JOBS = "unlimited";

before(async () => {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
after(() => {
  for (const k of ["CORTEX_DATA_DIR", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS", "DAILY_GEN_QUOTA", "RATE_LIMIT_PER_USER_MIN", "MAX_ACTIVE_JOBS"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("le worker refuse un cours qui n'appartient pas à l'utilisateur du job : erreur, pas de remboursement", async () => {
  const jobs = await import("../lib/jobs");
  const credits = await import("../lib/billing/credits");
  const { runWithUser } = await import("../db/context");
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  // Le propriétaire (owner) crée et paie un job sur ml…
  const { id } = await runWithCourse("ml", () => jobs.createJobExclusive("qcm"));
  const paid = await credits.getBalanceCenti("owner");
  // …mais le worker démarre pour un compte qui ne possède pas ml (cours transféré/supprimé entre-temps).
  const ok = await runWithUser("usr_intrus", () => runWithCourse("ml", () => jobs.assertJobCourseOwned(id, "ml")));
  assert.equal(ok, false);
  const row = await runWithCourse("ml", () => q.get<{ status: string; error: string | null }>(`SELECT status, error FROM jobs WHERE id = ?`, id));
  assert.equal(row?.status, "error");
  assert.match(row?.error ?? "", /cours/i);
  assert.equal(await credits.getBalanceCenti("owner"), paid, "aucun remboursement");
  // Le propriétaire légitime passe.
  const { id: id2 } = await runWithCourse("algo", () => jobs.createJobExclusive("qcm"));
  assert.equal(await runWithCourse("algo", () => jobs.assertJobCourseOwned(id2, "algo")), true);
});

test("scripts/run-job.ts appelle la vérification avant tout travail", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "run-job.ts"), "utf8");
  assert.match(src, /assertJobCourseOwned\(/);
  assert.ok(src.indexOf("assertJobCourseOwned(") < src.indexOf('job.type === "ingest"'), "la vérification doit précéder le dispatch des jobs");
});
