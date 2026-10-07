#!/usr/bin/env bash
# E-mails de Cortex par Resend, guidé : compte, domaine cortexexam.com, DNS chez
# Spaceship, vérification, clé d'envoi posée sur Railway, e-mail de test. À lancer
# par Ben, dans un Terminal. Il n'y a rien à faire d'autre que coller des clés :
# le script ouvre la bonne page, appelle les API et attend Entrée.
#
#   bash scripts/resend-ben.sh
#
# Options :
#   --dry-run     essai à blanc : n'ouvre rien, ne copie rien, ne demande aucune clé, n'écrit rien nulle part
#   --etape=N     reprendre à l'étape N (1 compte et clé, 2 domaine, 3 DNS, 4 vérification, 5 clé d'envoi et Railway, 6 test et récap)
#
# Chaque étape se passe : Entrée = faire, « s » = passer. Relançable sans risque :
# un domaine déjà créé est réutilisé, un enregistrement DNS déjà posé est laissé
# tel quel, et aucun enregistrement existant n'est modifié ni supprimé.
#
# SECRETS : les clés (Resend, Spaceship) sont saisies masquées, ne sont jamais
# écrites sur disque, ni affichées, ni passées en argument ou en variable
# d'environnement d'une commande : elles voyagent par l'entrée standard de curl
# et de la CLI Railway. Elles vont à Resend, à Spaceship et à Railway, et nulle
# part ailleurs. La clé d'envoi de l'app est créée par l'API et posée sur
# Railway sans jamais être montrée.
#
# Banc d'essai (faux curl, fausse CLI Railway, rien de réel) : bash scripts/resend-ben.test.sh
set -euo pipefail
export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"

APP_URL="https://app.cortexexam.com"
DOMAIN="cortexexam.com"
REGION="eu-west-1"
FROM_ADDR="Cortex <noreply@cortexexam.com>"
TEST_TO="abensur.benjamin@gmail.com"
SETUP_KEY_NAME="cortex-setup"
SEND_KEY_NAME="cortex-app"
DNS_KEY_NAME="cortex-dns"
RESEND_API="https://api.resend.com"
SPACESHIP_API="https://spaceship.dev/api/v1"
SPACESHIP_API_PAGE="https://www.spaceship.com/application/api-manager/"
SPACESHIP_DNS_PAGE="https://www.spaceship.com/application/advanced-dns-application/manage/$DOMAIN/"
RW_PROJECT="d32e7d48-251b-437d-9f7a-b7a71ea58e5c"
RW_SERVICE="cortex-app"
RW_ENV="production"

DRY=0
FROM=1
DONE=()
SKIPPED=()
SETUP_KEY=""
SEND_KEY=""
SS_KEY=""
SS_SECRET=""
DOMAIN_ID=""
DOMAIN_JSON=""
DOMAIN_STATUS=""
HTTP_CODE=""
HTTP_BODY=""
PREVIOUS_DEPLOY=""

