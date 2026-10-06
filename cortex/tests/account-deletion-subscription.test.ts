/**
 * SUPPRESSION DE COMPTE ET ABONNEMENT. Un compte ne s'efface pas en laissant
 * derrière lui un abonnement que Stripe tient encore pour vivant : en retard de
 * paiement, Stripe relance la carte pendant des semaines et débiterait un compte
 * qui n'existe plus. L'abonnement est donc résilié chez Stripe AVANT tout
 * effacement, quel que soit son état tant qu'il n'est pas terminé. Un abonnement
 * que Stripe ne connaît plus (déjà résilié, ou créé avec les clés de test avant
 * le passage en live) n'a rien à résilier et ne bloque pas le droit à l'effacement.
 * Seam : deleteAccount(userId, { cancelSubscription }). PGlite en mémoire.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-delsub-"));
process.env.CORTEX_DATA_DIR = tmp; // avant tout import : dataRoot est figé au chargement
process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
delete process.env.CORTEX_USER;
delete process.env.CORTEX_OWNER_EMAIL;
delete process.env.CORTEX_OWNER_USER_ID;

let authGet: typeof import("../db/auth-store").authGet;
let authRun: typeof import("../db/auth-store").authRun;
let deleteAccount: typeof import("../lib/account-deletion").deleteAccount;

before(async () => {
  ({ authGet, authRun } = await import("../db/auth-store"));
  ({ deleteAccount } = await import("../lib/account-deletion"));
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["CORTEX_DATA_DIR", "DB_DRIVER", "DATABASE_URL"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function seed(user: string, status: string): Promise<void> {
  await authRun(`INSERT INTO users (id, email, name) VALUES (?,?,?)`, user, `${user}@example.com`, user);
  await authRun(
    `INSERT INTO subscriptions (user_id, customer_id, subscription_id, status, plan, monthly_credits, remaining, period_end, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    user, `cus_${user}`, `sub_${user}`, status, "cortex_pro_monthly", 2000, 0, "2026-10-28 10:00:00", "2026-09-28 10:00:00",
  );
}
const exists = async (user: string) => Number((await authGet<{ n: number }>(`SELECT count(*) n FROM users WHERE id = ?`, user))?.n ?? 0) === 1;

test("abonnement encore vivant chez Stripe (en règle, en retard, impayé, en pause, incomplet) : résilié avant l'effacement", async () => {
  for (const status of ["active", "trialing", "past_due", "unpaid", "paused", "incomplete"]) {
    const user = `del-${status}`;
    await seed(user, status);
    const canceled: string[] = [];
    const res = await deleteAccount(user, { cancelSubscription: async (id) => { canceled.push(id); return {}; } });
    assert.deepEqual(canceled, [`sub_${user}`], `${status} : l'abonnement est résilié chez Stripe`);
    assert.equal(res.deleted, true, status);
  }
});

test("abonnement terminé : rien à résilier, le compte s'efface", async () => {
  for (const status of ["canceled", "incomplete_expired"]) {
    const user = `gone-${status}`;
    await seed(user, status);
    let calls = 0;
    const res = await deleteAccount(user, { cancelSubscription: async () => { calls++; return {}; } });
    assert.equal(calls, 0, status);
    assert.equal(res.deleted, true, status);
  }
});

test("résiliation impossible : rien n'est effacé", async () => {
  await seed("del-fails", "past_due");
  await assert.rejects(deleteAccount("del-fails", { cancelSubscription: async () => { throw new Error("Stripe indisponible"); } }), /Rien n’a été effacé/);
  assert.equal(await exists("del-fails"), true);
});

test("abonnement inconnu de Stripe (déjà résilié, ou créé en mode test) : l'effacement n'est pas bloqué", async () => {
  await seed("del-missing", "active");
  const missing = Object.assign(new Error("No such subscription: 'sub_del-missing'"), { code: "resource_missing" });
  const res = await deleteAccount("del-missing", { cancelSubscription: async () => { throw missing; } });
  assert.equal(res.deleted, true);
  assert.equal(await exists("del-missing"), false);
});
