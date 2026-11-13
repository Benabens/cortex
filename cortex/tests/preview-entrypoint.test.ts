/**
 * PREVIEW PAR PR — Railway crée l'environnement d'une PR en copiant les
 * variables de la PRODUCTION. Le démarrage propre aux PR (railway.json →
 * scripts/preview-entrypoint.sh) doit en faire une instance sans effet sur le
 * monde réel, que la garde de démarrage accepte ; ailleurs, il refuse de tourner.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-preview-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Copie le script à côté d'un faux docker-entrypoint qui écrit l'environnement reçu. */
function run(env: Record<string, string>): { status: number | null; stderr: string; started: Record<string, string> | null } {
  fs.mkdirSync(path.join(tmp, "scripts"), { recursive: true });
  fs.copyFileSync("scripts/preview-entrypoint.sh", path.join(tmp, "scripts/preview-entrypoint.sh"));
  const dump = path.join(tmp, "env.json");
  fs.rmSync(dump, { force: true });
  fs.writeFileSync(path.join(tmp, "scripts/docker-entrypoint.sh"),
    `node -e 'require("fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env))'\n`);
  const r = spawnSync("bash", [path.join(tmp, "scripts/preview-entrypoint.sh")], { env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8" });
  return { status: r.status, stderr: r.stderr, started: fs.existsSync(dump) ? JSON.parse(fs.readFileSync(dump, "utf8")) : null };
}

/** Variables de la prod telles que Railway les recopie dans la PR (valeurs factices). */
const copiedFromProduction: Record<string, string> = {
  RAILWAY_PROJECT_ID: "p", RAILWAY_ENVIRONMENT: "cortex-pr-66", RAILWAY_ENVIRONMENT_NAME: "cortex-pr-66",
  RAILWAY_PUBLIC_DOMAIN: "cortex-app-cortex-pr-66-1a2b.up.railway.app", PORT: "8080",
  AUTH_ENABLED: "1", AUTH_SECRET: "le-secret-de-prod", AUTH_URL: "https://app.cortexexam.com",
  DB_DRIVER: "postgres", DATABASE_URL: "postgresql://postgres:pw@postgres.railway.internal:5432/railway",
  LLM_PROVIDER: "anthropic", LLM_API_KEY: "sk-ant-vraie-cle", RESEND_API_KEY: "re_vraie_cle",
  BACKUP_S3_BUCKET: "cortex-backups", BACKUP_S3_ACCESS_KEY_ID: "k", BACKUP_S3_SECRET_ACCESS_KEY: "s", BACKUP_S3_ENDPOINT: "https://s3",
  GOOGLE_CLIENT_ID: "g.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "gs", METRICS_TOKEN: "m",
  STRIPE_SECRET_KEY: "sk_live_vraie_cle", STRIPE_WEBHOOK_SECRET: "whsec_x", BILLING_ENABLED: "1",
  INVITE_ONLY: "1", INVITE_EMAILS: "ben@exemple.com", REDIRECT_FROM_HOSTS: "cortex-app-production-6a65.up.railway.app",
  SENTRY_DSN: "https://cle@o0.ingest.sentry.io/1", SENTRY_ENVIRONMENT: "production",
  RATE_LIMIT_PER_MIN: "120", CORTEX_OWNER_EMAIL: "ben@exemple.com",
  // Posée sur la prod par setup-fiabilite.sh (étape 4), inerte là-bas (pas d'E2E_TEST_AUTH).
  E2E_PERSONA_KEY: "9f".repeat(32),
};

test("PR : les variables copiées de la prod sont neutralisées et la garde de démarrage accepte le résultat", async () => {
  const r = run(copiedFromProduction);
  assert.equal(r.status, 0, r.stderr);
  const env = r.started!;
  const { railwayPreviewViolations, assertE2ETestAuthAllowed, assertLlmProviderAllowed, assertAuthRequiredHosted } = await import("../lib/boot-guards");
  assert.deepEqual(railwayPreviewViolations(env), []);
  assert.doesNotThrow(() => { assertE2ETestAuthAllowed(env); assertLlmProviderAllowed(env); assertAuthRequiredHosted(env); });
  for (const k of ["LLM_API_KEY", "RESEND_API_KEY", "BACKUP_S3_BUCKET", "BACKUP_S3_SECRET_ACCESS_KEY", "GOOGLE_CLIENT_SECRET", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "METRICS_TOKEN", "INVITE_ONLY"]) {
    assert.ok(env[k] === undefined || !Object.values(copiedFromProduction).includes(env[k]), `${k} de la prod encore présent`);
  }
  assert.notEqual(env.AUTH_SECRET, "le-secret-de-prod");
  assert.equal(env.AUTH_URL, "https://cortex-app-cortex-pr-66-1a2b.up.railway.app");
  assert.equal(env.LLM_BASE_URL, "http://127.0.0.1:8080/api/e2e-llm", "le modèle hermétique, servi par l'app elle-même");
  assert.equal(env.SENTRY_ENVIRONMENT, "preview");
  assert.equal(env.DATABASE_URL, copiedFromProduction.DATABASE_URL, "la base privée de l'environnement de PR");
});

test("PR : une clé Stripe de TEST reste utilisable", () => {
  const r = run({ ...copiedFromProduction, STRIPE_SECRET_KEY: "sk_test_cle" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.started!.STRIPE_SECRET_KEY, "sk_test_cle");
});

test("hors environnement de PR : refus de démarrer, l'app n'est jamais lancée", () => {
  for (const name of ["production", "staging", ""]) {
    const r = run({ ...copiedFromProduction, RAILWAY_ENVIRONMENT: name, RAILWAY_ENVIRONMENT_NAME: name });
    assert.notEqual(r.status, 0, name);
    assert.equal(r.started, null, `${name || "(vide)"} : démarré quand même`);
  }
});

test("PR sans clé persona : refus de démarrer (l'URL de la preview est publiée sur un dépôt public)", () => {
  for (const key of [undefined, "court"]) {
    const env: Record<string, string> = { ...copiedFromProduction };
    if (key === undefined) delete env.E2E_PERSONA_KEY; else env.E2E_PERSONA_KEY = key;
    const r = run(env);
    assert.notEqual(r.status, 0);
    assert.equal(r.started, null);
    assert.match(r.stderr, /E2E_PERSONA_KEY/);
  }
});

test("PR : mêmes réglages que le banc E2E de playwright.config.ts, sinon les parcours joués contre la preview divergent", async () => {
  const { default: config } = await import("../playwright.config");
  const bench = (Array.isArray(config.webServer) ? config.webServer[0] : config.webServer)?.env ?? {};
  const env = run(copiedFromProduction).started!;
  const shared = ["AUTH_ENABLED", "E2E_TEST_AUTH", "E2E_TEST_RUN", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MODEL_OPUS", "LLM_MODEL_SONNET",
    "LLM_MODEL_HAIKU", "LLM_MAX_RETRIES", "MCP_ENABLED", "BILLING_ENABLED", "SIGNUP_FREE_CREDITS", "CORTEX_OWNER_EMAIL", "RATE_LIMIT_PER_MIN"];
  assert.deepEqual(Object.fromEntries(shared.map((k) => [k, env[k]])), Object.fromEntries(shared.map((k) => [k, bench[k]])));
  assert.equal(new URL(env.LLM_BASE_URL).pathname, new URL(bench.LLM_BASE_URL).pathname);
});