usage() { sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
forget_secrets() { SETUP_KEY=""; SEND_KEY=""; SS_KEY=""; SS_SECRET=""; HTTP_BODY=""; }

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
# La dernière clé copiée depuis une console ne reste pas dans le presse-papiers.
clear_clipboard() {
  [[ "$DRY" -eq 1 ]] && return 0
  printf '' | pbcopy
  info "Presse-papiers vidé."
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
require_terminal() {
  if [[ "$DRY" -eq 0 && ! -t 0 ]]; then
    echo "✗ À lancer dans un Terminal : le script attend des saisies au clavier (essai sans rien toucher : --dry-run)." >&2
    exit 1
  fi
}

# ───────────────────────────── HTTP et JSON ─────────────────────────────

# Lit du JSON sur l'entrée standard et écrit la valeur au bout du chemin « a.b.c »
# (rien si elle manque ou si ce n'est pas un scalaire).
JS_GET='let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>{try{let v=JSON.parse(s);for(const k of process.argv[1].split("."))v=v==null?v:v[k];if(v!=null&&typeof v!=="object")process.stdout.write(String(v))}catch{}})'
json_get() { node -e "$JS_GET" "$1" 2>/dev/null || true; }

# Dans une liste Resend {data:[…]}, les éléments dont `name` vaut $1 : « id statut région » par ligne.
JS_NAMED='let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>{try{for(const x of JSON.parse(s).data||[])if(x&&x.name===process.argv[1])console.log([x.id,x.status||"-",x.region||"-"].join(" "))}catch{}})'
named_in_list() { node -e "$JS_NAMED" "$1" 2>/dev/null || true; }

# Valeur entre guillemets d'un fichier de configuration curl : seuls \ et " s'échappent.
cfg_quote() {
  local v="$1"
  v=${v//\\/\\\\}
  v=${v//\"/\\\"}
  printf '%s' "$v"
}
# Appel HTTP. L'adresse, les en-têtes (donc les clés) et le corps sont remis à curl
# comme un fichier de configuration lu sur son entrée standard : rien de secret
# dans ses arguments, donc rien dans « ps ». Résultat : HTTP_CODE et HTTP_BODY.
http_call() { # $1 = méthode, $2 = adresse, $3 = corps JSON ou vide, puis les en-têtes
  local method="$1" url="$2" body="$3" out h
  shift 3
  out="$(
    {
      printf 'url = "%s"\n' "$(cfg_quote "$url")"
      printf 'request = "%s"\n' "$method"
      for h in "$@"; do printf 'header = "%s"\n' "$(cfg_quote "$h")"; done
      if [[ -n "$body" ]]; then
        printf 'header = "Content-Type: application/json"\n'
        printf 'data = "%s"\n' "$(cfg_quote "$body")"
      fi
    } | curl -sS -m 30 -o - -w '\n%{http_code}' -K - 2>/dev/null
  )" || out=$'\n000'
  HTTP_CODE="${out##*$'\n'}"
  HTTP_BODY="${out%$'\n'*}"
  [[ "$HTTP_CODE" =~ ^[0-9]{3}$ ]] || { HTTP_CODE="000"; HTTP_BODY=""; }
}
http_ok() { [[ "$HTTP_CODE" =~ ^2[0-9][0-9]$ ]]; }
# Message d'erreur d'une API : le champ prévu pour, jamais le corps brut, et
# jamais une clé (une API qui la renverrait la verrait masquée).
http_error() {
  local msg secret
  msg="$(printf '%s' "$HTTP_BODY" | json_get message)"
  [[ -n "$msg" ]] || msg="$(printf '%s' "$HTTP_BODY" | json_get detail)"
  # Texte venu du réseau : sans caractère de contrôle, il ne peut pas piloter le terminal.
  msg="${msg//[[:cntrl:]]/ }"
  msg="${msg:0:200}"
  for secret in "$SETUP_KEY" "$SEND_KEY" "$SS_KEY" "$SS_SECRET"; do
    [[ -n "$secret" ]] && msg="${msg//"$secret"/•••}"
  done
  if [[ "$HTTP_CODE" == "000" ]]; then printf 'pas de réponse (réseau ?)'
  else printf 'HTTP %s%s' "$HTTP_CODE" "${msg:+ : $msg}"; fi
}
resend() { # $1 = méthode, $2 = chemin, $3 = corps (facultatif), $4 = clé (défaut : clé de mise en place)
  local key="${4:-$SETUP_KEY}"
  http_call "$1" "$RESEND_API$2" "${3:-}" "Authorization: Bearer $key"
  # Resend limite le nombre d'appels par seconde : une seconde tentative suffit.
  if [[ "$HTTP_CODE" == "429" ]]; then sleep 2; http_call "$1" "$RESEND_API$2" "${3:-}" "Authorization: Bearer $key"; fi
}
spaceship() { # $1 = méthode, $2 = chemin, $3 = corps (facultatif)
  http_call "$1" "$SPACESHIP_API$2" "${3:-}" "X-API-Key: $SS_KEY" "X-API-Secret: $SS_SECRET"
}

# ───────────────────────────── Resend ─────────────────────────────

# Une clé collée ne part dans un en-tête que si elle en a la forme.
valid_secret() { [[ -n "$1" && ! "$1" =~ [[:space:][:cntrl:]] ]]; }

# Clé de mise en place (« Full access ») : demandée une fois, vérifiée par une lecture.
need_setup_key() {
  [[ -n "$SETUP_KEY" ]] && return 0
  while :; do
    ask_secret SETUP_KEY "Colle la clé « $SETUP_KEY_NAME » (re_… ; vide = passer)"
    if [[ -z "$SETUP_KEY" ]]; then return 1; fi
    if [[ ! "$SETUP_KEY" =~ ^re_[A-Za-z0-9_-]+$ ]]; then
      SETUP_KEY=""; ko "Ce n'est pas une clé Resend (elle commence par re_)."; continue
    fi
    resend GET "/domains?limit=100"
    if http_ok; then clear_clipboard; ok "Clé acceptée par Resend."; return 0; fi
    if [[ "$HTTP_CODE" == "401" || "$HTTP_CODE" == "403" ]]; then
      ko "Resend refuse cette clé ($(http_error)). Il faut une clé « Full access », pas « Sending access »."
    else
      ko "Resend ne répond pas comme attendu ($(http_error))."
    fi
    SETUP_KEY=""
  done
}

# Cherche le domaine chez Resend, sans le créer. Renseigne DOMAIN_ID, DOMAIN_JSON et DOMAIN_STATUS.
find_domain() {
  local line
  DOMAIN_ID=""; DOMAIN_JSON=""; DOMAIN_STATUS=""
  resend GET "/domains?limit=100"
  http_ok || { ko "Liste des domaines illisible ($(http_error))."; return 1; }
  line="$(printf '%s' "$HTTP_BODY" | named_in_list "$DOMAIN" | head -1)"
  [[ -n "$line" ]] || return 2
  # L'identifiant vient d'une réponse HTTP : il n'entre dans une adresse que s'il en a la forme.
  [[ "${line%% *}" =~ ^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$ ]] || { ko "Identifiant de domaine inattendu."; return 1; }
  DOMAIN_ID="${line%% *}"
  load_domain
}
load_domain() {
  resend GET "/domains/$DOMAIN_ID"
  http_ok || { ko "Domaine illisible ($(http_error))."; return 1; }
  DOMAIN_JSON="$HTTP_BODY"
  DOMAIN_STATUS="$(printf '%s' "$DOMAIN_JSON" | json_get status)"
  [[ "$DOMAIN_STATUS" =~ ^[a-z_]{1,40}$ ]] || DOMAIN_STATUS="inconnu"
}
# Le domaine doit exister chez Resend (étape 2) : vrai s'il est connu et chargé.
need_domain() {
  [[ -n "$DOMAIN_ID" && -n "$DOMAIN_JSON" ]] && return 0
  local rc=0
  find_domain || rc=$?
  [[ "$rc" -eq 2 ]] && ko "$DOMAIN n'existe pas encore chez Resend : lance d'abord l'étape 2 (--etape=2)."
  return "$rc"
}

# ───────────────────────────── DNS ─────────────────────────────

# Compare les enregistrements voulus par Resend à la zone lue chez Spaceship.
# Entrée : {domain, records, existing, after}. Sortie selon le mode ($1) :
#   check  « ok » si l'entrée est lisible et que Resend demande au moins un enregistrement
#   show   une ligne lisible par enregistrement voulu, avec son état
#   todo   « type␟hôte␟valeur␟priorité␟état » par enregistrement voulu (␟ = 0x1f)
#   body   le corps du PUT Spaceship pour ceux qui manquent (rien s'il n'y en a pas)
#   lost   les enregistrements présents avant (existing) et absents après (after)
#   restore le corps du PUT Spaceship qui remet ces enregistrements perdus
# États : present (identique, déjà là), missing (à ajouter), conflict (le même
# nom porte déjà autre chose du même type, ou un CNAME : on n'y touche pas).
JS_PLAN='
let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
  const mode = process.argv[1];
  let input; try { input = JSON.parse(s); } catch { process.exit(3); }
  const domain = String(input.domain).toLowerCase();
  const host = (n) => { n = String(n == null ? "" : n).toLowerCase().replace(/\.$/, ""); if (n === domain || n === "" || n === "@") return "@"; return n.endsWith("." + domain) ? n.slice(0, -domain.length - 1) : n; };
  const unquote = (v) => { v = String(v == null ? "" : v).trim(); return v.length >= 2 && v.startsWith("\"") && v.endsWith("\"") ? v.slice(1, -1) : v; };
  const fqdn = (v) => String(v == null ? "" : v).toLowerCase().replace(/\.$/, "");
  const clean = (v) => String(v).replace(/[\u0000-\u001f\u007f]/g, " ");
  const data = (r) => r.type === "TXT" ? unquote(r.value) : r.type === "MX" ? fqdn(r.exchange) + " " + Number(r.preference) : r.type === "CNAME" ? fqdn(r.cname) : r.type === "A" || r.type === "AAAA" ? fqdn(r.address) : JSON.stringify(Object.keys(r).filter((k) => !["type", "name", "ttl", "group"].includes(k)).sort().map((k) => [k, r[k]]));
  const key = (r) => [String(r.type).toUpperCase(), host(r.name), data(r)].join(" ");
  const items = (list) => (list && Array.isArray(list.items) ? list.items : []).map((r) => Object.assign({}, r, { type: String(r.type).toUpperCase() }));
  const existing = items(input.existing);
  if (mode === "lost" || mode === "restore") {
    const after = new Set(items(input.after).map(key));
    const lost = existing.filter((r) => !after.has(key(r)));
    if (mode === "lost") for (const r of lost) console.log(clean(key(r)));
    else if (lost.length) process.stdout.write(JSON.stringify({ force: false, items: lost.map((r) => { const { group, ...rest } = r; return rest; }) }));
    return;
  }
  const wanted = ((input.records && input.records.records) || []).map((r) => {
    const type = String(r.type).toUpperCase();
    const w = { type, name: host(r.name), ttl: 3600 };
    if (type === "MX") { w.exchange = fqdn(r.value); w.preference = Number.isFinite(Number(r.priority)) ? Number(r.priority) : 10; }
    else if (type === "CNAME") w.cname = fqdn(r.value);
    else w.value = unquote(r.value);
    return w;
  }).filter((w) => ["MX", "TXT", "CNAME"].includes(w.type) && w.name && (w.exchange || w.cname || w.value));
  if (mode === "check") { if (wanted.length) console.log("ok"); return; }
  const state = (w) => {
    if (existing.some((r) => key(r) === key(w))) return "present";
    const same = existing.filter((r) => host(r.name) === w.name);
    if (same.some((r) => r.type === "CNAME") || (w.type === "CNAME" && same.length) || same.some((r) => r.type === w.type)) return "conflict";
    return "missing";
  };
  const label = { present: "déjà en place", missing: "à ajouter", conflict: "CONFLIT : ce nom porte déjà autre chose" };
  const value = (w) => w.type === "MX" ? w.exchange : w.type === "CNAME" ? w.cname : w.value;
  const short = (v) => (v.length > 56 ? v.slice(0, 53) + "…" : v);
  if (mode === "show") for (const w of wanted) console.log(clean(`${w.type.padEnd(5)} ${w.name.padEnd(22)} ${short(value(w))}${w.type === "MX" ? ` (priorité ${w.preference})` : ""}${input.existing ? `  → ${label[state(w)]}` : ""}`));
  if (mode === "todo") for (const w of wanted) console.log([w.type, w.name, value(w), w.type === "MX" ? w.preference : "-", input.existing ? state(w) : "missing"].map(clean).join("\u001f"));
  if (mode === "body") { const add = wanted.filter((w) => state(w) === "missing"); if (add.length) process.stdout.write(JSON.stringify({ force: false, items: add })); }
});'
SS_BEFORE=""
SS_AFTER=""
dns_plan() { # $1 = mode
  printf '{"domain":"%s","records":%s,"existing":%s,"after":%s}' "$DOMAIN" "${DOMAIN_JSON:-null}" "${SS_BEFORE:-null}" "${SS_AFTER:-null}" | node -e "$JS_PLAN" "$1"
}
count_state() { dns_plan todo | awk -F $'\x1f' -v want="$1" '$5 == want { n++ } END { print n + 0 }'; }
# Sans plan lisible, un compte vide passerait pour « rien à faire » : on vérifie avant de s'y fier.
plan_ok() { [[ "$(dns_plan check 2>/dev/null || true)" == "ok" ]]; }

# Zone complète lue chez Spaceship dans la variable nommée. Échoue si la zone ne tient pas en une page :
# sans tout voir, on ne peut pas garantir qu'on n'écrase rien.
read_zone() { # $1 = variable
  local total got
  spaceship GET "/dns/records/$DOMAIN?take=500&skip=0"
  http_ok || { ko "Spaceship ne donne pas la zone ($(http_error))."; return 1; }
  total="$(printf '%s' "$HTTP_BODY" | json_get total)"
  got="$(printf '%s' "$HTTP_BODY" | node -e 'let s="";process.stdin.on("data",(c)=>(s+=c)).on("end",()=>{try{const i=JSON.parse(s).items;console.log(Array.isArray(i)?i.length:"")}catch{console.log("")}})')"
  [[ "$got" =~ ^[0-9]+$ ]] || { ko "Réponse de Spaceship inattendue."; return 1; }
  if [[ "$total" =~ ^[0-9]+$ && "$total" -gt "$got" ]]; then ko "La zone a plus d'enregistrements ($total) que la page lue ($got)."; return 1; fi
  printf -v "$1" '%s' "$HTTP_BODY"
}

# Pose par l'API Spaceship les enregistrements qui manquent, et seulement eux.
# Renvoie 0 si tous sont en place, 1 si l'API n'a pas pu servir (repli manuel).
dns_auto() {
  local body lost missing conflicts
  read_zone SS_BEFORE || return 1
  plan_ok || { ko "Enregistrements de Resend ou zone Spaceship illisibles."; return 1; }
  dns_plan show | sed 's/^/     /'
  conflicts="$(count_state conflict)"
  missing="$(count_state missing)"
  if [[ "$missing" -gt 0 ]]; then
    body="$(dns_plan body)"
    # « force: false » : Spaceship garde son contrôle de conflits. On n'envoie que les ajouts.
    spaceship PUT "/dns/records/$DOMAIN" "$body"
    http_ok || { ko "Spaceship refuse l'ajout ($(http_error))."; return 1; }
    if ! read_zone SS_AFTER; then
      warn "Ajout accepté par Spaceship, mais la zone n'a pas pu être relue : vérifie à l'œil que tout y est (la page s'ouvre)."
      browse "$SPACESHIP_DNS_PAGE"
      wait_enter "Vérifie les enregistrements « send » et « resend._domainkey », et que les anciens sont toujours là."
      return 0
    fi
    lost="$(dns_plan lost)"
    if [[ -n "$lost" ]]; then
      # Ce script n'envoie que des ajouts : si la zone a perdu quelque chose, on le remet tout de suite.
      ko "Des enregistrements présents avant l'ajout ne sont plus dans la zone :"
      printf '%s\n' "$lost" | sed 's/^/       /'
      spaceship PUT "/dns/records/$DOMAIN" "$(dns_plan restore)"
      if http_ok && read_zone SS_AFTER && [[ -z "$(dns_plan lost)" ]]; then
        ok "Remis en place par l'API, à l'identique."
      else
        ko "Ils n'ont pas pu être remis par l'API : remets-les à la main tout de suite (la page s'ouvre)."
        browse "$SPACESHIP_DNS_PAGE"
        wait_enter "Remets les enregistrements listés ci-dessus."
      fi
    fi
    SS_BEFORE="$SS_AFTER"; SS_AFTER=""
    missing="$(count_state missing)"
    [[ "$missing" -eq 0 ]] || { ko "$missing enregistrement(s) toujours absent(s) après l'ajout."; return 1; }
    ok "Enregistrements de Resend ajoutés ; les autres n'ont pas bougé."
  else
    ok "Rien à ajouter."
  fi
  if [[ "$conflicts" -gt 0 ]]; then
    warn "$conflicts enregistrement(s) en conflit, laissé(s) tel(s) quel(s) : à trancher à la main (la page s'ouvre)."
    dns_manual conflict
    return 0
  fi
  return 0
}

# Repli : chaque enregistrement à poser à la main, hôte puis valeur dans le presse-papiers.
dns_manual() { # $1 = état à traiter (missing par défaut)
  local want="${1:-missing}" type host value prio state n=0 total
  plan_ok || { ko "Enregistrements de Resend illisibles : relance avec --etape=2."; return 1; }
  total="$(count_state "$want")"
  [[ "$total" -gt 0 ]] || { ok "Aucun enregistrement à poser à la main."; return 0; }
  browse "$SPACESHIP_DNS_PAGE"
  info "Dans Spaceship : Advanced DNS → $DOMAIN → « Add record ». Ne modifie aucun enregistrement existant."
  [[ "$want" == "conflict" ]] && info "Conflit : un enregistrement du même type existe déjà sous ce nom. Ne le remplace que s'il vient d'un ancien essai Resend."
  while IFS=$'\x1f' read -r type host value prio state <&3; do
    [[ "$state" == "$want" ]] || continue
    n=$((n + 1))
    info "Enregistrement $n/$total : type $type$([[ "$prio" != "-" ]] && echo ", priorité $prio"), TTL 60 min."
    clip "$host"
    wait_enter "Choisis le type $type et colle l'hôte (Host)."
    clip "$value"
    wait_enter "Colle la valeur$([[ "$prio" != "-" ]] && echo ", mets la priorité $prio"), puis enregistre."
  done 3< <(dns_plan todo)
}

# ───────────────────────────── Railway ─────────────────────────────

# « id statut » du dernier déploiement Railway (vide si la CLI ne répond pas).
latest_deploy() {
  railway deployment list -p "$RW_PROJECT" -e "$RW_ENV" -s "$RW_SERVICE" --limit 1 --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{const a=JSON.parse(s);console.log(`${a[0].id} ${a[0].status}`)}catch{}})' 2>/dev/null || true
}
new_deploy_done() {
  local now
  now="$(latest_deploy)"
  [[ -n "$now" && "${now%% *}" != "$PREVIOUS_DEPLOY" && "${now##* }" == "SUCCESS" ]]
}
# Attend que la condition devienne vraie. $1 = message, $2 = fonction, $3 = nombre d'essais (10 s chacun).
wait_until() {
  local tries=0
  printf '   %s' "$1"
  while ! "$2"; do
    tries=$((tries + 1))
    if [[ "$tries" -ge "$3" ]]; then echo; return 1; fi
    printf '.'
    sleep 10
  done
  echo
}
# La page est lue en entier avant d'y chercher : « curl | grep -q » échouerait
# sous pipefail quand grep s'arrête avant la fin de l'envoi.
health_ok() {
  local body
  body="$(curl -sS -m 20 "$APP_URL/api/health" 2>/dev/null || true)"
  [[ "$body" == *'"status":"ok"'* ]]
}

