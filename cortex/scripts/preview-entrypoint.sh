#!/usr/bin/env bash
# Démarrage des PREVIEWS DE PR (railway.json → environments.pr, appliqué par
# Railway aux seuls environnements éphémères de PR).
#
# Railway crée l'environnement d'une PR en COPIANT les variables de la prod :
# clé du vrai modèle, Resend, sauvegardes S3, Google, Stripe, secret de session.
# On neutralise ici tout ce qui touche au monde réel AVANT de lancer l'app ; la
# garde de démarrage (lib/boot-guards, railwayPreviewViolations) revérifie le
# résultat et refuse de servir s'il reste un trou. La base, elle, est déjà celle
# de la PR : Postgres joint par le réseau privé, cloisonné par environnement.
# Hors environnement de PR, ce script refuse de démarrer.
set -euo pipefail
cd "$(dirname "$0")/.."

name="${RAILWAY_ENVIRONMENT_NAME:-${RAILWAY_ENVIRONMENT:-}}"
if [[ "$name" == "production" || ! "$name" =~ (^|-)pr-[0-9]+$ ]]; then
  echo "[preview] refus : « ${name:-inconnu} » n'est pas un environnement de PR Railway" >&2
  exit 1
fi
if [[ -z "${RAILWAY_PUBLIC_DOMAIN:-}" ]]; then
  echo "[preview] refus : pas de domaine Railway pour cette preview" >&2
  exit 1
fi
# L'URL de la preview est publiée sur la PR, dans un dépôt public : sans clé,
# n'importe qui y entrerait par la connexion persona, propriétaire compris.
persona_key="${E2E_PERSONA_KEY:-}"
if [[ "${#persona_key}" -lt 32 ]]; then
  echo "[preview] refus : E2E_PERSONA_KEY absente ou trop courte (cortex/scripts/setup-fiabilite.sh, étape 4)" >&2
  exit 1
fi

# Monde réel : modèle payant, e-mails, sauvegardes vers le vrai bucket, Google,
# métriques, lancement fermé et amorçage de la prod.
unset LLM_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY \
  RESEND_API_KEY AUTH_EMAIL_ENABLED AUTH_EMAIL_ENDPOINT \
  BACKUP_S3_BUCKET BACKUP_S3_ENDPOINT BACKUP_S3_REGION BACKUP_S3_PREFIX BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY \
  GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET AUTH_GOOGLE_ID AUTH_GOOGLE_SECRET \
  METRICS_TOKEN INVITE_ONLY INVITE_EMAILS REDIRECT_FROM_HOSTS \
  CORTEX_SEED_COURSES CORTEX_SEED_USER SEED_NEW_TENANTS CORTEX_OWNER_USER_ID
# Stripe : mode test seulement.
case "${STRIPE_SECRET_KEY:-}" in
  sk_test_*) ;;
  *) unset STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET ;;
esac

# Secret de session propre à ce démarrage : une session ouverte dans la preview
# (personas E2E comprises) ne vaut rien en production.
AUTH_SECRET="preview-$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
export AUTH_SECRET
export AUTH_URL="https://${RAILWAY_PUBLIC_DOMAIN}"
export CORTEX_PREVIEW=1 E2E_TEST_AUTH=1 E2E_TEST_RUN=1 SENTRY_ENVIRONMENT=preview
# LLM hermétique servi par l'app elle-même (app/api/e2e-llm) : aucun appel sortant.
export LLM_PROVIDER=openai-compatible LLM_BASE_URL="http://127.0.0.1:${PORT:-3000}/api/e2e-llm" LLM_API_KEY=e2e-hermetic
export LLM_MODEL_OPUS=e2e LLM_MODEL_SONNET=e2e LLM_MODEL_HAIKU=e2e LLM_MAX_RETRIES=0
# Mêmes réglages que le banc E2E (playwright.config.ts) : les parcours y tournent tels quels.
export AUTH_ENABLED=1 BILLING_ENABLED=1 MCP_ENABLED=1 SIGNUP_FREE_CREDITS=0 RATE_LIMIT_PER_MIN=unlimited \
  CORTEX_OWNER_EMAIL=owner@e2e.cortex.test

echo "[preview] environnement ${name} assaini, domaine ${RAILWAY_PUBLIC_DOMAIN}"
exec bash scripts/docker-entrypoint.sh
