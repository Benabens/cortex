#!/usr/bin/env bash
# Loops (emails marketing d'onboarding), guidé : compte gratuit, clé API, pose sur
# Railway. À lancer par Ben, dans un Terminal : le script ouvre la bonne page, demande
# de coller la clé, la pose et attend Entrée.
#
#   bash cortex/scripts/setup-loops.sh
#
# Options :
#   --dry-run     essai à blanc : n'ouvre rien, ne copie rien, ne demande aucune clé, n'écrit rien nulle part
#
# Rien de payant : plan gratuit Loops (1 000 contacts, 4 000 envois/mois). Sans
# LOOPS_API_KEY, l'intégration est inerte (log, aucune erreur visible) — voir lib/loops.ts.
#
# SECRET : la clé API Loops est saisie masquée, jamais écrite sur disque ni affichée ;
# elle voyage par l'entrée standard de la CLI Railway (railway variable set --stdin).
set -euo pipefail
export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"

RW_PROJECT="d32e7d48-251b-437d-9f7a-b7a71ea58e5c"
RW_SERVICE="cortex-app"
RW_ENV="production"
LOOPS_SIGNUP="https://app.loops.so/signup"
LOOPS_SETTINGS="https://app.loops.so/settings"

DRY=0
KEY=""

usage() { sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
forget_secret() { KEY=""; }

title() { printf '\n== %s ==\n' "$1"; }
info() { printf '   %s\n' "$1"; }
ok() { printf '   ✓ %s\n' "$1"; }
warn() { printf '   ⚠ %s\n' "$1"; }
ko() { printf '   ✗ %s\n' "$1"; }

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
browse() {
  if [[ "$DRY" -eq 1 ]]; then info "(ouvrirait : $1)"; return 0; fi
  open "$1" 2>/dev/null || warn "Page non ouverte, à ouvrir à la main : $1"
}
ask_secret() { # $1 = variable, $2 = invite
  local val=""
  printf '   %s : ' "$2"
  read -rs val || val=""
  echo
  printf -v "$1" '%s' "$val"
}
require_terminal() {
  if [[ "$DRY" -eq 0 && ! -t 0 ]]; then
    echo "✗ À lancer dans un Terminal : le script attend une saisie au clavier (essai sans rien toucher : --dry-run)." >&2
    exit 1
  fi
}
rw_has_var() { # $1 = nom ; 0 = posée, 1 = absente, 2 = illisible
  local rc=0
  { railway variable list --json -p "$RW_PROJECT" -e "$RW_ENV" -s "$RW_SERVICE" 2>/dev/null || printf '!'; } \
    | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const v=JSON.parse(s);process.exit(v&&typeof v==="object"&&!Array.isArray(v)&&String(v[process.argv[1]]??"").trim()?0:1)}catch{process.exit(2)}})' "$1" \
    2>/dev/null || rc=$?
  [[ "$rc" -le 2 ]] || rc=2
  return "$rc"
}

step_account() {
  title "1/3 Compte Loops (gratuit)"
  info "Plan gratuit : 1 000 contacts, 4 000 envois/mois — largement assez pour démarrer."
  if ! go "Ouvrir l'inscription Loops"; then return 0; fi
  browse "$LOOPS_SIGNUP"
  info "Crée le compte (Google ou e-mail), puis crée un workspace « Cortex »."
  wait_enter "Compte et workspace créés ?"
}

step_domain() {
  title "2/3 Domaine d'envoi (cortexexam.com)"
  info "Dans Loops : Settings → Sending Domain → ajoute cortexexam.com (ou un sous-domaine,"
  info "ex. mail.cortexexam.com, pour ne pas mélanger avec Resend qui envoie déjà depuis ce domaine)."
  info "Loops donne 3 enregistrements DNS (SPF/DKIM) à poser chez Spaceship (DNS du domaine)."
  if ! go "Ouvrir les réglages Loops"; then return 0; fi
  browse "$LOOPS_SETTINGS"
  info "Cherche « Sending Domain » (ou « Domains »), ajoute le domaine, copie les 3 enregistrements DNS."
  wait_enter "Enregistrements posés chez Spaceship et domaine vérifié dans Loops ?"
}

step_key() {
  title "3/3 Clé API → Railway (LOOPS_API_KEY)"
  local has=0
  rw_has_var LOOPS_API_KEY || has=$?
  if [[ "$has" -eq 0 ]]; then
    warn "LOOPS_API_KEY est déjà posée sur Railway (production)."
    if ! go "La remplacer par une nouvelle clé"; then return 0; fi
  elif [[ "$has" -eq 2 ]]; then
    warn "Variables Railway illisibles (railway login ?) : impossible de savoir si LOOPS_API_KEY est déjà posée."
  fi
  if ! go "Ouvrir les réglages Loops (clé API)"; then return 0; fi
  browse "$LOOPS_SETTINGS"
  info "Cherche « API » (ou « API Keys ») dans les réglages, copie la clé."
  if [[ "$DRY" -eq 1 ]]; then
    info "(demanderait la clé, puis : railway variable set LOOPS_API_KEY --stdin --skip-deploys)"
    return 0
  fi
  ask_secret KEY "Colle la clé API Loops, rien ne s'affiche"
  KEY="${KEY//[[:space:]]/}"
  if [[ -z "$KEY" ]]; then warn "Rien saisi : LOOPS_API_KEY non posée."; return 0; fi
  if ! printf '%s' "$KEY" | railway variable set LOOPS_API_KEY --stdin -p "$RW_PROJECT" -e "$RW_ENV" -s "$RW_SERVICE" --skip-deploys >/dev/null 2>&1; then
    ko "Railway a refusé LOOPS_API_KEY (railway login ?)."
    return 0
  fi
  ok "LOOPS_API_KEY posée sur Railway (production) — prise au prochain déploiement."
}

main() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --dry-run) DRY=1 ;;
      -h|--help) usage; exit 0 ;;
      *) echo "✗ Option inconnue : $arg" >&2; usage >&2; exit 1 ;;
    esac
  done
  case "$-" in *x*) echo "✗ Trace d'exécution active (bash -x) : elle afficherait la clé. Relance sans." >&2; exit 1 ;; esac
  require_terminal
  trap forget_secret EXIT

  echo "Loops (emails d'onboarding) — Cortex$([[ "$DRY" -eq 1 ]] && echo '  (ESSAI À BLANC : rien n'\''est ouvert, copié ni écrit)')"
  if [[ "$DRY" -eq 0 ]]; then
    if ! command -v node >/dev/null 2>&1; then echo "✗ node est introuvable." >&2; exit 1; fi
    if ! command -v railway >/dev/null 2>&1 || ! railway whoami >/dev/null 2>&1; then
      echo "✗ CLI Railway absente ou non connectée : lance « railway login », puis relance ce script." >&2
      exit 1
    fi
  fi

  step_account
  step_domain
  step_key

  title "Récapitulatif"
  info "Sans la clé posée sur Railway, rien ne change : l'intégration reste inerte (log seulement)."
  info "Avec la clé : signup crée le contact, les autres événements partent au fil de l'usage."
  [[ "$DRY" -eq 1 ]] && echo "Essai à blanc terminé : rien n'a été ouvert, copié ni écrit."
}

main "$@"
