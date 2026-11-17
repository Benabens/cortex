import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * I8 — Un déploiement où AUTH_ENABLED a été oublié sert TOUT le monde comme
 * « owner ». Le boot de prod doit refuser de démarrer dès que l'instance est
 * manifestement une mise en ligne (NODE_ENV=production) ou encaisse de
 * l'argent (BILLING_ENABLED=1) sans authentification.
 */

test("I8 — production sans AUTH_ENABLED=1 → refus de démarrer", async () => {
  const { assertAuthRequired } = await import("../lib/boot-guards");
  assert.throws(() => assertAuthRequired({ NODE_ENV: "production" }), /AUTH_ENABLED/);
  assert.throws(() => assertAuthRequired({ NODE_ENV: "production", AUTH_ENABLED: "0" }), /AUTH_ENABLED/);
});

test("I8 — facturation active sans auth → refus, même hors production", async () => {
  const { assertAuthRequired } = await import("../lib/boot-guards");
  assert.throws(() => assertAuthRequired({ BILLING_ENABLED: "1" }), /AUTH_ENABLED/);
});

test("I8 — configurations légitimes : dev sans rien, prod avec auth", async () => {
  const { assertAuthRequired } = await import("../lib/boot-guards");
  assert.doesNotThrow(() => assertAuthRequired({}));
  assert.doesNotThrow(() => assertAuthRequired({ NODE_ENV: "development" }));
  assert.doesNotThrow(() => assertAuthRequired({ NODE_ENV: "production", AUTH_ENABLED: "1" }));
  assert.doesNotThrow(() => assertAuthRequired({ BILLING_ENABLED: "1", AUTH_ENABLED: "1" }));
});

test("I8 — le script prod-boot appelle bien la garde", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../scripts/prod-boot.ts", import.meta.url), "utf8");
  assert.match(src, /assertAuthRequired\(/);
});

test("2b-9 — provider claude-code refusé sur une instance multi-utilisateurs, hébergée ou facturée, sauf CORTEX_OWNER_ONLY=1", async () => {
  const { assertLlmProviderAllowed } = await import("../lib/boot-guards");
  // claude-code est le provider PAR DÉFAUT quand LLM_PROVIDER est absent.
  assert.throws(() => assertLlmProviderAllowed({ AUTH_ENABLED: "1" }), /claude-code/);
  assert.throws(() => assertLlmProviderAllowed({ LLM_PROVIDER: "claude-code", BILLING_ENABLED: "1" }), /claude-code/);
  assert.throws(() => assertLlmProviderAllowed({ LLM_PROVIDER: "claude-code", RAILWAY_PROJECT_ID: "p" }), /claude-code/);
  assert.throws(() => assertLlmProviderAllowed({ LLM_PROVIDER: "claude-code", CORTEX_HOSTED: "1" }), /claude-code/);
  assert.doesNotThrow(() => assertLlmProviderAllowed({ LLM_PROVIDER: "claude-code", AUTH_ENABLED: "1", CORTEX_OWNER_ONLY: "1" }));
  assert.doesNotThrow(() => assertLlmProviderAllowed({ LLM_PROVIDER: "anthropic", AUTH_ENABLED: "1", BILLING_ENABLED: "1" }));
  assert.doesNotThrow(() => assertLlmProviderAllowed({}), "dev mono-poste : rien de gardé");
});

