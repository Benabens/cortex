#!/usr/bin/env bash
# Configuration unique du test « vrai Google » (Stripe test est déjà configuré).
# Compte de test : hellogameytb@gmail.com. Le test se connecte au vrai site app.cortexexam.com.
set -euo pipefail
cd "$(dirname "$0")/.."
email="hellogameytb@gmail.com"
echo "1) Active la validation en deux étapes par APPLICATION D'AUTHENTIFICATION sur $email."
echo "   Quand le QR code s'affiche : « Impossible de le scanner ? » → copie la clé secrète."
open -na "Google Chrome" --args --profile-directory="Profile 1" "https://myaccount.google.com/two-step-verification/authenticator" 2>/dev/null || true
read -r -s -p "Mot de passe Google de $email : " pw; printf '\n'
read -r -s -p "Clé secrète de l'application d'authentification : " totp; printf '\n'
totp=$(printf '%s' "$totp" | tr -d ' ')
umask 077; touch .env.e2e.local
grep -vE '^(E2E_GOOGLE_EMAIL|E2E_GOOGLE_PASSWORD|E2E_GOOGLE_TOTP_SECRET)=' .env.e2e.local > .env.e2e.local.tmp || true
{ cat .env.e2e.local.tmp; printf 'E2E_GOOGLE_EMAIL=%q\nE2E_GOOGLE_PASSWORD=%q\nE2E_GOOGLE_TOTP_SECRET=%q\n' "$email" "$pw" "$totp"; } > .env.e2e.local; rm -f .env.e2e.local.tmp
printf '%s' "$email" | gh secret set E2E_GOOGLE_EMAIL
printf '%s' "$pw" | gh secret set E2E_GOOGLE_PASSWORD
printf '%s' "$totp" | gh secret set E2E_GOOGLE_TOTP_SECRET
echo "2) Lancement du premier test Google réel…"
set -a; source .env.e2e.local; set +a
npm run e2e:google