# ───────────────────────────── Étapes ─────────────────────────────

step_account() {
  title "1/6 Resend : compte et clé de mise en place"
  if ! go "Ouvrir Resend et créer la clé « $SETUP_KEY_NAME »"; then SKIPPED+=("1 Compte et clé"); return 0; fi
  browse "https://resend.com/signup"
  wait_enter "Crée ton compte Resend (déjà un compte : connecte-toi sur resend.com/login)."
  browse "https://resend.com/api-keys"
  clip "$SETUP_KEY_NAME"
  info "« Create API Key » : colle le nom, permission « Full access », puis copie la clé affichée."
  if [[ "$DRY" -eq 1 ]]; then info "(demanderait la clé en saisie masquée et la vérifierait par une lecture)"; DONE+=("1 Compte Resend et clé de mise en place"); return 0; fi
  if need_setup_key; then DONE+=("1 Compte Resend et clé de mise en place"); else warn "Aucune clé saisie."; SKIPPED+=("1 Compte et clé (aucune clé)"); fi
}

step_domain() {
  local rc=0 body
  title "2/6 Resend : domaine $DOMAIN"
  if ! go "Créer le domaine $DOMAIN chez Resend (région $REGION), ou le réutiliser s'il existe"; then SKIPPED+=("2 Domaine"); return 0; fi
  if [[ "$DRY" -eq 1 ]]; then info "(chercherait $DOMAIN chez Resend, le créerait en $REGION s'il manque, et lirait ses enregistrements DNS)"; DONE+=("2 Domaine $DOMAIN chez Resend"); return 0; fi
  need_setup_key || { SKIPPED+=("2 Domaine (aucune clé)"); return 0; }
  find_domain || rc=$?
  if [[ "$rc" -eq 0 ]]; then
    ok "$DOMAIN existe déjà chez Resend (statut : $DOMAIN_STATUS) : réutilisé."
  elif [[ "$rc" -eq 2 ]]; then
    body="{\"name\":\"$DOMAIN\",\"region\":\"$REGION\"}"
    resend POST "/domains" "$body"
    if ! http_ok; then
      ko "Création refusée en $REGION ($(http_error))."
      if go "Réessayer sans préciser de région (us-east-1 par défaut)"; then resend POST "/domains" "{\"name\":\"$DOMAIN\"}"; fi
    fi
    http_ok || { ko "Le domaine n'a pas pu être créé ($(http_error)). Relance avec --etape=2."; SKIPPED+=("2 Domaine (échec)"); return 0; }
    rc=0; find_domain || rc=$?
    [[ "$rc" -eq 0 ]] || { ko "Domaine créé mais introuvable à la relecture. Relance avec --etape=2."; SKIPPED+=("2 Domaine (échec)"); return 0; }
    ok "$DOMAIN créé chez Resend."
  else
    SKIPPED+=("2 Domaine (échec)"); return 0
  fi
  if plan_ok; then
    info "Enregistrements DNS demandés par Resend :"
    dns_plan show | sed 's/^/     /'
  else
    warn "Resend n'a renvoyé aucun enregistrement DNS lisible : regarde https://resend.com/domains"
  fi
  DONE+=("2 Domaine $DOMAIN chez Resend")
}

