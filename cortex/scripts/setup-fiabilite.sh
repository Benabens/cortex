#!/usr/bin/env bash
# Fiabilité de la prod, guidé : suivi d'erreurs Sentry (offre gratuite), alerte
# e-mail, jeton Railway pour le rollback automatique, et (facultatif, PAYANT)
# previews de PR. À lancer par Ben, dans un Terminal : le script ouvre la bonne
# page, demande de coller la valeur, la pose et attend Entrée.
#
#   bash cortex/scripts/setup-fiabilite.sh
#
# Options :
#   --dry-run     essai à blanc : n'ouvre rien, ne copie rien, ne demande aucune clé, n'écrit rien nulle part
#   --etape=N     reprendre à l'étape N (1 Sentry et DSN, 2 alerte e-mail et confidentialité, 3 jeton de rollback, 4 previews de PR, 5 vérification)
#
# Chaque étape se passe : Entrée = faire, « s » = passer. Relançable sans risque :
# une variable déjà posée n'est remplacée qu'après accord. Les previews de PR
# (étape 4) coûtent de l'argent : elles ne s'activent que sur un « oui » tapé.
#
# SECRETS : le DSN Sentry et le jeton Railway sont saisis masqués, ne sont jamais
# écrits sur disque, ni affichés, ni passés en argument ou en variable
# d'environnement d'une commande : ils voyagent par l'entrée standard de curl,
# de la CLI Railway et de gh. Le DSN va à Railway (SENTRY_DSN) et à Sentry
# (erreur de test), le jeton à Railway (contrôle) et à GitHub (RAILWAY_TOKEN).
#
# Banc d'essai (faux curl, railway, gh, rien de réel) : bash cortex/scripts/setup-fiabilite.test.sh
set -euo pipefail
export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"

APP_URL="https://app.cortexexam.com"
GH_REPO="Benabens/cortex"
RW_PROJECT="d32e7d48-251b-437d-9f7a-b7a71ea58e5c"
RW_SERVICE="cortex-app"
RW_ENV="production"
RW_API="https://backboard.railway.com/graphql/v2"
RW_TOKENS_PAGE="https://railway.com/project/$RW_PROJECT/settings/tokens"
RW_ENVIRONMENTS_PAGE="https://railway.com/project/$RW_PROJECT/settings/environments"
RW_USAGE_PAGE="https://railway.com/workspace/usage"
# « orgredirect » : Sentry remplace :orgslug par l'organisation de la personne connectée.
SENTRY_SIGNUP="https://sentry.io/signup/"
SENTRY_ORG="https://sentry.io/orgredirect/organizations/:orgslug"
TOKEN_NAME="github-post-deploy"

# Un shell appelant qui exporterait une variable de ce nom la ferait hériter, avec sa valeur
# du moment, par chaque commande lancée : on repart de variables neuves, non exportées.
unset DSN RW_TOKEN HTTP_CODE HTTP_BODY key val h out body secret msg
DRY=0
FROM=1
DONE=()
SKIPPED=()
DSN=""
RW_TOKEN=""
HTTP_CODE=""
HTTP_BODY=""
ASKED_TOKEN=0

