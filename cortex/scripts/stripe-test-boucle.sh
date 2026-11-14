#!/usr/bin/env bash
# Boucle Stripe complète en MODE TEST, en local (audit du 13/11/2026, Y3 partie 1) :
# Checkout payé (carte 4242) → checkout.session.completed → +10 crédits →
# remboursement → charge.refunded → crédits repris. Aucun frais, rien en prod.
#
#   bash scripts/stripe-test-boucle.sh            # depuis cortex/
#   bash scripts/stripe-test-boucle.sh --dry-run  # montre les étapes, ne lance rien
#
# Clé : STRIPE_SECRET_KEY dans l'environnement, sinon lue (et jamais affichée)
# dans STRIPE_ENV_FILE (défaut .env.e2e.local, rempli par scripts/qa-setup.sh).
# Seule une clé sk_test_ est acceptée. Le secret du webhook vient de
# `stripe listen`, pour ce run seulement.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$HERE/.."
PORT="${E2E_PORT:-3240}"
ENV_FILE="${STRIPE_ENV_FILE:-$APP/.env.e2e.local}"
EVENTS=checkout.session.completed,checkout.session.async_payment_succeeded,charge.refunded

if [[ "${1:-}" == "--dry-run" ]]; then
  cat <<EOF
[dry-run] étapes, rien n'est lancé :
 1. STRIPE_SECRET_KEY : environnement, sinon $ENV_FILE (refus si ce n'est pas sk_test_)
 2. stripe listen --print-secret → STRIPE_WEBHOOK_SECRET de ce run (non affiché)
 3. stripe listen --events $EVENTS --forward-to http://127.0.0.1:$PORT/api/billing/webhook (arrière-plan)
 4. Playwright e2e/stripe.spec.ts sur un build local neuf (port $PORT, SQLite jetable,
    INVITE_ONLY=1 sur @e2e.cortex.test, LANDING_URL pour les pages légales)
 5. arrêt de stripe listen ; résumé des événements reçus (journal temporaire, effacé)
EOF
  exit 0
fi

command -v stripe >/dev/null || { echo "stripe CLI absente (brew install stripe/stripe-cli/stripe)"; exit 1; }
if [[ -z "${STRIPE_SECRET_KEY:-}" && -f "$ENV_FILE" ]]; then
  STRIPE_SECRET_KEY="$(grep -E '^STRIPE_SECRET_KEY=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')"
fi
[[ "${STRIPE_SECRET_KEY:-}" == sk_test_* ]] || { echo "Clé de test sk_test_ introuvable (env ou $ENV_FILE). Aucune clé live acceptée."; exit 1; }
export STRIPE_SECRET_KEY
export STRIPE_API_KEY="$STRIPE_SECRET_KEY"   # la CLI agit sur le même compte que l'app
if lsof -iTCP:"$PORT" -sTCP:LISTEN -n >/dev/null 2>&1; then echo "Port $PORT occupé : E2E_PORT=<autre> bash $0"; exit 1; fi

STRIPE_WEBHOOK_SECRET="$(stripe listen --print-secret 2>/dev/null)"
[[ "$STRIPE_WEBHOOK_SECRET" == whsec_* ]] || { echo "stripe listen --print-secret n'a pas rendu de secret."; exit 1; }
export STRIPE_WEBHOOK_SECRET

# Hors de e2e/.runtime : Playwright le vide au démarrage du serveur.
LOG="$(mktemp -t stripe-listen)"
stripe listen --events "$EVENTS" --forward-to "http://127.0.0.1:$PORT/api/billing/webhook" >"$LOG" 2>&1 &
LISTEN=$!
trap 'kill $LISTEN 2>/dev/null || true; rm -f "$LOG"' EXIT
for _ in $(seq 1 30); do grep -q "Ready" "$LOG" && break; sleep 1; done
grep -q "Ready" "$LOG" || { echo "stripe listen ne démarre pas :"; tail -5 "$LOG"; exit 1; }

cd "$APP"
E2E_PORT="$PORT" E2E_STRIPE_LISTEN=1 INVITE_ONLY=1 INVITE_EMAILS=@e2e.cortex.test \
  LANDING_URL=https://cortexexam.com CI= \
  npx playwright test e2e/stripe.spec.ts --project desktop --reporter=list || RC=$?
echo
echo "Événements reçus par le webhook local :"
grep -E "\-\->|<\-\-" "$LOG" | sed -E 's/(evt|cs|pi|ch|re)_[A-Za-z0-9]+/\1_…/g' | tail -12 || true
exit "${RC:-0}"
