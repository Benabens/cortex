// Infrastructure Railway de Cortex (projet « wonderful-creativity »), décrite en
// code. Remplace railway.json (supprimé) ; Railway cesse de lire ce format le
// 2026-12-01.
//
// Ce fichier n'est lu que par la CLI : `railway config plan` (aperçu, sans
// effet) et `railway config apply` (applique). Un déploiement ne le lit jamais.
// Point de départ : `railway config pull` du 16/11/2026 ; `railway config plan`
// répond « already up to date » contre la production.
//
// ⚠ CE FICHIER EST AUTORITAIRE. À l'apply, tout ce qui n'y figure pas est
// supprimé : une ressource (base, volume, bucket) comme une variable du service.
// Une variable ajoutée dans le tableau de bord ou par `railway variable set`
// doit être ajoutée ici (`NOM: preserve()`) avant tout apply. Lire le plan :
// une ligne « Delete » ou « destructive » = on s'arrête (DEPLOY.md, section 1 bis).
import { bucket, defineRailway, github, postgres, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  // Base Postgres et son volume. Le proxy TCP 5432 expose la base hors du réseau
  // privé Railway (réseau privé : postgres.railway.internal).
  const Postgres = postgres("Postgres", { region: "europe-west4-drams3a" });
  Postgres.networking = { privateNetworkEndpoint: "postgres", tcpProxies: { "5432": {} } };
  const postgresVolume = volume("postgres-volume", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: "europe-west4-drams3a",
    sizeMB: 500,
  });

  // Volume de l'app (CORTEX_DATA_DIR) : PDF d'annales, imports, examens générés.
  const cortexAppVolume = volume("cortex-app-volume", {
    alerts: { usage: { "100": {}, "80": {}, "95": {} } },
    allowOnlineResize: true,
    region: "europe-west4-drams3a",
    sizeMB: 500,
  });

  // Stockage objet : objets de l'app (STORAGE_S3_*) et sauvegardes (BACKUP_S3_*).
  const Bucket = bucket("Bucket", { region: "ams" });
  const cortexBackups = bucket("cortex-backups", { region: "ams" });

  // L'app : image du Dockerfile racine, déployée depuis main une fois la CI verte
  // (checkSuites). Démarrage = CMD du Dockerfile (scripts/start.sh), qui aiguille
  // aussi les previews de PR. Redémarrage : défaut Railway (en cas d'échec, 10
  // essais). UN SEUL replica : la file de jobs est mono-conteneur par design.
  const cortexApp = service("cortex-app", {
    source: github("Benabens/cortex", { branch: "main", checkSuites: true }),
    build: { buildEnvironment: "V3", builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    healthcheck: "/api/health",
    healthcheckTimeout: 300,
    replicas: { "europe-west4-drams3a": 1 },
    domains: ["app.cortexexam.com"],
    volumeMounts: { "/data": cortexAppVolume },
    // Valeurs gardées sur Railway (preserve) : aucun secret dans le dépôt.
    env: {
      AUTH_EMAIL_ENABLED: preserve(),
      AUTH_EMAIL_FROM: preserve(),
      AUTH_ENABLED: preserve(),
      AUTH_SECRET: preserve(),
      AUTH_URL: preserve(),
      BACKUP_S3_ACCESS_KEY_ID: preserve(),
      BACKUP_S3_BUCKET: preserve(),
      BACKUP_S3_ENDPOINT: preserve(),
      BACKUP_S3_REGION: preserve(),
      BACKUP_S3_SECRET_ACCESS_KEY: preserve(),
      BILLING_ENABLED: preserve(),
      CORTEX_DATA_DIR: preserve(),
      CORTEX_OWNER_EMAIL: preserve(),
      CORTEX_PYTHON_WASM: preserve(),
      CORTEX_SEED_COURSES: preserve(),
      CORTEX_SEED_USER: preserve(),
      CORTEX_TRACK_USAGE: preserve(),
      CREDITS_COST_JSON: preserve(),
      CREDIT_NET_USD: preserve(),
      DAILY_ASSIST_QUOTA: preserve(),
      DAILY_GEN_QUOTA: preserve(),
      DATABASE_URL: preserve(),
      DB_DRIVER: preserve(),
      GOOGLE_CLIENT_ID: preserve(),
      GOOGLE_CLIENT_SECRET: preserve(),
      INVITE_EMAILS: preserve(),
      JOB_SPEND_CAP_USD_PER_CREDIT: preserve(),
      LANDING_URL: preserve(),
      LEGAL_NOTICE_URL: preserve(),
      LEGAL_PRIVACY_URL: preserve(),
      LEGAL_REFUND_URL: preserve(),
      LEGAL_TERMS_URL: preserve(),
      LEGAL_TERMS_VERSION: preserve(),
      LLM_ALLOW_OPUS: preserve(),
      LLM_API_KEY: preserve(),
      LLM_MAX_CONCURRENCY: preserve(),
      LLM_PROVIDER: preserve(),
      LOG_LEVEL: preserve(),
      MCP_ENABLED: preserve(),
      METRICS_TOKEN: preserve(),
      OPS_ALERT_COST_CAP_RATIO: preserve(),
      OPS_ALERT_DB_RATIO: preserve(),
      OPS_ALERT_FAIL_MIN_JOBS: preserve(),
      OPS_ALERT_FAIL_RATE: preserve(),
      OPS_ALERT_REFUNDS_MIN: preserve(),
      OPS_ALERT_SLOW_FACTOR: preserve(),
      OPS_ALERT_SLOW_MIN_JOBS: preserve(),
      OPS_ALERT_STUCK_MIN: preserve(),
      OPS_DB_LIMIT_MB: preserve(),
      OPS_DIGEST_ENABLED: preserve(),
      OPS_DIGEST_HOUR: preserve(),
      OPS_DIGEST_TO: preserve(),
      OPS_RAILWAY_URL: preserve(),
      OPS_SENTRY_URL: preserve(),
      ORIGINALS_PURGE: preserve(),
      PUBLISHER_EMAIL: preserve(),
      RAILWAY_DEPLOYMENT_DRAINING_SECONDS: preserve(),
      RAILWAY_RUN_UID: preserve(),
      RATE_LIMIT_PER_MIN: preserve(),
      REDIRECT_FROM_HOSTS: preserve(),
      RESEND_API_KEY: preserve(),
      REVIEW_LOGIN_EMAIL: preserve(),
      REVIEW_LOGIN_PASSWORD_HASH: preserve(),
      REVIEW_LOGIN_UNTIL: preserve(),
      SEED_NEW_TENANTS: preserve(),
      SENTRY_DSN: preserve(),
      SENTRY_ENVIRONMENT: preserve(),
      SIGNUP_FREE_CREDITS: preserve(),
      SPEND_CAP_PER_USER_USD: preserve(),
      SPEND_CAP_USD: preserve(),
      STORAGE_S3_ACCESS_KEY_ID: preserve(),
      STORAGE_S3_BUCKET: preserve(),
      STORAGE_S3_ENDPOINT: preserve(),
      STORAGE_S3_REGION: preserve(),
      STORAGE_S3_SECRET_ACCESS_KEY: preserve(),
      STRIPE_FREE_PROMO_CODES: preserve(),
      STRIPE_SECRET_KEY: preserve(),
      STRIPE_WEBHOOK_SECRET: preserve(),
      TRUST_PROXY: preserve(),
    },
  });

  return project("wonderful-creativity", {
    resources: [Postgres, cortexApp, cortexAppVolume, postgresVolume, Bucket, cortexBackups],
  });
});