step_dns() {
  title "3/6 Spaceship : enregistrements DNS de Resend"
  if [[ "$DRY" -eq 1 ]]; then
    if go "Poser les enregistrements de Resend dans la zone $DOMAIN"; then
      info "(ouvrirait : $SPACESHIP_API_PAGE)"
      info "(demanderait la clé et le secret d'API Spaceship, lirait la zone, n'ajouterait que les enregistrements de Resend absents, puis relirait la zone)"
      info "(si l'API échoue : chaque enregistrement un par un dans le presse-papiers, page DNS ouverte)"
      DONE+=("3 DNS chez Spaceship")
    else SKIPPED+=("3 DNS"); fi
    return 0
  fi
  if ! go "Poser les enregistrements de Resend dans la zone $DOMAIN (les existants ne sont pas touchés)"; then SKIPPED+=("3 DNS"); return 0; fi
  need_setup_key || { SKIPPED+=("3 DNS (aucune clé Resend)"); return 0; }
  need_domain || { SKIPPED+=("3 DNS (domaine inconnu)"); return 0; }
  if go "Les poser automatiquement par l'API Spaceship (sinon : à la main, un par un)"; then
    browse "$SPACESHIP_API_PAGE"
    clip "$DNS_KEY_NAME"
    info "« New API key » : colle le nom, ne coche que « dnsrecords:read » et « dnsrecords:write »."
    ask_secret SS_KEY "Colle la clé d'API Spaceship (API key ; vide = à la main)"
    [[ -n "$SS_KEY" ]] && ask_secret SS_SECRET "Colle le secret d'API Spaceship (API secret)"
    clear_clipboard
    if valid_secret "$SS_KEY" && valid_secret "$SS_SECRET"; then
      if dns_auto; then
        SS_KEY=""; SS_SECRET=""
        DONE+=("3 DNS chez Spaceship : enregistrements de Resend en place")
        info "La clé « $DNS_KEY_NAME » ne sert plus : tu peux la supprimer dans l'API Manager de Spaceship."
        return 0
      fi
      warn "L'API Spaceship n'a pas suffi : on continue à la main."
    else
      warn "Clé ou secret Spaceship vide ou mal formé : on continue à la main."
    fi
    SS_KEY=""; SS_SECRET=""
  fi
  # Repli : sans lecture de la zone, tous les enregistrements sont proposés.
  SS_BEFORE=""
  if dns_manual missing; then DONE+=("3 DNS chez Spaceship : enregistrements posés à la main"); else SKIPPED+=("3 DNS (enregistrements illisibles)"); fi
}

