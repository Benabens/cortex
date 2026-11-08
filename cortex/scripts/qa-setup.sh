#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
open_url() { command -v open >/dev/null && open "$1" || printf '%s\n' "$1"; }
read_secret() { local prompt="$1" var="$2" value; read -r -s -p "$prompt: " value; printf '\n'; printf -v "$var" '%s' "$value"; }
open_url "https://accounts.google.com/signup"
read -r -p "E-mail du compte Google de test: " google_email
read_secret "Mot de passe Google" google_password
open_url "https://myaccount.google.com/signinoptions/two-step-verification"
read_secret "Secret TOTP (base32)" google_totp
open_url "https://console.cloud.google.com/apis/credentials?project=cortex-503221"
read -r -p "Google OAuth Client ID: " google_client_id
read_secret "Google OAuth Client Secret" google_client_secret
open_url "https://dashboard.stripe.com/test/apikeys"
read_secret "Clé Stripe test sk_test_ (vide pour ignorer)" stripe_key
if [[ -n "$stripe_key" && "$stripe_key" != sk_test_* ]]; then echo "Refus: seule une clé sk_test_ est acceptée." >&2; exit 1; fi
stripe_credits=""; stripe_monthly=""; stripe_yearly=""; stripe_webhook=""
if [[ -n "$stripe_key" ]]; then
  open_url "https://dashboard.stripe.com/test/products"
  read -r -p "Price ID pack 10 crédits (price_…): " stripe_credits
  read -r -p "Price ID Pro mensuel (price_…): " stripe_monthly
  read -r -p "Price ID Pro annuel (price_…): " stripe_yearly
  read_secret "Secret webhook test whsec_… (stripe listen)" stripe_webhook
fi
umask 077
{
  printf 'E2E_GOOGLE_EMAIL=%q\n' "$google_email"
  printf 'E2E_GOOGLE_PASSWORD=%q\n' "$google_password"
  printf 'E2E_GOOGLE_TOTP_SECRET=%q\n' "$google_totp"
  printf 'GOOGLE_CLIENT_ID=%q\n' "$google_client_id"
  printf 'GOOGLE_CLIENT_SECRET=%q\n' "$google_client_secret"
  printf 'STRIPE_SECRET_KEY=%q\n' "$stripe_key"
  printf 'STRIPE_PRICE_CREDITS_10=%q\n' "$stripe_credits"
  printf 'STRIPE_PRICE_PRO_MONTHLY=%q\n' "$stripe_monthly"
  printf 'STRIPE_PRICE_PRO_YEARLY=%q\n' "$stripe_yearly"
  printf 'STRIPE_WEBHOOK_SECRET=%q\n' "$stripe_webhook"
} > .env.e2e.local
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  printf '%s' "$google_email" | gh secret set E2E_GOOGLE_EMAIL
  printf '%s' "$google_password" | gh secret set E2E_GOOGLE_PASSWORD
  printf '%s' "$google_totp" | gh secret set E2E_GOOGLE_TOTP_SECRET
  printf '%s' "$google_client_id" | gh secret set GOOGLE_CLIENT_ID
  printf '%s' "$google_client_secret" | gh secret set GOOGLE_CLIENT_SECRET
  [[ -z "$stripe_key" ]] || printf '%s' "$stripe_key" | gh secret set STRIPE_SECRET_KEY
  [[ -z "$stripe_credits" ]] || printf '%s' "$stripe_credits" | gh secret set STRIPE_PRICE_CREDITS_10
  [[ -z "$stripe_monthly" ]] || printf '%s' "$stripe_monthly" | gh secret set STRIPE_PRICE_PRO_MONTHLY
  [[ -z "$stripe_yearly" ]] || printf '%s' "$stripe_yearly" | gh secret set STRIPE_PRICE_PRO_YEARLY
  [[ -z "$stripe_webhook" ]] || printf '%s' "$stripe_webhook" | gh secret set STRIPE_WEBHOOK_SECRET
fi
open_url "https://console.cloud.google.com/apis/credentials/consent?project=cortex-503221"
echo "Configuration écrite dans .env.e2e.local et secrets GitHub posés si gh était connecté."
