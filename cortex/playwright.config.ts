import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3210);
const baseURL = `http://localhost:${port}`;
const e2eDatabaseUrl = process.env.E2E_DATABASE_URL;
// Le test « vrai Google » vise le vrai site (redirection OAuth déjà autorisée en prod) : aucun serveur local.
const googleOnly = process.env.E2E_GOOGLE_ONLY === "1"; // tests visant le vrai site : pas de serveur local
const googleBaseURL = process.env.E2E_GOOGLE_BASE_URL ?? "https://app.cortexexam.com";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: process.env.CI ? 1 : undefined,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [["html", { open: "never" }], ["list"]],
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: googleOnly ? undefined : [{
    command: `tsx e2e/reset-runtime.ts && npm run build && npm run start -- --hostname 127.0.0.1 --port ${port}`,
    url: `http://localhost:${port}/api/health`, reuseExistingServer: !process.env.CI, timeout: 300_000,
    env: {
      ...process.env,
      AUTH_ENABLED: "1", AUTH_SECRET: "e2e-only-secret-not-for-production", AUTH_URL: baseURL,
      E2E_TEST_AUTH: "1", E2E_TEST_RUN: "1", E2E_ALLOW_LOCAL_POSTGRES: e2eDatabaseUrl ? "1" : "0", DB_DRIVER: e2eDatabaseUrl ? "postgres" : "sqlite",
      ...(e2eDatabaseUrl ? { DATABASE_URL: e2eDatabaseUrl } : {}), CORTEX_DATA_DIR: `${process.cwd()}/e2e/.runtime/data`,
      STORAGE_MIN_FREE_PERCENT: "0",
      LLM_PROVIDER: "openai-compatible", LLM_BASE_URL: `${baseURL}/api/e2e-llm`, LLM_API_KEY: "e2e-hermetic",
      LLM_MODEL_OPUS: "e2e", LLM_MODEL_SONNET: "e2e", LLM_MODEL_HAIKU: "e2e", LLM_MAX_RETRIES: "0",
      MCP_ENABLED: "1", BILLING_ENABLED: "1", SIGNUP_FREE_CREDITS: "0.1",
      AUTH_EMAIL_ENABLED: "1", AUTH_EMAIL_ENDPOINT: "http://127.0.0.1:3211/capture",
      CORTEX_OWNER_EMAIL: "owner@e2e.cortex.test", RATE_LIMIT_PER_MIN: "unlimited",
    },
  }, {
    command: "tsx e2e/mail-receiver.ts", url: "http://127.0.0.1:3211/health",
    reuseExistingServer: !process.env.CI, timeout: 30_000,
  }],
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, grepInvert: /@google/ },
    { name: "iphone", use: { ...devices["iPhone 13"], browserName: "chromium" }, grep: /@principal/, grepInvert: /@google/ },
    { name: "google", use: { channel: "chrome", baseURL: googleBaseURL }, grep: /@google\b/ },
    { name: "google-redirect", use: { ...devices["Desktop Chrome"], baseURL: googleBaseURL }, grep: /@googleredirect/ },
  ],
});