step_verify() {
  local tries=0
  title "4/6 Resend : vérification du domaine"
  if ! go "Demander la vérification à Resend et attendre qu'elle passe"; then SKIPPED+=("4 Vérification"); return 0; fi
  if [[ "$DRY" -eq 1 ]]; then info "(déclencherait la vérification, puis relirait le statut toutes les 10 s pendant 10 minutes au plus)"; DONE+=("4 Vérification du domaine"); return 0; fi
  need_setup_key || { SKIPPED+=("4 Vérification (aucune clé)"); return 0; }
  need_domain || { SKIPPED+=("4 Vérification (domaine inconnu)"); return 0; }
  if [[ "$DOMAIN_STATUS" == "verified" ]]; then ok "Domaine déjà vérifié."; DONE+=("4 Domaine vérifié"); return 0; fi
  resend POST "/domains/$DOMAIN_ID/verify"
  http_ok || { ko "Resend refuse de lancer la vérification ($(http_error)). Relance avec --etape=4."; SKIPPED+=("4 Vérification (échec)"); return 0; }
  printf '   Attente de la vérification'
  while :; do
    load_domain >/dev/null 2>&1 || DOMAIN_STATUS=""
    [[ "$DOMAIN_STATUS" == "verified" || "$DOMAIN_STATUS" == "failed" ]] && break
    tries=$((tries + 1))
    [[ "$tries" -ge 60 ]] && break
    printf '.'
    sleep 10
  done
  echo
  if [[ "$DOMAIN_STATUS" == "verified" ]]; then
    ok "Domaine vérifié par Resend."
    DONE+=("4 Domaine vérifié")
    return 0
  fi
  if [[ "$DOMAIN_STATUS" == "failed" ]]; then ko "Resend déclare la vérification en échec : un enregistrement DNS manque ou diffère."
  else ko "Pas encore vérifié après 10 minutes (statut : ${DOMAIN_STATUS:-inconnu})."; fi
  info "Les DNS mettent parfois jusqu'à une heure à se propager. Rien n'est perdu : relance avec --etape=4."
  info "État vu par Resend, enregistrement par enregistrement : https://resend.com/domains"
  SKIPPED+=("4 Vérification (pas encore passée)")
}