usage() { sed -n '2,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
forget_secrets() { DSN=""; RW_TOKEN=""; HTTP_BODY=""; }

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
# Accord explicite, pour ce qui coûte de l'argent : seul « oui » tapé vaut accord.
# Ni Entrée, ni une touche tapée d'avance pendant une attente (vidée ici), ni une fin de saisie.
confirm_oui() {
  local answer="" junk=""
  if [[ -t 0 ]]; then while read -rs -t 1 -n 10000 junk; do :; done; fi
  printf '→ %s  [tape « oui » pour accepter, Entrée = non] ' "$1"
  read -r answer || answer=""
  [[ -t 0 ]] || echo
  case "$answer" in oui|Oui|OUI) return 0 ;; *) return 1 ;; esac
}
wait_enter() {
  local ignored=""
  printf '   %s  [Entrée quand c'\''est fait] ' "$1"
  read -r ignored || true
  [[ -t 0 ]] || echo
}
clip() {
  if [[ "$DRY" -eq 1 ]]; then info "(copierait dans le presse-papiers : $1)"; return 0; fi
  if printf '%s' "$1" | pbcopy 2>/dev/null; then info "Dans le presse-papiers : $1"
  else warn "Presse-papiers indisponible. À copier à la main : $1"; fi
}
# Le jeton copié depuis Railway ne reste pas dans le presse-papiers.
clear_clipboard() {
  [[ "$DRY" -eq 1 ]] && return 0
  if printf '' | pbcopy 2>/dev/null; then info "Presse-papiers vidé."
  else warn "Presse-papiers non vidé : vide-le à la main."; fi
}
browse() {
  if [[ "$DRY" -eq 1 ]]; then info "(ouvrirait : $1)"; return 0; fi
  open "$1" 2>/dev/null || warn "Page non ouverte, à ouvrir à la main : $1"
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
require_terminal() {
  if [[ "$DRY" -eq 0 && ! -t 0 ]]; then
    echo "✗ À lancer dans un Terminal : le script attend des saisies au clavier (essai sans rien toucher : --dry-run)." >&2
    exit 1
  fi
}

# ───────────────────────────── HTTP et JSON ─────────────────────────────

# Lit du JSON sur l'entrée standard et écrit la valeur au bout du chemin « a.b.c »
# (rien si elle manque ou si ce n'est pas un scalaire). Texte venu du réseau : il sort sans
# caractère de contrôle ni marque de sens d'écriture, donc sans prise sur le terminal.
JS_GET='let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>{try{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v==null?v:v[k];if(v!=null&&typeof v!=="object")process.stdout.write(String(v).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g," "))}catch{}})'
json_get() { node -e "$JS_GET" "$1" 2>/dev/null || true; }

# Vrai si la liste JSON des variables Railway (objet { NOM: valeur }) contient $1.
# Les valeurs passent par le tube et ne sont jamais écrites.
JS_HAS_KEY='let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>{try{const v=JSON.parse(s);process.exit(v&&typeof v==="object"&&!Array.isArray(v)&&String(v[process.argv[1]]??"").trim()?0:1)}catch{process.exit(2)}})'

# Valeur entre guillemets d'un fichier de configuration curl : \ et " s'échappent,
# un saut de ligne s'écrit \n (curl le rétablit).
cfg_quote() {
  local v="$1"
  v=${v//\\/\\\\}
  v=${v//\"/\\\"}
  v=${v//$'\n'/\\n}
  printf '%s' "$v"
}
# Appel HTTP. L'adresse, les en-têtes et le corps (donc le jeton et le DSN) sont
# remis à curl comme un fichier de configuration lu sur son entrée standard :
# rien de secret dans ses arguments, donc rien dans « ps ». « -q » en premier :
# un ~/.curlrc (trace sur disque, redirections) ne s'applique pas.
# Résultat : HTTP_CODE et HTTP_BODY.
http_call() { # $1 = adresse, $2 = type du corps, $3 = corps, puis les en-têtes
  local url="$1" type="$2" body="$3" out h
  shift 3
  out="$(
    {
      printf 'url = "%s"\n' "$(cfg_quote "$url")"
      printf 'request = "POST"\n'
      printf 'header = "Content-Type: %s"\n' "$(cfg_quote "$type")"
      for h in "$@"; do printf 'header = "%s"\n' "$(cfg_quote "$h")"; done
      printf 'data-binary = "%s"\n' "$(cfg_quote "$body")"
    } | curl -q -sS -m 30 -o - -w '\n%{http_code}' -K - 2>/dev/null
  )" || out=$'\n000'
  HTTP_CODE="${out##*$'\n'}"
  HTTP_BODY="${out%$'\n'*}"
  [[ "$HTTP_CODE" =~ ^[0-9]{3}$ ]] || { HTTP_CODE="000"; HTTP_BODY=""; }
}
http_ok() { [[ "$HTTP_CODE" =~ ^2[0-9][0-9]$ ]]; }
# Message d'erreur d'une API : le champ prévu pour, jamais le corps brut, et
# jamais un secret (une API qui le renverrait le verrait masqué).
http_error() {
  local msg secret
  msg="$(printf '%s' "$HTTP_BODY" | json_get errors.0.message)"
  [[ -n "$msg" ]] || msg="$(printf '%s' "$HTTP_BODY" | json_get detail)"
  msg="${msg//[[:cntrl:]]/ }"
  for secret in "$DSN" "$RW_TOKEN"; do
    [[ -n "$secret" ]] && msg="${msg//"$secret"/•••}"
  done
  msg="${msg:0:200}"
  if [[ "$HTTP_CODE" == "000" ]]; then printf 'pas de réponse (réseau ?)'
  else printf 'HTTP %s%s' "$HTTP_CODE" "${msg:+ : $msg}"; fi
}
railway_gql() { # $1 = corps JSON ; jeton de projet saisi à l'étape 3
  http_call "$RW_API" "application/json" "$1" "Project-Access-Token: $RW_TOKEN"
}

# DSN de Sentry : https://<clé>@o<org>.ingest[.<région>].sentry.io/<projet>
valid_dsn() { [[ "$1" =~ ^https://[0-9a-f]{32}@o[0-9]+\.ingest(\.[a-z]{2})?\.sentry\.io/[0-9]+$ ]]; }

rw_has_var() { # $1 = nom ; 0 = posée, 1 = absente, 2 = illisible
  local rc=0
  # Si la CLI échoue, « ! » rend la sortie illisible : « illisible », pas « absente ».
  { railway variable list --json -p "$RW_PROJECT" -e "$RW_ENV" -s "$RW_SERVICE" 2>/dev/null || printf '!'; } | node -e "$JS_HAS_KEY" "$1" 2>/dev/null || rc=$?
  [[ "$rc" -le 2 ]] || rc=2
  return "$rc"
}

health_line() {
  local health status commit
  health="$(curl -q -fsS -m 10 "$APP_URL/api/health" 2>/dev/null || true)"
  status="$(printf '%s' "$health" | json_get status)"
  commit="$(printf '%s' "$health" | json_get commit)"
  if [[ "$status" != "ok" ]]; then ko "/api/health ne répond pas ok"; return 0; fi
  if [[ "$commit" =~ ^[0-9a-f]{40}$ ]]; then ok "/api/health : ok, commit ${commit:0:7} en production"
  else ok "/api/health : ok (sans commit : la version qui l'expose n'est pas encore en production)"; fi
}

# ───────────────────────────── Étapes ─────────────────────────────

ask_dsn() {
  ask_secret DSN "Colle le DSN (https://…@o….ingest….sentry.io/…), rien ne s'affiche"
  DSN="${DSN//[[:space:]]/}"
  if ! valid_dsn "$DSN"; then
    DSN=""
    ko "Ce n'est pas un DSN Sentry (attendu : https://<32 caractères>@o<chiffres>.ingest.sentry.io/<chiffres>)."
    return 1
  fi
  return 0
}

step_sentry() {
  title "1/5 Sentry : compte gratuit et DSN"
  info "Offre Developer de Sentry : gratuite, sans carte (5 000 erreurs par mois, un membre)."
  info "Sans SENTRY_DSN, l'app n'envoie rien ; avec, les erreurs serveur ET navigateur partent nettoyées"
  info "(ni e-mail, ni contenu de cours, URL sans paramètres), étiquetées du commit déployé."
  local has=0
  rw_has_var SENTRY_DSN || has=$?
  if [[ "$has" -eq 0 ]]; then
    warn "SENTRY_DSN est déjà posé sur Railway (production)."
    if ! go "Le remplacer par un nouveau DSN"; then SKIPPED+=("1 SENTRY_DSN (déjà posé, gardé)"); return 0; fi
  elif [[ "$has" -eq 2 ]]; then
    warn "Variables Railway illisibles (railway login ?) : impossible de savoir si SENTRY_DSN est déjà posé."
  fi
  if ! go "Ouvrir Sentry (création du compte ou connexion)"; then SKIPPED+=("1 Sentry et DSN"); return 0; fi
  browse "$SENTRY_SIGNUP"
  info "Crée le projet : plateforme « Next.js » (le même DSN sert au serveur et au navigateur), nom : cortex."
  info "Question des alertes : « I'll create my own alerts later » (l'étape 2 en crée une limitée à la production)."
  wait_enter "Projet créé ?"
  browse "$SENTRY_ORG/settings/projects/"
  info "Projet cortex → Client Keys (DSN) → copie le DSN."
  if [[ "$DRY" -eq 1 ]]; then
    info "(demanderait le DSN, puis : railway variable set SENTRY_DSN --stdin --skip-deploys)"
    DONE+=("1 SENTRY_DSN")
    return 0
  fi
  ask_dsn || { SKIPPED+=("1 Sentry et DSN (DSN non saisi)"); return 0; }
  if ! printf '%s' "$DSN" | railway variable set SENTRY_DSN --stdin -p "$RW_PROJECT" -e "$RW_ENV" -s "$RW_SERVICE" --skip-deploys >/dev/null 2>&1; then
    ko "Railway a refusé SENTRY_DSN (railway login ?). Relance avec --etape=1."
    SKIPPED+=("1 SENTRY_DSN (échec Railway)")
    return 0
  fi
  clear_clipboard
  ok "SENTRY_DSN posé sur Railway (production), sans redéploiement : il sera pris au prochain déploiement."
  DONE+=("1 SENTRY_DSN posé (pris au prochain déploiement)")
}

send_test_event() {
  local id host project now envelope
  id="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  host="${DSN#*@}"; host="${host%%/*}"
  project="${DSN##*/}"
  now="$(date -u +%s)"
  envelope="{\"event_id\":\"$id\",\"dsn\":\"$DSN\"}"$'\n'"{\"type\":\"event\"}"$'\n'"{\"event_id\":\"$id\",\"timestamp\":$now,\"level\":\"error\",\"platform\":\"other\",\"environment\":\"production\",\"release\":\"setup-fiabilite\",\"logger\":\"setup-fiabilite\",\"message\":\"Cortex : erreur de test (setup-fiabilite.sh), à ignorer\"}"$'\n'
  http_call "https://$host/api/$project/envelope/" "application/x-sentry-envelope" "$envelope"
}

step_alert() {
  title "2/5 Sentry : alerte e-mail et confidentialité"
  if ! go "Créer l'alerte « nouvelle erreur en production → e-mail »"; then SKIPPED+=("2 Alerte e-mail"); else
    browse "$SENTRY_ORG/alerts/new/issue/"
    info "Projet : cortex · Environment : production"
    info "WHEN : « A new issue is created » · THEN : « Send a notification to » → Member → toi (e-mail)"
    info "Nom : Cortex prod : nouvelle erreur → Save Rule."
    wait_enter "Alerte enregistrée ?"
    DONE+=("2 Alerte e-mail sur nouvelle erreur en production")
  fi
  if go "Désactiver le stockage des adresses IP chez Sentry"; then
    browse "$SENTRY_ORG/settings/security-and-privacy/"
    info "Active « Prevent Storing of IP Addresses » ; laisse « Data Scrubber » actif."
    wait_enter "C'est fait ?"
    DONE+=("2 Adresses IP non stockées chez Sentry")
  else
    SKIPPED+=("2 Adresses IP")
  fi
  if ! go "Envoyer une erreur de test à Sentry (vérifie le DSN et l'e-mail d'alerte)"; then SKIPPED+=("2 Erreur de test"); return 0; fi
  if [[ "$DRY" -eq 1 ]]; then info "(enverrait une erreur de test étiquetée « à ignorer »)"; DONE+=("2 Erreur de test"); return 0; fi
  if [[ -z "$DSN" ]]; then
    browse "$SENTRY_ORG/settings/projects/"
    ask_dsn || { SKIPPED+=("2 Erreur de test (DSN non saisi)"); return 0; }
  fi
  send_test_event
  if http_ok; then
    ok "Sentry a accepté l'erreur de test : l'e-mail d'alerte arrive d'ici quelques minutes (sinon, revois l'alerte)."
    DONE+=("2 Erreur de test acceptée par Sentry")
  else
    ko "Sentry refuse l'erreur de test ($(http_error)) : DSN à revoir (Client Keys)."
    SKIPPED+=("2 Erreur de test (échec)")
  fi
}

step_token() {
  title "3/5 Rollback automatique : jeton Railway → secret GitHub RAILWAY_TOKEN"
  info "Après chaque déploiement, la workflow post-deploy teste la prod en lecture seule ; si elle casse,"
  info "elle remet en ligne le déploiement précédent. Il lui faut un jeton de PROJET limité à production."
  if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
    ko "gh absent ou non connecté : lance « gh auth login », puis relance avec --etape=3."
    SKIPPED+=("3 Jeton de rollback (gh non connecté)")
    return 0
  fi
  if ! go "Créer le jeton dans Railway"; then SKIPPED+=("3 Jeton de rollback"); return 0; fi
  browse "$RW_TOKENS_PAGE"
  info "Create Token : nom « $TOKEN_NAME », Environment : production → Create, puis copie le jeton."
  clip "$TOKEN_NAME"
  if [[ "$DRY" -eq 1 ]]; then
    info "(demanderait le jeton, le vérifierait auprès de Railway, puis gh secret set RAILWAY_TOKEN)"
    DONE+=("3 Jeton de rollback")
    return 0
  fi
  ask_secret RW_TOKEN "Colle le jeton, rien ne s'affiche"
  RW_TOKEN="${RW_TOKEN//[[:space:]]/}"
  ASKED_TOKEN=1
  if [[ ! "$RW_TOKEN" =~ ^[A-Za-z0-9-]{20,}$ ]]; then
    ko "Jeton vide ou illisible. Relance avec --etape=3."
    SKIPPED+=("3 Jeton de rollback (non saisi)")
    return 0
  fi
  railway_gql '{"query":"query { projectToken { projectId environmentId } }"}'
  local project env_id env_name
  project="$(printf '%s' "$HTTP_BODY" | json_get data.projectToken.projectId)"
  env_id="$(printf '%s' "$HTTP_BODY" | json_get data.projectToken.environmentId)"
  if ! http_ok || [[ "$project" != "$RW_PROJECT" ]]; then
    ko "Railway ne reconnaît pas ce jeton comme un jeton du projet Cortex ($(http_error)). Rien n'est posé."
    SKIPPED+=("3 Jeton de rollback (refusé)")
    return 0
  fi
  [[ "$env_id" =~ ^[A-Za-z0-9-]+$ ]] || env_id=""
  railway_gql "{\"query\":\"query(\$id: String!) { environment(id: \$id) { name } }\",\"variables\":{\"id\":\"$env_id\"}}"
  env_name="$(printf '%s' "$HTTP_BODY" | json_get data.environment.name)"
  if [[ "$env_name" != "$RW_ENV" ]]; then
    ko "Ce jeton vise l'environnement « ${env_name:-inconnu} », pas production. Recrée-le avec Environment : production."
    SKIPPED+=("3 Jeton de rollback (mauvais environnement)")
    return 0
  fi
  ok "Jeton valide : projet Cortex, environnement production."
  if ! printf '%s' "$RW_TOKEN" | gh secret set RAILWAY_TOKEN --repo "$GH_REPO" >/dev/null 2>&1; then
    ko "GitHub a refusé le secret (droits sur $GH_REPO ?). Relance avec --etape=3."
    SKIPPED+=("3 Jeton de rollback (échec GitHub)")
    return 0
  fi
  RW_TOKEN=""
  clear_clipboard
  ok "Secret RAILWAY_TOKEN posé sur $GH_REPO."
  DONE+=("3 Secret GitHub RAILWAY_TOKEN (rollback automatique)")
}

step_previews() {
  title "4/5 Previews de PR sur Railway : PAYANT, facultatif"
  warn "Chaque PR ouverte ferait tourner une copie de l'app et une Postgres neuve, facturées à l'usage."
  warn "Plan Hobby : 5 \$ inclus par mois, et la prod seule est déjà estimée au-dessus (≈ 5,78 \$)."
  info "Alternative gratuite, déjà en place : la CI rejoue les parcours Playwright sur chaque PR, contre"
  info "un build local de la PR (workflow e2e). La preview ajoute seulement le test sur l'infra Railway."
  if ! confirm_oui "Activer les previews de PR (dépense réelle)"; then
    SKIPPED+=("4 Previews de PR (non activées : la CI E2E reste le filet gratuit)")
    return 0
  fi
  browse "$RW_USAGE_PAGE"
  info "D'abord un plafond : Usage → Usage limits → Hard limit (par exemple 10 \$)."
  wait_enter "Plafond posé ?"
  browse "$RW_ENVIRONMENTS_PAGE"
  info "PR Environments : Enable · Base environment : production · PR des bots : non."
  info "Le démarrage des previews est déjà prévu (railway.json → scripts/preview-entrypoint.sh) :"
  info "secrets de la prod retirés, base vierge, LLM hermétique, Stripe test seul."
  wait_enter "Activé ?"
  DONE+=("4 Previews de PR activées (plafond de dépense posé)")
}

step_verify() {
  title "5/5 Vérification"
  health_line
  if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
    warn "gh non connecté : vérification de GitHub sautée."
    return 0
  fi
  if gh secret list --repo "$GH_REPO" 2>/dev/null | grep -q '^RAILWAY_TOKEN[[:space:]]'; then ok "Secret RAILWAY_TOKEN présent sur $GH_REPO"
  else warn "Secret RAILWAY_TOKEN absent : le smoke tourne, mais sans rollback (étape 3)."; fi
  if ! gh workflow view post-deploy.yml --repo "$GH_REPO" >/dev/null 2>&1; then
    info "La workflow post-deploy n'est pas encore sur main : après le merge, relance avec --etape=5."
    return 0
  fi
  if ! go "Lancer post-deploy à blanc (smoke de la prod + rollback simulé, rien n'est modifié)"; then SKIPPED+=("5 post-deploy à blanc"); return 0; fi
  if [[ "$DRY" -eq 1 ]]; then info "(lancerait : gh workflow run post-deploy.yml -f dry_run=true)"; DONE+=("5 post-deploy à blanc"); return 0; fi
  if gh workflow run post-deploy.yml --repo "$GH_REPO" -f dry_run=true >/dev/null 2>&1; then
    ok "Lancée. Suivi : gh run watch --repo $GH_REPO (ou l'onglet Actions)."
    browse "https://github.com/$GH_REPO/actions/workflows/post-deploy.yml"
    DONE+=("5 post-deploy à blanc lancée")
  else
    ko "GitHub refuse de lancer la workflow."
    SKIPPED+=("5 post-deploy à blanc (échec)")
  fi
}

recap() {
  title "Récapitulatif"
  local line
  if [[ "${#DONE[@]}" -gt 0 ]]; then
    for line in "${DONE[@]}"; do
      if [[ "$DRY" -eq 1 ]]; then info "· déroulé à blanc : $line"; else ok "$line"; fi
    done
  fi
  if [[ "${#SKIPPED[@]}" -gt 0 ]]; then for line in "${SKIPPED[@]}"; do info "· passé : $line"; done; fi
  if [[ "$ASKED_TOKEN" -eq 1 ]]; then info "Le jeton Railway n'est gardé que par GitHub : en cas de doute, révoque-le dans Project Settings → Tokens."; fi
  [[ "$DRY" -eq 1 ]] && echo "Essai à blanc terminé : rien n'a été ouvert, copié ni écrit."
  return 0
}

main() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --dry-run) DRY=1 ;;
      --etape=[1-5]) FROM="${arg#--etape=}" ;;
      -h|--help) usage; exit 0 ;;
      *) echo "✗ Option inconnue : $arg" >&2; usage >&2; exit 1 ;;
    esac
  done
  # Une trace d'exécution (bash -x) recopierait les clés à l'écran.
  case "$-" in *x*) echo "✗ Trace d'exécution active (bash -x) : elle afficherait les clés. Relance sans." >&2; exit 1 ;; esac
  require_terminal
  trap forget_secrets EXIT

  echo "Fiabilité de la prod Cortex$([[ "$DRY" -eq 1 ]] && echo '  (ESSAI À BLANC : rien n'\''est ouvert, copié ni écrit)')"
  if ! command -v node >/dev/null 2>&1; then echo "✗ node est introuvable." >&2; exit 1; fi
  if ! command -v railway >/dev/null 2>&1 || ! railway whoami >/dev/null 2>&1; then
    if [[ "$DRY" -eq 1 ]]; then warn "CLI Railway absente ou non connectée (railway login) : l'étape 1 en aura besoin."
    else echo "✗ CLI Railway absente ou non connectée : lance « railway login », puis relance ce script." >&2; exit 1; fi
  fi

  if should_run 1; then step_sentry; fi
  if should_run 2; then step_alert; fi
  if should_run 3; then step_token; fi
  if should_run 4; then step_previews; fi
  step_verify
  recap
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
