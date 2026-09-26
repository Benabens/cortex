/**
 * SUPPRESSION DE COMPTE (RGPD) — le test le plus important : effacer le compte A
 * n'enlève RIEN à B, ni en base, ni sur le disque, ni dans les schémas tenant.
 *
 * Postgres réel in-process (PGlite) pour l'isolation schema-per-tenant ;
 * fichiers dans un CORTEX_DATA_DIR jetable.
 *
 * Couvre : effacement complet de A (lignes globales + schémas tenant + fichiers),
 * anonymisation de llm_usage (tokens/coût gardés, user_id retiré), B intact,
 * idempotence d'un 2ᵉ appel, refus de supprimer le propriétaire.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-del-"));
process.env.CORTEX_DATA_DIR = tmp; // AVANT tout import (dataRoot figé au chargement)
process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";
delete process.env.CORTEX_USER;
delete process.env.CORTEX_OWNER_EMAIL;
delete process.env.CORTEX_OWNER_USER_ID;

// Imports DYNAMIQUES : lib/courses fige dataRoot() au CHARGEMENT du module, et un
// import statique serait hoisté AU-DESSUS du process.env.CORTEX_DATA_DIR ci-dessus
// → dataRoot() pointerait sur ./data au lieu du tmp jetable.
let runWithCourse: typeof import("../db/client").runWithCourse;
let runWithUser: typeof import("../db/context").runWithUser;
let userSlug: typeof import("../db/context").userSlug;
let tenantSchema: typeof import("../db/context").tenantSchema;
let q: typeof import("../db/q").q;
let authAll: typeof import("../db/auth-store").authAll;
let authGet: typeof import("../db/auth-store").authGet;
let authRun: typeof import("../db/auth-store").authRun;
let deleteAccount: typeof import("../lib/account-deletion").deleteAccount;

before(async () => {
  ({ runWithCourse } = await import("../db/client"));
  ({ runWithUser, userSlug, tenantSchema } = await import("../db/context"));
  ({ q } = await import("../db/q"));
  ({ authAll, authGet, authRun } = await import("../db/auth-store"));
  ({ deleteAccount } = await import("../lib/account-deletion"));
});

after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  for (const k of ["DB_DRIVER", "DATABASE_URL", "CORTEX_DATA_DIR", "CORTEX_OWNER_EMAIL", "CORTEX_OWNER_USER_ID", "AUTH_ENABLED", "AUTH_SECRET"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Crée un utilisateur complet : ligne users + account OAuth + cours possédé +
 *  gen_events + credit_transactions + llm_usage + un tenant peuplé + des fichiers. */
async function seedUser(id: string, email: string, course: string) {
  await authRun(`INSERT INTO users (id, email, name) VALUES (?,?,?)`, id, email, id);
  await authRun(`INSERT INTO accounts (provider, provider_account_id, user_id, type) VALUES (?,?,?,?)`, "google", `g-${id}`, id, "oauth");
  await authRun(`INSERT INTO courses (id, owner_user_id, name, short, created_at) VALUES (?,?,?,?,?)`, `${id}-${course}`, id, "Cours", "C", "2026-01-01");
  await authRun(`INSERT INTO gen_events (user_id, bucket, kind, course, day, created_at) VALUES (?,?,?,?,?,?)`, id, "gen", "exam", course, "2026-01-01", "2026-01-01 00:00:00");
  await authRun(`INSERT INTO credit_transactions (user_id, delta, reason, ref, created_at) VALUES (?,?,?,?,?)`, id, 10, "signup", `signup:${id}`, "2026-01-01 00:00:00");
  await authRun(`INSERT INTO llm_usage (user_id, course, provider, model, tokens_in, tokens_out, cost_usd, created_at) VALUES (?,?,?,?,?,?,?,?)`, id, course, "anthropic", "claude-sonnet-5", 1000, 500, 0.7, "2026-01-01 00:00:00");
  // Tables de facturation/réservation ajoutées par le durcissement : elles portent aussi l'identité.
  await authRun(`INSERT INTO active_jobs (user_id, course, job_ref, created_at) VALUES (?,?,?,?)`, id, course, `job:${id}:${course}:x`, "2026-01-01 00:00:00");
  await authRun(`INSERT INTO stripe_purchases (session_id, payment_intent, user_id, credits_centi, created_at) VALUES (?,?,?,?,?)`, `cs_${id}`, `pi_${id}`, id, 1000, "2026-01-01 00:00:00");
  // tenant peuplé (crée le schéma t_<slug>_<course> + une donnée)
  await runWithUser(id, () => runWithCourse(course, () => q.run(`INSERT INTO weaknesses (topic, severity) VALUES (?, ?)`, `secret-de-${id}`, 3)));
  // fichiers de l'utilisateur : data/u/<slug>/...
  const dir = path.join(tmp, "u", userSlug(id), course, "exams");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "exam-1.pdf"), `pdf de ${id}`);
}

