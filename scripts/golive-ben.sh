#!/usr/bin/env bash
# Mise en ligne de Cortex, guidée : Google, domaine, Stripe live, « Wait for CI »,
# plafond Anthropic. À lancer par Ben, dans un Terminal. Il n'y a rien à faire
# d'autre que coller des valeurs : le script ouvre la bonne page, met la valeur à
# coller dans le presse-papiers et attend Entrée.
#
#   bash scripts/golive-ben.sh
#
# Options :
#   --dry-run          essai à blanc : n'ouvre rien, ne copie rien, n'écrit rien nulle part
#   --etape=N          reprendre à l'étape N (1 Google, 2 domaine, 3 Stripe, 4 Wait for CI, 5 Anthropic, 6 récap)
#   --rotate-webhook   recréer le webhook Stripe (seule façon d'obtenir un nouveau secret de signature)
#
# Chaque étape se passe : Entrée = faire, « s » = passer. Relançable sans risque :
# ce qui est déjà en place est reconnu et laissé tel quel.
#
# SECRETS : les clés Stripe sont saisies masquées (rien ne s'affiche), ne sont
# jamais écrites sur disque, ni affichées, ni passées en argument d'une commande.
# Elles vont à Stripe et à Railway, et nulle part ailleurs.
#
# Détail de ce que fait chaque étape : DEPLOY.md § 12-13 et docs/STRIPE-LIVE.md.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"

APP_URL="https://app.cortexexam.com"
LANDING_URL="https://cortexexam.com"
OLD_HOST="cortex-app-production-6a65.up.railway.app"
RW_PROJECT="d32e7d48-251b-437d-9f7a-b7a71ea58e5c"
RW_SERVICE="cortex-app"
RW_SERVICE_ID="ef3a3f6a-b222-427d-8351-a5fd48430a3e"
RW_ENV="production"
RW_ENV_ID="6199c3b5-b48c-4c68-ae91-9ddfa290913a"
OAUTH_ORIGIN="$APP_URL"
OAUTH_CALLBACK="$APP_URL/api/auth/callback/google"
ANTHROPIC_CAP_USD="50"

DRY=0
ROTATE=0
FROM=1
usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --rotate-webhook) ROTATE=1 ;;
    --etape=[1-6]) FROM="${arg#--etape=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "✗ Option inconnue : $arg" >&2; usage >&2; exit 1 ;;
  esac
done
if [[ "$DRY" -eq 0 && ! -t 0 ]]; then
  echo "✗ À lancer dans un Terminal : le script attend des saisies au clavier (essai sans rien toucher : --dry-run)." >&2
  exit 1
fi

DONE=()
SKIPPED=()
SETUP_KEY=""
RUNTIME_KEY=""
trap 'SETUP_KEY=""; RUNTIME_KEY=""' EXIT

title() { printf '\n== %s ==\n' "$1"; }
info() { printf '   %s\n' "$1"; }
ok() { printf '   ✓ %s\n' "$1"; }
warn() { printf '   ⚠ %s\n' "$1"; }
ko() { printf '   ✗ %s\n' "$1"; }

# Entrée = faire, « s » = passer. Renvoie 0 pour faire.
go() {
  local answer=""
  printf '→ %s  [Entrée = faire, s = passer] ' "$1"
  read -r answer || answer=""
  [[ -t 0 ]] || echo
  case "$answer" in s|S) return 1 ;; *) return 0 ;; esac
}
wait_enter() {
  local ignored=""
  printf '   %s  [Entrée quand c'\''est fait] ' "$1"
  read -r ignored || true
  [[ -t 0 ]] || echo
}
clip() {
  if [[ "$DRY" -eq 1 ]]; then info "(copierait dans le presse-papiers : $1)"; return 0; fi
  printf '%s' "$1" | pbcopy
  info "Dans le presse-papiers : $1"
}
browse() {
  if [[ "$DRY" -eq 1 ]]; then info "(ouvrirait : $1)"; return 0; fi
  open "$1"
}
# Saisie masquée : rien ne s'affiche, rien ne va dans l'historique.
ask_secret() { # $1 = variable, $2 = invite
  local val=""
  printf '   %s : ' "$2"
  read -rs val || val=""
  echo
  printf -v "$1" '%s' "$val"
}
should_run() { [[ "$1" -ge "$FROM" ]]; }

