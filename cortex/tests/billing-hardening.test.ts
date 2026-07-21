/**
 * Durcissement post-review (déploiement v1) — chaque test verrouille UN finding
 * confirmé par la review adversariale :
 *  1. INVARIANT DEV €0 : sans aucune env, aucune écriture de comptage.
 *  2. Ref de débit scopée par UTILISATEUR (ids de jobs séquentiels par tenant).
 *  3. Gate de crédits au VRAI coût du type (exam = 2, pas 1).
 *  4. Isolation disque des artefacts par utilisateur (fuite/écrasement inter-users).
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-harden-"));
process.env.CORTEX_DATA_DIR = tmp;

let credits: typeof import("../lib/billing/credits");
let guards: typeof import("../lib/billing/guards");
let courses: typeof import("../lib/courses");
let ctx: typeof import("../db/context");

before(async () => {
  for (const k of ["BILLING_ENABLED", "DAILY_GEN_QUOTA", "DAILY_ASSIST_QUOTA", "AUTH_ENABLED", "DB_DRIVER"]) delete process.env[k];
  credits = await import("../lib/billing/credits");
  guards = await import("../lib/billing/guards");
  courses = await import("../lib/courses");
  ctx = await import("../db/context");
});

after(() => {
  for (const k of ["CORTEX_DATA_DIR", "BILLING_ENABLED", "DAILY_GEN_QUOTA", "AUTH_ENABLED", "DB_DRIVER"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("INVARIANT dev €0 : sans quota ni facturation, recordGeneration n'écrit RIEN (pas même auth.db)", async () => {
  await guards.recordGeneration("gen", "exam");
  await guards.recordGeneration("assist", "drill");
  // Le store d'auth ne doit pas avoir été créé par un simple usage local.
  assert.equal(fs.existsSync(path.join(tmp, "auth.db")), false, "auth.db créé alors qu'aucun garde-fou n'est actif");

  // Dès qu'un quota EST posé, le comptage reprend (le garde-fou en a besoin).
  process.env.DAILY_GEN_QUOTA = "3";
  await guards.recordGeneration("gen", "exam");
  assert.equal(await guards.usedToday("gen"), 1);
  delete process.env.DAILY_GEN_QUOTA;
});

test("ref de débit scopée par user : deux tenants avec le même id de job sont débités CHACUN", async () => {
  process.env.BILLING_ENABLED = "1";
  process.env.SIGNUP_FREE_CREDITS = "5";

  // Postgres : chaque tenant a sa propre séquence → les deux users ont un job #1.
  const refA = credits.jobRef("alice", "ml", 1);
  const refB = credits.jobRef("bob", "ml", 1);
  assert.notEqual(refA, refB, "la ref doit distinguer les utilisateurs");

  await ctx.runWithUser("alice", () => credits.debitGeneration("exam", refA));
  await ctx.runWithUser("bob", () => credits.debitGeneration("exam", refB));
  assert.equal(await credits.getBalance("alice"), 3); // 5 - 2
  assert.equal(await credits.getBalance("bob"), 3);   // 5 - 2, PAS sauté

  // Le remboursement d'alice ne touche pas bob.
  await ctx.runWithUser("alice", () => credits.refundGeneration("exam", refA, "alice"));
  assert.equal(await credits.getBalance("alice"), 5);
  assert.equal(await credits.getBalance("bob"), 3);
  delete process.env.SIGNUP_FREE_CREDITS;
});

test("gate de crédits : le coût du TYPE est exigé (exam = 2), pas le minimum", async () => {
  process.env.BILLING_ENABLED = "1";
  process.env.SIGNUP_FREE_CREDITS = "1";
  const solde1 = await credits.getBalance("carol"); // 1 crédit
  assert.equal(solde1, 1);
  await ctx.runWithUser("carol", async () => {
    // Un examen coûte 2 : 1 crédit ne suffit PAS.
    const gateExam = await credits.creditsGate("exam");
    assert.ok(gateExam && gateExam.status === 402, "exam à 2 crédits doit être refusé avec 1 crédit");
    assert.match(gateExam!.error, /génération à 2/);
    // Un QCM coûte 1 : ça passe.
    assert.equal(await credits.creditsGate("qcm"), null);
  });
  delete process.env.SIGNUP_FREE_CREDITS;
});

test("artefacts isolés par utilisateur en multi-user ; chemins historiques intacts en mono-user", () => {
  // Mono-user (dev €0) : chemins historiques, AUCUN segment utilisateur.
  const solo = courses.coursePaths("ml");
  assert.ok(!solo.examsDir.includes(`${path.sep}u${path.sep}`), "le dev mono-user ne doit pas être scopé");
  assert.equal(solo.examsDir, path.join(tmp, "ml", "exams"));

  // Multi-user : deux users → deux dossiers d'examens DISTINCTS (sinon
  // exam-1.pdf de l'un écrase celui de l'autre, ids séquentiels par tenant).
  process.env.AUTH_ENABLED = "1";
  const a = ctx.runWithUser("alice", () => courses.coursePaths("ml"));
  const b = ctx.runWithUser("bob", () => courses.coursePaths("ml"));
  assert.notEqual(a.examsDir, b.examsDir);
  assert.notEqual(a.uploadsDir, b.uploadsDir);
  assert.ok(a.examsDir.includes(path.join("u", "alice")));
  assert.ok(b.examsDir.includes(path.join("u", "bob")));
  // La bibliothèque d'annales du cours reste PARTAGÉE (choix produit assumé).
  assert.equal(a.refsDir, b.refsDir);
  // La DB du cours reste au même endroit (l'isolation y est faite par schéma).
  assert.equal(a.dbPath, b.dbPath);
  delete process.env.AUTH_ENABLED;
});
