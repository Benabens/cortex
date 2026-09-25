/**
 * Durcissement post-review — chaque test verrouille UN finding
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
let reserve: typeof import("../lib/billing/reserve");

before(async () => {
  for (const k of ["BILLING_ENABLED", "DAILY_GEN_QUOTA", "DAILY_ASSIST_QUOTA", "AUTH_ENABLED", "DB_DRIVER"]) delete process.env[k];
  credits = await import("../lib/billing/credits");
  guards = await import("../lib/billing/guards");
  courses = await import("../lib/courses");
  ctx = await import("../db/context");
  reserve = await import("../lib/billing/reserve");
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

  await ctx.runWithUser("alice", () => reserve.reserveGeneration({ bucket: "gen", kind: "exam", ref: refA }));
  await ctx.runWithUser("bob", () => reserve.reserveGeneration({ bucket: "gen", kind: "exam", ref: refB }));
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

// ─── 2ᵉ vague : failles trouvées par la vérification adversariale des correctifs ───

test("dev €0 : usedToday NE crée PAS le store (chemin /api/billing sans aucune env)", async () => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-dev0-"));
  const saved = process.env.CORTEX_DATA_DIR;
  process.env.CORTEX_DATA_DIR = probe;
  for (const k of ["BILLING_ENABLED", "DAILY_GEN_QUOTA", "DAILY_ASSIST_QUOTA"]) delete process.env[k];
  try {
    // C'est exactement ce que fait GET /api/billing, inconditionnellement.
    assert.equal(await guards.usedToday("gen"), 0);
    assert.equal(await guards.usedToday("assist"), 0);
    const créés = fs.readdirSync(probe);
    assert.deepEqual(créés, [], `le dev €0 a créé ${JSON.stringify(créés)}`);
  } finally {
    process.env.CORTEX_DATA_DIR = saved;
  }
});

test("annulation : remboursée AVANT travail, PAS après (sinon générations gratuites illimitées)", async () => {
  process.env.BILLING_ENABLED = "1";
  process.env.SIGNUP_FREE_CREDITS = "10";
  const jobs = await import("../lib/jobs");
  const { runWithCourse } = await import("../db/client");

  // Le contexte {user, cours} doit être le MÊME au débit et au remboursement :
  // la ref en dépend (c'est précisément ce que verrouille ce test).
  await ctx.runWithUser("dave", () => runWithCourse("ml", async () => {
    const solde0 = await credits.getBalance("dave"); // 10
    // (a) annulation immédiate (job en file, 0 % fait) → remboursé
    const refA = credits.jobRef("dave", "ml", 100);
    await reserve.reserveGeneration({ bucket: "gen", kind: "exam", ref: refA });
    assert.equal(await credits.getBalance("dave"), solde0 - 2);
    await jobs.refundJobCredits({ id: 100, type: "exam" });
    assert.equal(await credits.getBalance("dave"), solde0);

    // (b) le remboursement rend le montant DÉBITÉ même si le tarif a changé
    const refB = credits.jobRef("dave", "ml", 101);
    await reserve.reserveGeneration({ bucket: "gen", kind: "exam", ref: refB }); // -2 au tarif courant
    process.env.CREDITS_COST_JSON = '{"exam":9}';           // hausse de tarif
    await credits.refundGeneration("exam", refB, "dave");
    assert.equal(await credits.getBalance("dave"), solde0, "le remboursement doit rendre 2, pas 9");
    delete process.env.CREDITS_COST_JSON;
  }));
  delete process.env.SIGNUP_FREE_CREDITS;
});

test("assistance : coût 0 mais solde épuisé → 402 (pas d'appels LLM gratuits à l'infini)", async () => {
  process.env.BILLING_ENABLED = "1";
  process.env.SIGNUP_FREE_CREDITS = "0";
  await ctx.runWithUser("erin", async () => {
    assert.equal(await credits.getBalance("erin"), 0);
    const gate = await credits.creditsGate("assist");
    assert.ok(gate && gate.status === 402, "un solde à 0 doit couper l'assistance");
  });
  // avec du solde, l'assistance passe et ne débite rien
  process.env.SIGNUP_FREE_CREDITS = "3";
  await ctx.runWithUser("frank", async () => {
    assert.equal(await credits.creditsGate("assist"), null);
    assert.equal(await credits.getBalance("frank"), 3);
  });
  delete process.env.SIGNUP_FREE_CREDITS;
});

test("identifiants : deux comptes qui tronquent pareil ont des schémas ET des dossiers DISTINCTS", () => {
  const a = "etudiant.exemple@grande-ecole-polytechnique.example.com";
  const b = "etudiant.exemple@grande-ecole-polytechnique.example.org";
  assert.notEqual(ctx.userSlug(a), ctx.userSlug(b));
  assert.notEqual(ctx.tenantSchema(a, "cs-202"), ctx.tenantSchema(b, "cs-202"));
  assert.ok(ctx.tenantSchema(a, "cs-202").length < 63, "identifiant Postgres trop long");

  process.env.AUTH_ENABLED = "1";
  const dirA = ctx.runWithUser(a, () => courses.coursePaths("ml").examsDir);
  const dirB = ctx.runWithUser(b, () => courses.coursePaths("ml").examsDir);
  assert.notEqual(dirA, dirB);
  // La normalisation disque et la normalisation base doivent CONCORDER.
  assert.ok(dirA.includes(ctx.userSlug(a)), "le dossier doit utiliser le même slug que le schéma");
  delete process.env.AUTH_ENABLED;
});