test("2b-9 — prod-boot et instrumentation appellent la garde du provider", async () => {
  const fs = await import("node:fs");
  assert.match(fs.readFileSync("scripts/prod-boot.ts", "utf8"), /assertLlmProviderAllowed\(/);
  assert.match(fs.readFileSync("instrumentation.ts", "utf8"), /assertLlmProviderAllowed\(/);
});

test("E2E auth — impossible hors d'un run local explicitement isolé", async () => {
  const { assertE2ETestAuthAllowed } = await import("../lib/boot-guards");
  assert.throws(() => assertE2ETestAuthAllowed({ E2E_TEST_AUTH: "1" }), /E2E_TEST_RUN=1/);
  assert.throws(() => assertE2ETestAuthAllowed({ E2E_TEST_AUTH: "1", E2E_TEST_RUN: "1", AUTH_URL: "http://localhost:3000", CORTEX_HOSTED: "1" }), /instance hébergée/);
  assert.throws(() => assertE2ETestAuthAllowed({ E2E_TEST_AUTH: "1", E2E_TEST_RUN: "1", AUTH_URL: "http://localhost:3000", STRIPE_SECRET_KEY: "sk_live_danger" }), /Stripe live/);
  assert.throws(() => assertE2ETestAuthAllowed({ E2E_TEST_AUTH: "1", E2E_TEST_RUN: "1", AUTH_URL: "https://cortex.example" }), /bouclage local/);
  assert.doesNotThrow(() => assertE2ETestAuthAllowed({ E2E_TEST_AUTH: "1", E2E_TEST_RUN: "1", AUTH_URL: "http://127.0.0.1:3210", DATABASE_URL: "pglite://memory" }));
  assert.doesNotThrow(() => assertE2ETestAuthAllowed({ E2E_TEST_AUTH: "0", CORTEX_HOSTED: "1" }));
});

test("revue — garde serveur : NODE_ENV=production AVEC une vraie base Postgres (VPS, next start direct) sans auth → refus ; sqlite/PGlite local → démarre", async () => {
  const { assertAuthRequiredHosted } = await import("../lib/boot-guards");
  assert.throws(() => assertAuthRequiredHosted({ NODE_ENV: "production", DB_DRIVER: "postgres", DATABASE_URL: "postgres://u@db/cortex" }), /AUTH_ENABLED/);
  assert.doesNotThrow(() => assertAuthRequiredHosted({ NODE_ENV: "production", DB_DRIVER: "postgres", DATABASE_URL: "pglite://memory" }));
  assert.doesNotThrow(() => assertAuthRequiredHosted({ NODE_ENV: "production" }), "smoke test CI : sqlite");
  assert.doesNotThrow(() => assertAuthRequiredHosted({ NODE_ENV: "production", DB_DRIVER: "postgres", DATABASE_URL: "postgres://u@db/cortex", AUTH_ENABLED: "1" }));
});

/**
 * PREVIEW PAR PR — Railway copie les variables de la prod dans l'environnement
 * de la PR. scripts/preview-entrypoint.sh les neutralise au démarrage ; la garde
 * vérifie le résultat et n'ouvre l'auth persona QUE si tout est assaini.
 */
const preview = {
  E2E_TEST_AUTH: "1", E2E_TEST_RUN: "1", CORTEX_PREVIEW: "1",
  RAILWAY_PROJECT_ID: "p", RAILWAY_ENVIRONMENT: "cortex-pr-66", RAILWAY_ENVIRONMENT_NAME: "cortex-pr-66",
  RAILWAY_PUBLIC_DOMAIN: "cortex-app-cortex-pr-66-1a2b.up.railway.app",
  AUTH_URL: "https://cortex-app-cortex-pr-66-1a2b.up.railway.app", AUTH_SECRET: "preview-3f9c0d",
  DB_DRIVER: "postgres", DATABASE_URL: "postgresql://postgres:pw@postgres.railway.internal:5432/railway",
  LLM_PROVIDER: "openai-compatible", LLM_BASE_URL: "http://127.0.0.1:8080/api/e2e-llm",
  STRIPE_SECRET_KEY: "sk_test_x", E2E_PERSONA_KEY: "k".repeat(64),
};

test("preview de PR assainie : auth persona autorisée", async () => {
  const { assertE2ETestAuthAllowed } = await import("../lib/boot-guards");
  assert.doesNotThrow(() => assertE2ETestAuthAllowed(preview));
});

test("preview de PR : refus maintenu en production, et dès qu'une variable copiée de la prod reste dangereuse", async () => {
  const { assertE2ETestAuthAllowed } = await import("../lib/boot-guards");
  const refused: Array<[string, Record<string, string | undefined>, RegExp]> = [
    ["environnement de production", { RAILWAY_ENVIRONMENT: "production", RAILWAY_ENVIRONMENT_NAME: "production" }, /production/],
    ["environnement persistant hors PR", { RAILWAY_ENVIRONMENT: "staging", RAILWAY_ENVIRONMENT_NAME: "staging" }, /staging/],
    ["sans l'opt-in explicite", { CORTEX_PREVIEW: undefined }, /CORTEX_PREVIEW/],
    ["domaine de la prod", { AUTH_URL: "https://app.cortexexam.com" }, /AUTH_URL/],
    ["secret de session de la prod", { AUTH_SECRET: "le-secret-de-prod" }, /AUTH_SECRET/],
    ["base hors du réseau privé de la preview", { DATABASE_URL: "postgresql://u:p@shinkansen.proxy.rlwy.net:41234/railway" }, /base/],
    ["vrai modèle payant", { LLM_PROVIDER: "anthropic" }, /LLM/],
    ["LLM compatible mais distant", { LLM_BASE_URL: "https://api.openai.com/v1" }, /LLM/],
    ["e-mails réels", { RESEND_API_KEY: "re_x" }, /RESEND_API_KEY/],
    ["sauvegardes vers le vrai bucket", { BACKUP_S3_BUCKET: "cortex-backups" }, /BACKUP_S3_BUCKET/],
    ["fichiers dans le seau de la prod", { STORAGE_S3_BUCKET: "bucket-prod-ab12" }, /STORAGE_S3_BUCKET/],
    ["clé Stripe live", { STRIPE_SECRET_KEY: "sk_live_x" }, /Stripe live/],
    ["clé Stripe restreinte live", { STRIPE_SECRET_KEY: "rk_live_x" }, /Stripe live/],
    ["hébergement hors Railway", { CORTEX_HOSTED: "1" }, /CORTEX_HOSTED/],
    ["DB_DRIVER avec une espace, base hors réseau privé", { DB_DRIVER: "postgres ", DATABASE_URL: "postgresql://u:p@shinkansen.proxy.rlwy.net:41234/railway" }, /base/],
    ["connexion persona sans clé (URL publiée sur un dépôt public)", { E2E_PERSONA_KEY: undefined }, /E2E_PERSONA_KEY/],
    ["clé persona trop courte", { E2E_PERSONA_KEY: "court" }, /E2E_PERSONA_KEY/],
  ];
  for (const [why, patch, message] of refused) {
    assert.throws(() => assertE2ETestAuthAllowed({ ...preview, ...patch }), message, why);
  }
});

test("dry-run : ouvert dans une preview de PR assainie, toujours fermé en production", async () => {
  const { dryRunAllowed } = await import("../lib/boot-guards");
  assert.equal(await dryRunAllowed({ ...preview, AUTH_ENABLED: "1", BILLING_ENABLED: "1" }, "alice"), true);
  assert.equal(await dryRunAllowed({ ...preview, AUTH_ENABLED: "1", RAILWAY_ENVIRONMENT: "production", RAILWAY_ENVIRONMENT_NAME: "production" }, "alice"), false);
});

/**
 * AUDIT FUITES I15 — Railway recopie les variables de la prod dans tout nouvel
 * environnement (PR, staging) : STORAGE_S3_* comprises. Une instance hors
 * production qui démarre avec ce seau lit les PDF des vrais comptes et peut y
 * écrire ou y effacer. Refus au démarrage, quel que soit le chemin de démarrage.
 */
test("I15 — seau de fichiers hors production sur Railway → refus de démarrer", async () => {
  const { assertStorageBucketIsolated } = await import("../lib/boot-guards");
  const prodBucket = { STORAGE_S3_BUCKET: "bucket-prod-ab12", STORAGE_S3_ENDPOINT: "https://t3.storageapi.dev" };
  for (const name of ["cortex-pr-66", "staging"]) {
    assert.throws(
      () => assertStorageBucketIsolated({ RAILWAY_PROJECT_ID: "p", RAILWAY_ENVIRONMENT_NAME: name, ...prodBucket }),
      /STORAGE_S3_BUCKET/, name);
  }
  // Variables Railway sans nom d'environnement : on ne peut pas prouver que c'est la prod.
  assert.throws(() => assertStorageBucketIsolated({ RAILWAY_PROJECT_ID: "p", ...prodBucket }), /STORAGE_S3_BUCKET/);
  // Seau déclaré pour un AUTRE environnement que celui-ci (la valeur de la prod recopiée) : refus.
  assert.throws(() => assertStorageBucketIsolated({ RAILWAY_ENVIRONMENT_NAME: "staging", STORAGE_S3_ENVIRONMENT: "production", ...prodBucket }), /STORAGE_S3_BUCKET/);
});

test("I15 — configurations légitimes : la prod et son seau, une PR sans seau, un poste de dev, un seau dédié déclaré", async () => {
  const { assertStorageBucketIsolated } = await import("../lib/boot-guards");
  const bucket = { STORAGE_S3_BUCKET: "bucket-ab12", STORAGE_S3_ENDPOINT: "https://t3.storageapi.dev" };
  assert.doesNotThrow(() => assertStorageBucketIsolated({ RAILWAY_PROJECT_ID: "p", RAILWAY_ENVIRONMENT_NAME: "production", ...bucket }));
  assert.doesNotThrow(() => assertStorageBucketIsolated({ RAILWAY_PROJECT_ID: "p", RAILWAY_ENVIRONMENT_NAME: "cortex-pr-66" }));
  assert.doesNotThrow(() => assertStorageBucketIsolated({ ...bucket })); // MinIO local, CI
  assert.doesNotThrow(() => assertStorageBucketIsolated({ RAILWAY_ENVIRONMENT_NAME: "staging", STORAGE_S3_ENVIRONMENT: "staging", ...bucket }));
});

test("I15 — prod-boot et instrumentation appellent la garde du seau", async () => {
  const fs = await import("node:fs");
  assert.match(fs.readFileSync("scripts/prod-boot.ts", "utf8"), /assertStorageBucketIsolated\(/);
  assert.match(fs.readFileSync("instrumentation.ts", "utf8"), /assertStorageBucketIsolated\(/);
});
