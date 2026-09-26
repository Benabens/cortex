/**
 * LOT 4-1 — le nom de schéma d'un tenant DÉJÀ enregistré dans public.tenants
 * fait foi et n'est jamais réécrit : un changement de la règle de nommage
 * (identifiants > 28 caractères désormais suffixés d'un condensé) créait un
 * schéma vide et écrasait l'ancien nom dans le registre → données invisibles.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

process.env.DB_DRIVER = "postgres";
process.env.DATABASE_URL = "pglite://memory";

before(() => { delete process.env.CORTEX_USER; });
after(async () => {
  const { closePostgres } = await import("../db/driver-postgres");
  await closePostgres();
  delete process.env.DB_DRIVER; delete process.env.DATABASE_URL;
});

const COURSE = "analyse-des-systemes-de-communication-avancee";
const LEGACY = "t_u1_analyse_des_systemes_de_comm"; // ancienne troncature brute

test("tenant existant sous l'ancien nom : même schéma lu après mise à jour, aucune création, registre intact", async () => {
  const { authRun, authAll, authGet } = await import("../db/auth-store");
  const { runWithCourse } = await import("../db/client");
  const { runWithUser, tenantSchema } = await import("../db/context");
  const { q } = await import("../db/q");
  await authRun(`INSERT INTO tenants (user_id, course, schema_name, last_seen) VALUES (?,?,?,?)`, "u1", COURSE, LEGACY, "2026-01-01 00:00:00");
  await authRun(`CREATE SCHEMA "${LEGACY}"`);
  await authRun(`CREATE TABLE "${LEGACY}".weaknesses (id serial PRIMARY KEY, topic text NOT NULL, severity integer NOT NULL DEFAULT 2)`);
  await authRun(`INSERT INTO "${LEGACY}".weaknesses (topic) VALUES ('ancienne donnée')`);
  assert.notEqual(tenantSchema("u1", COURSE), LEGACY, "la règle de nommage a bien changé pour cet identifiant long");

  const n = await runWithUser("u1", () => runWithCourse(COURSE, async () => Number((await q.get<{ n: number }>(`SELECT count(*) n FROM weaknesses`))?.n)));
  assert.equal(n, 1, "les données de l'ancien schéma restent visibles");
  await runWithUser("u1", () => runWithCourse(COURSE, () => q.run(`INSERT INTO weaknesses (topic) VALUES (?)`, "nouvelle")));
  assert.equal(Number((await authGet<{ n: number }>(`SELECT count(*) n FROM "${LEGACY}".weaknesses`))?.n), 2, "les écritures vont dans l'ancien schéma");

  const reg = await authGet<{ schema_name: string }>(`SELECT schema_name FROM tenants WHERE user_id = ? AND course = ?`, "u1", COURSE);
  assert.equal(reg?.schema_name, LEGACY, "le registre n'est jamais réécrit");
  const schemas = await authAll<{ schema_name: string }>(`SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 't_u1_%'`);
  assert.deepEqual(schemas.map((s) => s.schema_name), [LEGACY], "aucun schéma parasite créé");
});

test("nouveau tenant : nom calculé par la règle courante, enregistré une fois", async () => {
  const { authGet } = await import("../db/auth-store");
  const { runWithCourse } = await import("../db/client");
  const { runWithUser, tenantSchema } = await import("../db/context");
  const { q } = await import("../db/q");
  await runWithUser("u2", () => runWithCourse(COURSE, () => q.get(`SELECT 1`)));
  const reg = await authGet<{ schema_name: string }>(`SELECT schema_name FROM tenants WHERE user_id = ? AND course = ?`, "u2", COURSE);
  assert.equal(reg?.schema_name, tenantSchema("u2", COURSE));
  assert.match(reg!.schema_name, /_[0-9a-f]{8}$/, "identifiant long → suffixe condensé");
});

test("4b-2 : registre injoignable (erreur autre que « table absente ») → la requête échoue, rien n'est créé ni mis en cache", async () => {
  const { setTenantRegistryLookupForTests } = await import("../db/driver-postgres");
  const { authAll } = await import("../db/auth-store");
  const { runWithCourse } = await import("../db/client");
  const { runWithUser } = await import("../db/context");
  const { q } = await import("../db/q");
  setTenantRegistryLookupForTests(async () => { throw new Error("timeout acquiring connection"); });
  try {
    await assert.rejects(runWithUser("u3", () => runWithCourse(COURSE, () => q.get(`SELECT 1`))), /timeout/);
  } finally { setTenantRegistryLookupForTests(null); }
  const schemas = await authAll<{ schema_name: string }>(`SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 't_u3_%'`);
  assert.deepEqual(schemas, [], "aucun schéma créé sur un repli");
  // Registre de nouveau joignable : le nom ENREGISTRÉ est lu (rien n'a été mis en cache entre-temps).
  const { authRun } = await import("../db/auth-store");
  await authRun(`INSERT INTO tenants (user_id, course, schema_name, last_seen) VALUES (?,?,?,?)`, "u3", COURSE, "t_u3_ancien", "2026-01-01 00:00:00");
  await authRun(`CREATE SCHEMA "t_u3_ancien"`);
  await runWithUser("u3", () => runWithCourse(COURSE, () => q.get(`SELECT 1`)));
  const after = await authAll<{ schema_name: string }>(`SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 't_u3_%'`);
  assert.deepEqual(after.map((s) => s.schema_name), ["t_u3_ancien"]);
});

test("4b-2 : table du registre absente (42P01, base neuve) → nom calculé, mis en cache", async () => {
  const { setTenantRegistryLookupForTests, resolveTenantSchema } = await import("../db/driver-postgres");
  const { tenantSchema } = await import("../db/context");
  let calls = 0;
  setTenantRegistryLookupForTests(async () => { calls++; throw Object.assign(new Error("relation tenants does not exist"), { code: "42P01" }); });
  try {
    assert.equal(await resolveTenantSchema("u4", COURSE), tenantSchema("u4", COURSE));
    assert.equal(await resolveTenantSchema("u4", COURSE), tenantSchema("u4", COURSE));
    assert.equal(calls, 1, "mis en cache");
  } finally { setTenantRegistryLookupForTests(null); }
});