async function schemaExists(userId: string, course: string): Promise<boolean> {
  const name = runWithUser(userId, () => runWithCourse(course, () => tenantSchema()));
  const rows = await authAll<{ n: number }>(
    `SELECT count(*) n FROM information_schema.schemata WHERE schema_name = ?`, name,
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

test("supprimer A efface TOUT le sien (lignes, schéma, fichiers) et ne touche RIEN de B", async () => {
  await seedUser("alice", "alice@example.com", "ml");
  await seedUser("bob", "bob@example.com", "ml");
  const slugA = userSlug("alice");
  const slugB = userSlug("bob");

  assert.ok(await schemaExists("alice", "ml"), "sanity : schéma d'alice créé");
  assert.ok(fs.existsSync(path.join(tmp, "u", slugA)), "sanity : dossier d'alice créé");

  const res = await deleteAccount("alice");
  assert.equal(res.deleted, true);
  assert.ok(res.schemasDropped >= 1, "au moins le schéma ml d'alice est droppé");

  // — A : tout effacé —
  assert.equal((await authGet<{ n: number }>(`SELECT count(*) n FROM users WHERE id = ?`, "alice"))!.n, 0);
  assert.equal((await authGet<{ n: number }>(`SELECT count(*) n FROM accounts WHERE user_id = ?`, "alice"))!.n, 0);
  assert.equal((await authGet<{ n: number }>(`SELECT count(*) n FROM courses WHERE owner_user_id = ?`, "alice"))!.n, 0);
  assert.equal((await authGet<{ n: number }>(`SELECT count(*) n FROM gen_events WHERE user_id = ?`, "alice"))!.n, 0);
  assert.equal((await authGet<{ n: number }>(`SELECT count(*) n FROM credit_transactions WHERE user_id = ?`, "alice"))!.n, 0);
  assert.equal((await authGet<{ n: number }>(`SELECT count(*) n FROM tenants WHERE user_id = ?`, "alice"))!.n, 0);
  assert.equal((await authGet<{ n: number }>(`SELECT count(*) n FROM active_jobs WHERE user_id = ?`, "alice"))!.n, 0, "places de jobs effacées");
  assert.equal((await authGet<{ n: number }>(`SELECT count(*) n FROM stripe_purchases WHERE user_id = ?`, "alice"))!.n, 0, "achats Stripe détachés du compte");
  assert.equal(await schemaExists("alice", "ml"), false, "le schéma tenant d'alice est droppé");
  assert.equal(fs.existsSync(path.join(tmp, "u", slugA)), false, "les fichiers d'alice sont effacés");
  // llm_usage : anonymisé (ligne gardée, plus reliée à alice)
  assert.equal((await authGet<{ n: number }>(`SELECT count(*) n FROM llm_usage WHERE user_id = ?`, "alice"))!.n, 0, "plus aucune ligne llm_usage au nom d'alice");

  // — B : strictement intact —
  assert.equal((await authGet<{ n: number }>(`SELECT count(*) n FROM users WHERE id = ?`, "bob"))!.n, 1);
  assert.equal((await authGet<{ n: number }>(`SELECT count(*) n FROM accounts WHERE user_id = ?`, "bob"))!.n, 1);
  assert.equal((await authGet<{ n: number }>(`SELECT count(*) n FROM courses WHERE owner_user_id = ?`, "bob"))!.n, 1);
  assert.equal((await authGet<{ n: number }>(`SELECT count(*) n FROM credit_transactions WHERE user_id = ?`, "bob"))!.n, 1);
  assert.equal((await authGet<{ n: number }>(`SELECT count(*) n FROM llm_usage WHERE user_id = ?`, "bob"))!.n, 1);
  assert.equal((await authGet<{ n: number }>(`SELECT count(*) n FROM active_jobs WHERE user_id = ?`, "bob"))!.n, 1);
  assert.equal((await authGet<{ n: number }>(`SELECT count(*) n FROM stripe_purchases WHERE user_id = ?`, "bob"))!.n, 1);
  assert.ok(await schemaExists("bob", "ml"), "le schéma tenant de bob est intact");
  const bobRows = await runWithUser("bob", () => runWithCourse("ml", () => q.all<{ topic: string }>(`SELECT topic FROM weaknesses`)));
  assert.deepEqual(bobRows.map((r) => r.topic), ["secret-de-bob"], "les données tenant de bob sont intactes");
  assert.ok(fs.existsSync(path.join(tmp, "u", slugB, "ml", "exams", "exam-1.pdf")), "les fichiers de bob sont intacts");
});

test("llm_usage anonymisé : tokens et coût conservés, user_id retiré", async () => {
  // alice supprimée au test précédent : sa ligne llm_usage doit survivre, anonymisée.
  const rows = await authAll<{ user_id: string; tokens_in: number; cost_usd: number }>(
    `SELECT user_id, tokens_in, cost_usd FROM llm_usage WHERE tokens_in = 1000 AND cost_usd = 0.7 AND user_id <> ?`, "bob",
  );
  assert.equal(rows.length, 1, "la ligne d'usage d'alice est conservée");
  assert.notEqual(rows[0].user_id, "alice", "user_id n'est plus alice");
  assert.equal(Number(rows[0].tokens_in), 1000, "tokens conservés");
  assert.ok(Math.abs(Number(rows[0].cost_usd) - 0.7) < 1e-9, "coût conservé");
});

test("idempotent : un 2ᵉ appel ne jette pas et ne fait rien", async () => {
  const res = await deleteAccount("alice");
  assert.equal(res.deleted, false, "déjà supprimé → no-op");
  assert.equal(res.schemasDropped, 0);
  // bob toujours là
  assert.equal((await authGet<{ n: number }>(`SELECT count(*) n FROM users WHERE id = ?`, "bob"))!.n, 1);
});

test("refus de supprimer le propriétaire (CORTEX_OWNER_EMAIL)", async () => {
  await seedUser("chief", "owner@cortex.app", "ml");
  process.env.CORTEX_OWNER_EMAIL = "owner@cortex.app";
  const { isOwnerAccount } = await import("../lib/account-deletion");
  assert.equal(await isOwnerAccount("chief"), true, "chief est reconnu propriétaire");
  assert.equal(await isOwnerAccount("bob"), false, "bob n'est pas propriétaire");
  delete process.env.CORTEX_OWNER_EMAIL;
});

test("route : refuse sans session (401) et ne supprime QUE le compte de la session (self-only)", async () => {
  process.env.AUTH_ENABLED = "1";
  process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "test-secret";
  const { POST } = await import("../app/api/account/delete/route");
  const { NextRequest } = await import("next/server");
  const mk = (headers: Record<string, string>, body: unknown) =>
    new NextRequest("http://localhost/api/account/delete", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  // Sans en-tête de session (posé par le proxy après auth) → 401.
  const r401 = await POST(mk({}, { confirm: "SUPPRIMER" }));
  assert.equal(r401.status, 401, "sans session → 401");

  // carol (session) tente, via le corps, de cibler dave : le corps est ignoré,
  // seul le compte de la SESSION est supprimé.
  await seedUser("carol", "carol@example.com", "ml");
  await seedUser("dave", "dave@example.com", "ml");
  const rOk = await POST(mk({ "x-cortex-user": "carol", origin: "http://localhost" }, { confirm: "SUPPRIMER", userId: "dave" }));
  assert.equal(rOk.status, 200, "carol supprime son propre compte");
  assert.equal((await authGet<{ n: number }>(`SELECT count(*) n FROM users WHERE id = ?`, "carol"))!.n, 0, "carol supprimée");
  assert.equal((await authGet<{ n: number }>(`SELECT count(*) n FROM users WHERE id = ?`, "dave"))!.n, 1, "dave (ciblé dans le corps) est INTACT");

  // Corps démesuré (Content-Length menteur) → 413 par la garde commune, rien supprimé.
  const huge = new NextRequest("http://localhost/api/account/delete", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cortex-user": "dave", origin: "http://localhost", "content-length": "5" },
    body: JSON.stringify({ confirm: "SUPPRIMER", pad: "x".repeat(2 * 1024 * 1024) }),
  });
  assert.equal((await POST(huge)).status, 413, "corps > 1 Mio → 413");
  assert.equal((await authGet<{ n: number }>(`SELECT count(*) n FROM users WHERE id = ?`, "dave"))!.n, 1, "dave intact après le 413");

  // Confirmation manquante → 400 (pas de suppression en un clic).
  const r400 = await POST(mk({ "x-cortex-user": "dave", origin: "http://localhost" }, {}));
  assert.equal(r400.status, 400, "sans le mot de confirmation → 400");
  assert.equal((await authGet<{ n: number }>(`SELECT count(*) n FROM users WHERE id = ?`, "dave"))!.n, 1, "dave toujours là");
  delete process.env.AUTH_ENABLED;
});