step_key() {
  local token others
  title "5/6 Railway : clé d'envoi de l'app et adresse d'expédition"
  if ! go "Créer la clé d'envoi « $SEND_KEY_NAME » (limitée à $DOMAIN) et la poser sur Railway avec AUTH_EMAIL_FROM"; then SKIPPED+=("5 Clé d'envoi"); return 0; fi
  if [[ "$DRY" -eq 1 ]]; then
    info "(créerait une clé « Sending access » limitée à $DOMAIN, la poserait sur Railway comme RESEND_API_KEY par l'entrée standard)"
    info "(poserait AUTH_EMAIL_FROM=$FROM_ADDR, redéploierait une fois et attendrait la fin du déploiement)"
    DONE+=("5 Clé d'envoi et adresse d'expédition sur Railway"); return 0
  fi
  need_setup_key || { SKIPPED+=("5 Clé d'envoi (aucune clé)"); return 0; }
  need_domain || { SKIPPED+=("5 Clé d'envoi (domaine inconnu)"); return 0; }
  load_domain >/dev/null 2>&1 || true
  # Une clé limitée à un domaine non vérifié ne peut rien envoyer : on ne la met pas en production.
  if [[ "$DOMAIN_STATUS" != "verified" ]]; then
    ko "Le domaine n'est pas encore vérifié (statut : ${DOMAIN_STATUS:-inconnu}) : fais d'abord l'étape 4 (--etape=4)."
    SKIPPED+=("5 Clé d'envoi (domaine non vérifié)"); return 0
  fi
  resend GET "/api-keys"
  others="$(printf '%s' "$HTTP_BODY" | named_in_list "$SEND_KEY_NAME" | wc -l | tr -d ' ')"
  if [[ "$others" -gt 0 ]]; then
    warn "$others clé(s) « $SEND_KEY_NAME » existe(nt) déjà chez Resend : une nouvelle va la remplacer sur Railway."
    go "Continuer (l'ancienne sera à supprimer à la fin)" || { SKIPPED+=("5 Clé d'envoi (déjà en place)"); return 0; }
  fi
  resend POST "/api-keys" "{\"name\":\"$SEND_KEY_NAME\",\"permission\":\"sending_access\",\"domain_id\":\"$DOMAIN_ID\"}"
  http_ok || { ko "Resend refuse de créer la clé d'envoi ($(http_error)). Relance avec --etape=5."; SKIPPED+=("5 Clé d'envoi (échec)"); return 0; }
  token="$(printf '%s' "$HTTP_BODY" | json_get token)"
  HTTP_BODY=""
  if [[ ! "$token" =~ ^re_[A-Za-z0-9_-]+$ ]]; then
    ko "Réponse de Resend inattendue : aucune clé d'envoi reçue. Relance avec --etape=5."
    SKIPPED+=("5 Clé d'envoi (échec)"); return 0
  fi
  SEND_KEY="$token"; token=""
  PREVIOUS_DEPLOY="$(latest_deploy)"; PREVIOUS_DEPLOY="${PREVIOUS_DEPLOY%% *}"
  # La clé arrive à la CLI par son entrée standard (printf est interne au shell) : ni argument,
  # ni variable d'environnement. Les deux variables sont posées sans déployer, puis un seul redéploiement.
  if ! printf '%s' "$SEND_KEY" | railway variable set RESEND_API_KEY --stdin -p "$RW_PROJECT" -e "$RW_ENV" -s "$RW_SERVICE" --skip-deploys >/dev/null 2>&1; then
    SEND_KEY=""
    ko "Railway a refusé RESEND_API_KEY (railway login ?). La clé créée est perdue : supprime « $SEND_KEY_NAME » sur resend.com/api-keys, puis relance avec --etape=5."
    SKIPPED+=("5 Clé d'envoi (Railway)"); return 0
  fi
  ok "RESEND_API_KEY posée sur Railway (jamais affichée)."
  if ! railway variable set "AUTH_EMAIL_FROM=$FROM_ADDR" -p "$RW_PROJECT" -e "$RW_ENV" -s "$RW_SERVICE" --skip-deploys >/dev/null 2>&1; then
    ko "Railway a refusé AUTH_EMAIL_FROM. Relance avec --etape=5."
    SKIPPED+=("5 Adresse d'expédition (Railway)"); return 0
  fi
  ok "AUTH_EMAIL_FROM = $FROM_ADDR"
  if ! railway deployment redeploy -p "$RW_PROJECT" -e "$RW_ENV" -s "$RW_SERVICE" -y >/dev/null 2>&1; then
    ko "Le redéploiement n'a pas pu être lancé : lance-le depuis Railway (les deux variables sont déjà posées)."
    SKIPPED+=("5 Redéploiement"); return 0
  fi
  if wait_until "Attente du redéploiement" new_deploy_done 90; then ok "Redéployé."; else warn "Redéploiement non confirmé après 15 minutes : regarde Railway."; fi
  if health_ok; then ok "$APP_URL/api/health : ok"; else ko "$APP_URL/api/health ne répond pas ok."; fi
  DONE+=("5 Clé d'envoi et adresse d'expédition sur Railway")
}

