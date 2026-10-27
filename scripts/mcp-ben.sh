#!/usr/bin/env bash
# Mise en service du connecteur MCP de Cortex (Claude ↔ compte Cortex), guidée.
# À lancer par Ben, dans un Terminal, APRÈS le merge de la PR et le déploiement
# de main sur Railway. Aucun secret à saisir : le connecteur réutilise le login
# Google existant, rien à changer dans Google Cloud.
#
#   bash scripts/mcp-ben.sh
#
# Options :
#   --dry-run     essai à blanc : n'écrit rien sur Railway, n'ouvre aucune page
#   --etape=N     reprendre à l'étape N (1 variable Railway, 2 vérification, 3 claude.ai, 4 Claude Code, 5 récap)
#
# Chaque étape se passe : Entrée = faire, « s » = passer. Relançable sans risque :
# poser MCP_ENABLED=1 une seconde fois ne change rien. Pour COUPER le connecteur :
#   railway variable delete MCP_ENABLED -p <projet> -e production -s cortex-app
# puis redéployer (toutes les applications connectées perdent l'accès ; leurs
# autorisations restent révocables dans Mon compte).
set -euo pipefail
export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"

APP_URL="https://app.cortexexam.com"
MCP_URL="$APP_URL/mcp"
RW_PROJECT="d32e7d48-251b-437d-9f7a-b7a71ea58e5c"
RW_SERVICE="cortex-app"
RW_ENV="production"

DRY=0
FROM=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --etape=*) FROM="${arg#--etape=}" ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Option inconnue : $arg" >&2; exit 2 ;;
  esac
done

title() { printf '\n== %s ==\n' "$1"; }
info() { printf '   %s\n' "$1"; }
ok() { printf '   ✓ %s\n' "$1"; }
warn() { printf '   ⚠ %s\n' "$1"; }
step() { # step N "titre" → 0 = faire, 1 = passer
  [ "$1" -lt "$FROM" ] && return 1
  title "Étape $1 — $2"
  local ans=""
  read -r -p "   Entrée = faire, s = passer : " ans || true
  [ "$ans" != "s" ]
}
open_url() { if [ "$DRY" = 1 ]; then info "(à blanc) ouvrirait $1"; else open "$1" 2>/dev/null || info "Ouvre : $1"; fi; }

if step 1 "Activer le connecteur sur Railway (MCP_ENABLED=1)"; then
  if ! command -v railway >/dev/null; then warn "CLI Railway absente : brew install railway, puis railway login"; exit 1; fi
  if [ "$DRY" = 1 ]; then
    info "(à blanc) railway variable set MCP_ENABLED=1 -p $RW_PROJECT -e $RW_ENV -s $RW_SERVICE"
  else
    current="$(railway variable list -p "$RW_PROJECT" -e "$RW_ENV" -s "$RW_SERVICE" --kv 2>/dev/null | grep -E '^(MCP_ENABLED|AUTH_URL)=' || true)"
    printf '%s\n' "$current" | grep -q '^AUTH_URL=https://app.cortexexam.com' || { warn "AUTH_URL n'est pas https://app.cortexexam.com sur Railway : le connecteur en dépend (émetteur OAuth). Corrige-la d'abord."; exit 1; }
    if printf '%s\n' "$current" | grep -q '^MCP_ENABLED=1$'; then
      ok "MCP_ENABLED=1 déjà posée"
    else
      railway variable set MCP_ENABLED=1 -p "$RW_PROJECT" -e "$RW_ENV" -s "$RW_SERVICE" >/dev/null
      ok "MCP_ENABLED=1 posée : Railway redéploie (≈ 8 min avec l'attente de la CI ; un 502 bref à la bascule est normal)"
    fi
  fi
fi

if step 2 "Vérifier la découverte OAuth en production"; then
  info "Attente de la mise en ligne (jusqu'à 15 min)…"
  for _ in $(seq 1 90); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$APP_URL/.well-known/oauth-protected-resource/mcp" || true)"
    [ "$code" = 200 ] && break
    [ "$DRY" = 1 ] && break
    sleep 10
  done
  prm="$(curl -s "$APP_URL/.well-known/oauth-protected-resource/mcp" || true)"
  if printf '%s' "$prm" | grep -q "\"resource\":\"$MCP_URL\""; then ok "métadonnées de la ressource : $MCP_URL"; else warn "métadonnées absentes (MCP pas encore actif ?) : $prm"; fi
  as="$(curl -s "$APP_URL/.well-known/oauth-authorization-server" || true)"
  printf '%s' "$as" | grep -q '"code_challenge_methods_supported":\["S256"\]' && ok "serveur d'autorisation : PKCE S256 annoncé" || warn "métadonnées du serveur d'autorisation inattendues"
  challenge="$(curl -s -D - -o /dev/null -X POST "$MCP_URL" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | tr -d '\r' | grep -i '^www-authenticate:' || true)"
  if printf '%s' "$challenge" | grep -q 'resource_metadata='; then ok "/mcp sans jeton → 401 + WWW-Authenticate (la découverte peut démarrer)"; else warn "/mcp ne renvoie pas le défi attendu : $challenge"; fi
fi

if step 3 "Brancher Claude (claude.ai, Desktop, mobile)"; then
  info "1. Paramètres → Connecteurs → « Ajouter un connecteur personnalisé »."
  info "2. Nom : Cortex   ·   URL : $MCP_URL   (rien d'autre : pas d'identifiant client à saisir)."
  info "3. « Se connecter » → page Cortex → Google → écran « … demande l'accès à ton compte Cortex » → Autoriser."
  info "4. Dans une conversation : « quels sont mes points faibles en <cours> ? »"
  open_url "https://claude.ai/settings/connectors"
  read -r -p "   Entrée quand c'est fait (ou s'il a échoué, note le message) : " _ || true
fi

if step 4 "Brancher Claude Code"; then
  info "Dans un Terminal :"
  info "   claude mcp add --transport http cortex $MCP_URL"
  info "puis, dans Claude Code : /mcp → cortex → Authenticate (le navigateur s'ouvre, même écran de consentement)."
  info "Claude Code gère l'élicitation : un examen blanc te demandera la confirmation du coût directement."
fi

if step 5 "Récapitulatif"; then
  info "Applications connectées et révocation : $APP_URL/compte"
  info "Couper tout le connecteur : supprimer MCP_ENABLED sur Railway puis redéployer."
  info "Logs utiles (Railway) : événements mcp.tool, oauth.consent, oauth.token_refused — jamais de contenu ni de jeton."
fi
printf '\nTerminé.\n'