http_code() { curl -sS -m 20 -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || true; }
urlencode() { printf '%s' "$1" | sed 's/:/%3A/g; s#/#%2F#g'; }

# Adresse de redirection vers Google que l'app produit pour un visiteur anonyme
# (jeton CSRF et cookie gardés en mémoire : aucun fichier).
oauth_location() { # $1 = base
  local base="$1" resp csrf cookie
  resp="$(curl -sS -m 20 -i "$base/api/auth/csrf" 2>/dev/null || true)"
  csrf="$(printf '%s' "$resp" | sed -n 's/.*"csrfToken":"\([^"]*\)".*/\1/p' | head -1)"
  cookie="$(printf '%s' "$resp" | tr -d '\r' | grep -i '^set-cookie:' | sed 's/^[^:]*: *//; s/;.*//' | paste -sd ';' - || true)"
  [[ -n "$csrf" ]] || return 0
  curl -sS -m 20 -o /dev/null -w '%{redirect_url}' -H "cookie: $cookie" -X POST \
    --data-urlencode "csrfToken=$csrf" --data-urlencode "callbackUrl=/" "$base/api/auth/signin/google" 2>/dev/null || true
}
# La page est lue en entier avant d'y chercher : « curl | grep -q » échouerait
# sous pipefail quand grep s'arrête avant la fin de l'envoi.
page_has() { # $1 = URL, $2 = texte attendu
  local body
  body="$(curl -sS -m 20 "$1" 2>/dev/null || true)"
  [[ "$body" == *"$2"* ]]
}
auth_url_live() { page_has "$APP_URL/api/auth/providers" "\"callbackUrl\":\"$OAUTH_CALLBACK\""; }
landing_live() { page_has "$APP_URL/login" "href=\"$LANDING_URL/terms\""; }
old_host_redirects() { [[ "$(curl -sS -m 20 -o /dev/null -w '%{http_code} %{redirect_url}' "https://$OLD_HOST/login" 2>/dev/null || true)" == "308 $APP_URL/login" ]]; }
health_ok() { page_has "$APP_URL/api/health" '"status":"ok"'; }

# « id statut » du dernier déploiement Railway (vide si la CLI ne répond pas).
latest_deploy() {
  railway deployment list -p "$RW_PROJECT" -e "$RW_ENV" -s "$RW_SERVICE" --limit 1 --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{const a=JSON.parse(s);console.log(`${a[0].id} ${a[0].status}`)}catch{}})' 2>/dev/null || true
}
# Attend (15 min au plus) que la condition devienne vraie. $1 = message, $2 = fonction.
wait_until() {
  local tries=0
  printf '   %s' "$1"
  while ! "$2"; do
    tries=$((tries + 1))
    if [[ "$tries" -ge 90 ]]; then echo; return 1; fi
    printf '.'
    sleep 10
  done
  echo
}
PREVIOUS_DEPLOY=""
new_deploy_done() {
  local now
  now="$(latest_deploy)"
  [[ -n "$now" && "${now%% *}" != "$PREVIOUS_DEPLOY" && "${now##* }" == "SUCCESS" ]]
}

echo "Mise en ligne de Cortex — $APP_URL$([[ "$DRY" -eq 1 ]] && echo '  (ESSAI À BLANC : rien n'\''est ouvert, copié ni écrit)')"
if ! command -v railway >/dev/null 2>&1 || ! railway whoami >/dev/null 2>&1; then
  if [[ "$DRY" -eq 1 ]]; then warn "CLI Railway absente ou non connectée (railway login) : les étapes 2 et 3 en auront besoin."
  else echo "✗ CLI Railway absente ou non connectée : lance « railway login », puis relance ce script." >&2; exit 1; fi
fi
if [[ ! -x "$ROOT/cortex/node_modules/.bin/tsx" || ! -d "$ROOT/cortex/node_modules/stripe" ]]; then
  if [[ "$DRY" -eq 1 ]]; then warn "Dépendances absentes (cd cortex && NODE_ENV=development npm ci) : l'étape 3 en aura besoin."
  else echo "✗ Dépendances absentes : cd \"$ROOT/cortex\" && NODE_ENV=development npm ci" >&2; exit 1; fi
fi

# ───────────────────────────── 1. Google ─────────────────────────────
if should_run 1; then
  title "1/6 Google : autoriser la nouvelle adresse"
  if go "Ouvrir la console Google et y coller l'origine, l'URI et le domaine"; then
    CLIENT_ID="$(oauth_location "$APP_URL" | sed -n 's/.*[?&]client_id=\([^&]*\).*/\1/p')"
    PROJECT_NUMBER="${CLIENT_ID%%-*}"
    if [[ -n "$CLIENT_ID" && "$PROJECT_NUMBER" =~ ^[0-9]+$ ]]; then
      GOOGLE_QUERY="?project=$PROJECT_NUMBER"
      browse "https://console.cloud.google.com/auth/clients/$CLIENT_ID$GOOGLE_QUERY"
    else
      GOOGLE_QUERY=""
      warn "Client OAuth introuvable depuis l'app : ouvre le client « Cortex » dans la liste."
      browse "https://console.cloud.google.com/apis/credentials"
    fi
    clip "$OAUTH_ORIGIN"
    wait_enter "Sous « Origines JavaScript autorisées », clique « Ajouter un URI » et colle."
    clip "$OAUTH_CALLBACK"
    wait_enter "Sous « URI de redirection autorisés », clique « Ajouter un URI », colle, puis « Enregistrer »."
    browse "https://console.cloud.google.com/auth/branding$GOOGLE_QUERY"
    clip "${LANDING_URL#https://}"
    wait_enter "Sous « Domaines autorisés », ajoute le domaine collé, puis « Enregistrer »."
    browse "https://console.cloud.google.com/auth/audience$GOOGLE_QUERY"
    wait_enter "Clique « Publier l'application », puis « Confirmer »."
    DONE+=("1 Google : origine, URI de redirection, domaine autorisé, application publiée")
  else
    SKIPPED+=("1 Google")
  fi
fi

# ───────────────────────────── 2. Domaine ─────────────────────────────
if should_run 2; then
  title "2/6 Domaine : l'app passe sur $APP_URL"
  if auth_url_live && landing_live && old_host_redirects; then
    ok "Déjà en place : connexion, liens légaux et renvoi de l'ancienne adresse."
    DONE+=("2 Domaine : déjà en place")
  elif go "Poser l'adresse publique sur Railway (l'URI Google de l'étape 1 doit être enregistrée)"; then
    if [[ "$DRY" -eq 1 ]]; then
      info "(poserait sur Railway, en un seul redéploiement : AUTH_URL, LANDING_URL, REDIRECT_FROM_HOSTS et les quatre LEGAL_*_URL sur $LANDING_URL)"
    else
      # Une seule commande, donc un seul redéploiement. Les quatre LEGAL_*_URL sont
      # réécrites plutôt que supprimées : la CLI redéploie à chaque suppression.
      if railway variable set -p "$RW_PROJECT" -e "$RW_ENV" -s "$RW_SERVICE" \
        "AUTH_URL=$APP_URL" "LANDING_URL=$LANDING_URL" "REDIRECT_FROM_HOSTS=$OLD_HOST" \
        "LEGAL_TERMS_URL=$LANDING_URL/terms" "LEGAL_PRIVACY_URL=$LANDING_URL/privacy" \
        "LEGAL_REFUND_URL=$LANDING_URL/remboursement" "LEGAL_NOTICE_URL=$LANDING_URL/mentions-legales" >/dev/null; then
        ok "Variables posées ; Railway redéploie (4 minutes environ)."
        wait_until "Attente du déploiement" auth_url_live || warn "Toujours pas en ligne après 15 minutes : regarde le déploiement dans Railway, puis relance avec --etape=2."
      else
        ko "Railway a refusé les variables (railway login ?) : rien n'a changé, relance avec --etape=2."
      fi
    fi
    if [[ "$(http_code "$APP_URL/login")" == "200" ]]; then ok "$APP_URL/login répond 200."; else ko "$APP_URL/login ne répond pas 200."; fi
    if [[ "$(oauth_location "$APP_URL")" == *"redirect_uri=$(urlencode "$OAUTH_CALLBACK")"* ]]; then ok "La connexion renvoie vers Google avec la nouvelle URI."
    elif [[ "$DRY" -eq 1 ]]; then info "(vérifierait que la connexion renvoie vers Google avec $OAUTH_CALLBACK)"
    else ko "La connexion n'utilise pas encore $OAUTH_CALLBACK."; fi
    DONE+=("2 Domaine : adresse publique, vitrine et renvoi de l'ancienne adresse")
  else
    SKIPPED+=("2 Domaine")
  fi
fi

# ───────────────────────────── 3. Stripe live ─────────────────────────────
if should_run 3; then
  title "3/6 Stripe : passer en paiements réels"
  if go "Mettre Stripe en live (compte, produits, prix, portail, webhook, clés)"; then
    browse "https://dashboard.stripe.com/account/onboarding"
    wait_enter "Active le compte Stripe (pièce d'identité, IBAN) ; déjà actif : Entrée."
    browse "https://dashboard.stripe.com/apikeys"
    info "Clé de mise en place : « Créer une clé limitée », écriture sur Products, Prices, Customer portal et Webhook Endpoints."
    while :; do
      ask_secret SETUP_KEY "Colle la clé de mise en place (rk_live_… ou sk_live_…$([[ "$DRY" -eq 1 ]] && echo ' ; vide = décrire sans rien lire'))"
      [[ -z "$SETUP_KEY" || "$SETUP_KEY" =~ ^(rk|sk)_live_ ]] && break
      ko "Ce n'est pas une clé live (elle commence par rk_live_ ou sk_live_)."
    done
    if [[ -z "$SETUP_KEY" && "$DRY" -eq 0 ]]; then
      warn "Aucune clé saisie : étape passée."
      SKIPPED+=("3 Stripe (aucune clé)")
    else
      if [[ -n "$SETUP_KEY" ]]; then
        info "Clé de l'app : limitée, écriture sur Checkout Sessions, Customer portal et Subscriptions ; lecture sur Prices et Invoices."
        while :; do
          ask_secret RUNTIME_KEY "Colle la clé de l'app (rk_live_… ; vide = réutiliser la précédente)"
          [[ -z "$RUNTIME_KEY" || "$RUNTIME_KEY" =~ ^(rk|sk)_live_ ]] && break
          ko "Ce n'est pas une clé live."
        done
      fi
      PREVIOUS_DEPLOY="$(latest_deploy)"; PREVIOUS_DEPLOY="${PREVIOUS_DEPLOY%% *}"
      RUNNER_ARGS=(--site "$APP_URL" --landing "$LANDING_URL" --legacy-host "$OLD_HOST"
        --railway-project "$RW_PROJECT" --railway-service "$RW_SERVICE" --railway-environment "$RW_ENV")
      [[ "$DRY" -eq 1 ]] && RUNNER_ARGS+=(--dry-run)
      [[ "$ROTATE" -eq 1 ]] && RUNNER_ARGS+=(--rotate-webhook)
      # Les clés passent par l'environnement de ce seul processus, jamais par ses arguments.
      if (cd "$ROOT/cortex" && STRIPE_SETUP_KEY="$SETUP_KEY" STRIPE_RUNTIME_KEY="$RUNTIME_KEY" node_modules/.bin/tsx scripts/stripe-live-setup.ts "${RUNNER_ARGS[@]}"); then
        SETUP_KEY=""; RUNTIME_KEY=""
        if [[ "$DRY" -eq 0 ]]; then
          wait_until "Attente du redéploiement avec les clés live" new_deploy_done || warn "Redéploiement non confirmé après 15 minutes : regarde Railway."
          if [[ "$(http_code -X POST "$APP_URL/api/billing/webhook")" == "400" ]]; then ok "Le webhook refuse un appel non signé (400)."; else ko "Le webhook ne répond pas 400 à un appel non signé."; fi
        fi
        DONE+=("3 Stripe : produits, prix, portail, webhook et clés live")
        if go "Effacer en base les abonnements créés en mode TEST (à faire avant le premier abonnement réel)"; then
          clip "BEGIN; DELETE FROM public.stripe_invoices; DELETE FROM public.subscriptions; COMMIT;"
          browse "https://railway.com/project/$RW_PROJECT?environmentId=$RW_ENV_ID"
          wait_enter "Dans Railway : Postgres → Database → Query, colle et exécute."
          DONE+=("3 Stripe : abonnements de test effacés")
        else
          SKIPPED+=("3 Stripe : effacement des abonnements de test (docs/STRIPE-LIVE.md § 8)")
        fi
      else
        SETUP_KEY=""; RUNTIME_KEY=""
        ko "La mise en place de Stripe a échoué : corrige ce qui est signalé ci-dessus, puis relance avec --etape=3."
        SKIPPED+=("3 Stripe (échec)")
      fi
    fi
  else
    SKIPPED+=("3 Stripe")
  fi
fi

# ───────────────────────────── 4. Wait for CI ─────────────────────────────
if should_run 4; then
  title "4/6 Railway : attendre la CI avant de déployer"
  if go "Appliquer le réglage « Wait for CI » déjà en attente sur le service"; then
    browse "https://railway.com/project/$RW_PROJECT/service/$RW_SERVICE_ID/settings?environmentId=$RW_ENV_ID"
    wait_enter "Clique « Deploy » dans le bandeau violet en haut de la page."
    DONE+=("4 Railway : Wait for CI appliqué")
  else
    SKIPPED+=("4 Wait for CI")
  fi
fi

# ───────────────────────────── 5. Anthropic ─────────────────────────────
if should_run 5; then
  title "5/6 Anthropic : plafond de dépense"
  if go "Poser un plafond mensuel de $ANTHROPIC_CAP_USD \$ dans la console Anthropic"; then
    browse "https://console.anthropic.com/settings/limits"
    clip "$ANTHROPIC_CAP_USD"
    wait_enter "Sous « Spend limits », colle le plafond mensuel en dollars, puis enregistre."
    DONE+=("5 Anthropic : plafond mensuel de $ANTHROPIC_CAP_USD \$")
  else
    SKIPPED+=("5 Anthropic")
  fi
fi

# ───────────────────────────── 6. Récapitulatif ─────────────────────────────
title "6/6 Récapitulatif"
if [[ "${#DONE[@]}" -gt 0 ]]; then
  for line in "${DONE[@]}"; do
    if [[ "$DRY" -eq 1 ]]; then info "· déroulé à blanc : $line"; else ok "$line"; fi
  done
fi
if [[ "${#SKIPPED[@]}" -gt 0 ]]; then for line in "${SKIPPED[@]}"; do info "· passé : $line"; done; fi
echo "   Production :"
if health_ok; then ok "/api/health : ok"; else ko "/api/health ne répond pas ok"; fi
if [[ "$(http_code "$APP_URL/login")" == "200" ]]; then ok "/login : 200"; else ko "/login ne répond pas 200"; fi
WEBHOOK_CODE="$(http_code -X POST "$APP_URL/api/billing/webhook")"
if [[ "$WEBHOOK_CODE" == "400" ]]; then ok "webhook non signé : 400"; else ko "webhook non signé : $WEBHOOK_CODE (attendu 400)"; fi
if auth_url_live; then ok "connexion Google sur $APP_URL"; else warn "connexion Google encore sur l'ancienne adresse (étape 2)"; fi
if old_host_redirects; then ok "l'ancienne adresse renvoie vers la nouvelle"; else warn "l'ancienne adresse ne renvoie pas encore vers la nouvelle (étape 2)"; fi
[[ "$DRY" -eq 1 ]] && echo "Essai à blanc terminé : rien n'a été ouvert, copié ni écrit."
exit 0