step_test() {
  local key="" id
  title "6/6 E-mail de test et récapitulatif"
  if go "Envoyer un e-mail de test à $TEST_TO depuis $FROM_ADDR"; then
    if [[ "$DRY" -eq 1 ]]; then
      info "(enverrait un e-mail de test avec la clé d'envoi, puis proposerait de supprimer la clé « $SETUP_KEY_NAME »)"
      DONE+=("6 E-mail de test")
    else
      # La clé d'envoi tout juste posée en production si l'étape 5 vient de tourner ; sinon la clé de mise en place.
      if [[ -n "$SEND_KEY" ]]; then key="$SEND_KEY"; elif need_setup_key; then key="$SETUP_KEY"; fi
      if [[ -z "$key" ]]; then
        SKIPPED+=("6 E-mail de test (aucune clé)")
      else
        resend POST "/emails" "{\"from\":\"$FROM_ADDR\",\"to\":[\"$TEST_TO\"],\"subject\":\"Cortex : e-mail de test\",\"text\":\"Si tu lis ce message, Resend envoie bien depuis $DOMAIN.\"}" "$key"
        key=""
        if http_ok; then
          id="$(printf '%s' "$HTTP_BODY" | json_get id)"
          [[ "$id" =~ ^[0-9a-f-]{1,36}$ ]] || id=""
          ok "E-mail de test accepté par Resend${id:+ (id $id)}."
          wait_enter "Vérifie qu'il est arrivé sur $TEST_TO (regarde aussi les indésirables)."
          DONE+=("6 E-mail de test envoyé à $TEST_TO")
          browse "https://resend.com/api-keys"
          info "La clé « $SETUP_KEY_NAME » ne sert plus : supprime-la (et toute ancienne clé « $SEND_KEY_NAME » en double)."
        else
          ko "Resend refuse l'envoi ($(http_error))."
          SKIPPED+=("6 E-mail de test (échec)")
        fi
      fi
    fi
  else
    SKIPPED+=("6 E-mail de test")
  fi
  title "Récapitulatif"
  if [[ "${#DONE[@]}" -gt 0 ]]; then
    for line in "${DONE[@]}"; do
      if [[ "$DRY" -eq 1 ]]; then info "· déroulé à blanc : $line"; else ok "$line"; fi
    done
  fi
  if [[ "${#SKIPPED[@]}" -gt 0 ]]; then for line in "${SKIPPED[@]}"; do info "· passé : $line"; done; fi
  echo "   Production :"
  if health_ok; then ok "/api/health : ok"; else ko "/api/health ne répond pas ok"; fi
  [[ "$DRY" -eq 1 ]] && echo "Essai à blanc terminé : rien n'a été ouvert, copié ni écrit."
  return 0
}

main() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --dry-run) DRY=1 ;;
      --etape=[1-6]) FROM="${arg#--etape=}" ;;
      -h|--help) usage; exit 0 ;;
      *) echo "✗ Option inconnue : $arg" >&2; usage >&2; exit 1 ;;
    esac
  done
  # Une trace d'exécution (bash -x) recopierait les clés à l'écran.
  case "$-" in *x*) echo "✗ Trace d'exécution active (bash -x) : elle afficherait les clés. Relance sans." >&2; exit 1 ;; esac
  require_terminal
  trap forget_secrets EXIT

  echo "E-mails de Cortex par Resend — $DOMAIN$([[ "$DRY" -eq 1 ]] && echo '  (ESSAI À BLANC : rien n'\''est ouvert, copié ni écrit)')"
  if ! command -v node >/dev/null 2>&1; then echo "✗ node est introuvable." >&2; exit 1; fi
  if ! command -v railway >/dev/null 2>&1 || ! railway whoami >/dev/null 2>&1; then
    if [[ "$DRY" -eq 1 ]]; then warn "CLI Railway absente ou non connectée (railway login) : l'étape 5 en aura besoin."
    else echo "✗ CLI Railway absente ou non connectée : lance « railway login », puis relance ce script." >&2; exit 1; fi
  fi

  if should_run 1; then step_account; fi
  if should_run 2; then step_domain; fi
  if should_run 3; then step_dns; fi
  if should_run 4; then step_verify; fi
  if should_run 5; then step_key; fi
  step_test
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
