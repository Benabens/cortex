#!/usr/bin/env bash
# Banc d'essai de cortex/scripts/setup-fiabilite.sh. Le script est chargé (source)
# puis déroulé avec de faux curl, railway, gh, open, pbcopy : aucune API réelle
# n'est appelée, rien n'est ouvert ni copié, et le DSN et le jeton sont des leurres.
#
#   bash cortex/scripts/setup-fiabilite.test.sh
#   MONTRER=complet bash cortex/scripts/setup-fiabilite.test.sh    (affiche aussi l'écran d'un scénario)
#
# Ce qui est vérifié : le déroulé de chaque étape, les refus (DSN invalide, jeton
# d'un autre projet ou d'un autre environnement, gh non connecté, Railway qui
# refuse), que les previews payantes ne s'activent que sur « oui », et qu'aucun
# secret n'apparaît à l'écran, dans les arguments ou l'environnement d'une
# commande, ou dans le presse-papiers.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/setup-fiabilite.sh"
TMP="$(mktemp -d)"
SERVER_PID=""
cleanup() {
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null
  if [[ -n "${MONTRER:-}" && -f "$TMP/$MONTRER/out" ]]; then printf '\n───── écran du scénario « %s » ─────\n' "$MONTRER"; cat "$TMP/$MONTRER/out"; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

# Leurres NON exportés : la fausse API les lit dans un fichier, et l'environnement
# des commandes que le script lance doit rester sans aucun secret (vérifié plus bas).
FAKE_DSN="https://0123456789abcdef0123456789abcdef@o4501.ingest.de.sentry.io/4502"
FAKE_TOKEN="7f3a9c2e-leurre-4b1d-9e8f-0a1b2c3d4e5f"
printf '%s\n%s\n' "$FAKE_DSN" "$FAKE_TOKEN" > "$TMP/leurres"

PASS=0
FAIL=0
S=""
t() { # $1 = libellé, puis la commande qui doit réussir
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then PASS=$((PASS + 1)); printf '  ✓ %s\n' "$label"
  else FAIL=$((FAIL + 1)); printf '  ✗ %s\n' "$label"; fi
}
out_has() { grep -qF -- "$1" "$S/out"; }
out_lacks() { ! grep -qF -- "$1" "$S/out"; }
log_has() { [[ -f "$S/$1" ]] && grep -qF -- "$2" "$S/$1"; }
log_lacks() { ! log_has "$1" "$2"; }
no_file() { [[ ! -e "$S/$1" ]]; }
file_is() { [[ -f "$S/$1" && "$(cat "$S/$1")" == "$2" ]]; }
rc_is() { [[ "$(cat "$S/rc")" == "$1" ]]; }
nreq() { # requêtes reçues par la fausse API dont l'adresse contient $1
  [[ -f "$S/requests.jsonl" ]] || { echo 0; return 0; }
  grep -c -F -- "$1" "$S/requests.jsonl" || true
}
req_is() { [[ "$(nreq "$1")" == "$2" ]]; }
# Aucun leurre dans ce que le script montre, passe en argument ou en environnement, ouvre ou copie.
no_leak() {
  local f s
  for f in out curl.argv railway.argv gh.argv env.dump open.log pbcopy.log; do
    [[ -f "$S/$f" ]] || continue
    while IFS= read -r s; do grep -qF -- "$s" "$S/$f" && return 1; done < "$TMP/leurres"
    # Ni la clé seule du DSN.
    grep -qF -- "0123456789abcdef0123456789abcdef" "$S/$f" && return 1
  done
  return 0
}

# Fausse API (Railway GraphQL, ingestion Sentry) : relit le fichier de configuration
# que le script donne à curl sur son entrée standard, comme curl le ferait.
cat > "$TMP/fake-api.js" <<'JS'
const fs = require("fs");
const [dsn, token] = fs.readFileSync(process.env.LEURRES, "utf8").split("\n");
let raw = "";
process.stdin.on("data", (c) => (raw += c)).on("end", () => {
  const unq = (v) => v.replace(/\\(.)/g, (_, c) => ({ n: "\n", t: "\t", r: "\r" })[c] ?? c);
  const req = { headers: {} };
  for (const line of raw.split("\n")) {
    const m = /^([a-z-]+) = "(.*)"$/.exec(line);
    if (!m) continue;
    const v = unq(m[2]);
    if (m[1] === "header") { const i = v.indexOf(":"); req.headers[v.slice(0, i).toLowerCase()] = v.slice(i + 1).trim(); }
    else req[m[1]] = v;
  }
  fs.appendFileSync(process.env.S + "/requests.jsonl", JSON.stringify({ url: req.url, method: req.request, type: req.headers["content-type"] }) + "\n");
  const reply = (code, body) => process.stdout.write(JSON.stringify(body) + "\n" + code);
  if (req.url === "https://backboard.railway.com/graphql/v2") {
    if (req.headers["project-access-token"] !== token) return reply(200, { errors: [{ message: "Not Authorized" }] });
    const q = JSON.parse(req["data-binary"]);
    if (q.query.includes("projectToken")) return reply(200, { data: { projectToken: { projectId: process.env.TOKEN_PROJECT || "d32e7d48-251b-437d-9f7a-b7a71ea58e5c", environmentId: "env-prod" } } });
    if (q.query.includes("environment(") && q.variables?.id === "env-prod") return reply(200, { data: { environment: { name: process.env.TOKEN_ENV || "production" } } });
    return reply(200, { errors: [{ message: "inattendu" }] });
  }
  if (req.url === "https://o4501.ingest.de.sentry.io/api/4502/envelope/") {
    const lines = req["data-binary"].split("\n");
    fs.writeFileSync(process.env.S + "/envelope.json", JSON.stringify(lines.filter(Boolean).map((l) => JSON.parse(l))));
    if (JSON.parse(lines[0]).dsn !== dsn) return reply(401, { detail: "bad dsn" });
    return reply(Number(process.env.SENTRY_RC || 200), { id: "x" });
  }
  reply(404, {});
});
JS

run() { # $1 = scénario, puis les options du script
  local name="$1"
  shift
  S="$TMP/$name"
  mkdir -p "$S/home"
  [[ -f "$S/answers.DSN" ]] || printf '%s\n' "$FAKE_DSN" > "$S/answers.DSN"
  [[ -f "$S/answers.RW_TOKEN" ]] || printf '%s\n' "$FAKE_TOKEN" > "$S/answers.RW_TOKEN"
  (
    export S LEURRES="$TMP/leurres" HOME="$S/home"
    # Un shell appelant qui aurait exporté des variables du même nom que celles du script.
    export DSN=parasite RW_TOKEN=parasite HTTP_BODY=parasite val=parasite out=parasite body=parasite secret=parasite msg=parasite
    # shellcheck source=/dev/null
    source "$SCRIPT"
    curl() {
      env >> "$S/env.dump"
      printf '%s\n' "$*" >> "$S/curl.argv"
      case " $* " in
        *" -K - "*) node "$TMP/fake-api.js" ;;
        *) printf '{"status":"ok","commit":"87b646924b23386a100ebc1005a8d81b29115315"}' ;;
      esac
    }
    railway() {
      env >> "$S/env.dump"
      printf '%s\n' "$*" >> "$S/railway.argv"
      case "${1:-} ${2:-}" in
        "whoami "*) return 0 ;;
        "variable list") if [[ -n "${HAS_DSN:-}" ]]; then printf '{"AUTH_URL":"x","SENTRY_DSN":"ancien"}'; else printf '{"AUTH_URL":"x"}'; fi; return "${RAILWAY_LIST_RC:-0}" ;;
        "variable set") cat > "$S/railway.stdin.$3"; return "${RAILWAY_SET_RC:-0}" ;;
      esac
    }
    gh() {
      env >> "$S/env.dump"
      printf '%s\n' "$*" >> "$S/gh.argv"
      case "${1:-} ${2:-}" in
        "auth status") return "${GH_AUTH_RC:-0}" ;;
        "secret set") cat > "$S/gh.stdin.$3"; return 0 ;;
        "secret list") [[ -f "$S/gh.stdin.RAILWAY_TOKEN" ]] && printf 'RAILWAY_TOKEN\t2026-11-13\n'; return 0 ;;
        "workflow view") return "${GH_WORKFLOW_RC:-0}" ;;
        "workflow run") : > "$S/workflow-run"; return 0 ;;
      esac
    }
    open() { printf '%s\n' "$*" >> "$S/open.log"; }
    pbcopy() { { cat; echo; } >> "$S/pbcopy.log"; }
    require_terminal() { :; }
    go() {
      local p IFS='|'
      echo "$1" >> "$S/go.log"
      for p in ${GO_SKIP:-}; do [[ "$1" == *"$p"* ]] && return 1; done
      return 0
    }
    confirm_oui() { echo "$1" >> "$S/oui.log"; [[ "${OUI:-}" == "oui" ]]; }
    wait_enter() { echo "$1" >> "$S/wait.log"; }
    ask_secret() {
      local file="$S/answers.$1" val=""
      echo "$1" >> "$S/asked.log"
      if [[ -s "$file" ]]; then val="$(head -1 "$file")"; tail -n +2 "$file" > "$file.next"; mv "$file.next" "$file"; fi
      printf -v "$1" '%s' "$val"
    }
    main "$@"
  ) > "$S/out" 2>&1
  echo "$?" > "$S/rc"
}

echo "Statique (bash ${BASH_VERSION})"
t "syntaxe valide" bash -n "$SCRIPT"
t "aucun here-string (<<<)" bash -c "! grep -n '<<<' '$SCRIPT'"
t "aucune trace d'exécution activée" bash -c "! grep -nE 'set -[a-z]*x|set -o xtrace' '$SCRIPT'"
t "aucun secret écrit dans un fichier" bash -c "! grep -nE '\\\$\\{?(DSN|RW_TOKEN)([^A-Za-z_][^|]*)?>>?[^&]' '$SCRIPT'"
t "bash -x est refusé avant toute saisie" bash -c "bash -x '$SCRIPT' --dry-run 2>&1 </dev/null | grep -q 'elle afficherait les clés'"
t "refus hors d'un terminal, avant toute action" bash -c "out=\"\$(bash '$SCRIPT' </dev/null 2>&1)\"; [[ \$? -eq 1 && \"\$out\" == *'À lancer dans un Terminal'* ]]"
t "aucun caractère invisible dans le source" node -e 'process.exit(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/.test(require("fs").readFileSync(process.argv[1],"utf8"))?1:0)' "$SCRIPT"
t "option inconnue refusée" bash -c "! bash '$SCRIPT' --nimporte </dev/null >/dev/null 2>&1"

echo "Accord explicite (vraie fonction)"
oui() { ( source "$SCRIPT"; printf '%s\n' "$1" | confirm_oui "test" >/dev/null ); }
t "« oui » tapé = accord" oui "oui"
t "Entrée = refus" bash -c "! ( source '$SCRIPT'; printf '\n' | confirm_oui test >/dev/null )"
t "« o » ou « yes » = refus" bash -c "! ( source '$SCRIPT'; printf 'o\n' | confirm_oui test >/dev/null ) && ! ( source '$SCRIPT'; printf 'yes\n' | confirm_oui test >/dev/null )"
t "fin de saisie = refus" bash -c "! ( source '$SCRIPT'; confirm_oui test </dev/null >/dev/null )"

echo "DSN accepté ou refusé"
dsn() { ( source "$SCRIPT"; valid_dsn "$1" ); }
t "DSN Sentry (UE) accepté" dsn "$FAKE_DSN"
t "DSN Sentry (US) accepté" dsn "https://0123456789abcdef0123456789abcdef@o12.ingest.sentry.io/34"
t "DSN d'un autre hôte refusé" bash -c "! ( source '$SCRIPT'; valid_dsn 'https://0123456789abcdef0123456789abcdef@evil.example/34' )"
t "DSN en http refusé" bash -c "! ( source '$SCRIPT'; valid_dsn 'http://0123456789abcdef0123456789abcdef@o12.ingest.sentry.io/34' )"

# La fausse API relit le fichier de configuration à sa façon ; ce test prouve que
# le VRAI curl le lit pareil : en-têtes, corps sur plusieurs lignes, guillemets, antislashs.
echo "Vrai curl contre un serveur local"
S="$TMP/curl-reel"
mkdir -p "$S/home"
node -e '
  const fs = require("fs"), http = require("http");
  http.createServer((q, r) => {
    let b = "";
    q.on("data", (c) => (b += c)).on("end", () => {
      fs.writeFileSync(process.argv[1] + "/seen.json", JSON.stringify({ method: q.method, headers: q.headers, body: b }));
      r.writeHead(200, { "content-type": "application/json" });
      r.end("{\"id\":\"vu\"}");
    });
  }).listen(0, "127.0.0.1", function () { fs.writeFileSync(process.argv[1] + "/port", String(this.address().port)); });
' "$S" &
SERVER_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [[ -s "$S/port" ]] && break; /bin/sleep 0.2 2>/dev/null || command sleep 1; done
TRICKY=$'{"dsn":"a \\" b \\\\ c é"}\n{"type":"event"}\n'
printf 'trace-ascii = "%s"\n' "$S/home/trace.txt" > "$S/home/.curlrc"
(
  export HOME="$S/home"
  # shellcheck source=/dev/null
  source "$SCRIPT"
  http_call "http://127.0.0.1:$(cat "$S/port")/api/1/envelope/" "application/x-sentry-envelope" "$TRICKY" "Project-Access-Token: $FAKE_TOKEN"
  printf '%s %s' "$HTTP_CODE" "$HTTP_BODY" > "$S/result"
)
t "réponse lue (code et corps)" file_is result '200 {"id":"vu"}'
t "corps reçu à l'octet près (sauts de ligne compris)" node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]+"/seen.json","utf8"));process.exit(s.body===process.argv[2]?0:1)' "$S" "$TRICKY"
t "type et jeton reçus en en-têtes" node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]+"/seen.json","utf8"));process.exit(s.method==="POST"&&s.headers["content-type"]==="application/x-sentry-envelope"&&s.headers["project-access-token"]===process.argv[2]?0:1)' "$S" "$FAKE_TOKEN"
t "~/.curlrc ignoré (aucune trace sur disque)" no_file home/trace.txt
kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""

echo "Déroulé complet (previews refusées)"
run complet
t "fin normale" rc_is 0
t "DSN posé sur Railway par l'entrée standard, sans redéploiement" file_is railway.stdin.SENTRY_DSN "$FAKE_DSN"
t "… sur cortex-app en production" log_has railway.argv "variable set SENTRY_DSN --stdin -p d32e7d48-251b-437d-9f7a-b7a71ea58e5c -e production -s cortex-app --skip-deploys"
t "DSN demandé une seule fois (réutilisé pour l'erreur de test)" bash -c "[[ \$(grep -c '^DSN\$' '$S/asked.log') == 1 ]]"
t "erreur de test : enveloppe Sentry du bon projet, environnement production" node -e 'const e=JSON.parse(require("fs").readFileSync(process.argv[1]+"/envelope.json","utf8"));process.exit(e[1].type==="event"&&e[2].environment==="production"&&/à ignorer/.test(e[2].message)?0:1)' "$S"
t "jeton vérifié auprès de Railway (projet puis environnement)" req_is "backboard.railway.com" 2
t "jeton posé en secret GitHub par l'entrée standard" file_is gh.stdin.RAILWAY_TOKEN "$FAKE_TOKEN"
t "… sur Benabens/cortex" log_has gh.argv "secret set RAILWAY_TOKEN --repo Benabens/cortex"
t "previews : accord demandé" log_has oui.log "Activer les previews de PR"
t "previews refusées : aucune page Railway de facturation ou d'environnements ouverte" bash -c "! grep -qE 'usage|settings/environments' '$S/open.log'"
t "previews refusées : la CI E2E reste le filet gratuit" out_has "non activées : la CI E2E reste le filet gratuit"
t "post-deploy lancée à blanc" bash -c "[[ -f '$S/workflow-run' ]] && grep -qF 'workflow run post-deploy.yml --repo Benabens/cortex -f dry_run=true' '$S/gh.argv'"
t "santé de la prod affichée avec son commit" out_has "commit 87b6469 en production"
t "presse-papiers vidé après les saisies" bash -c "[[ \$(grep -c '^\$' '$S/pbcopy.log') -ge 2 ]]"
t "aucun secret à l'écran, en argument, en environnement, ouvert ou copié" no_leak

echo "Essai à blanc"
run blanc --dry-run
t "fin normale" rc_is 0
t "rien d'ouvert" no_file open.log
t "rien de copié" no_file pbcopy.log
t "aucune saisie de secret" no_file asked.log
t "rien posé sur Railway ni GitHub" bash -c "[[ ! -e '$S/railway.stdin.SENTRY_DSN' && ! -e '$S/gh.stdin.RAILWAY_TOKEN' && ! -e '$S/workflow-run' ]]"
t "aucun appel aux API Railway ou Sentry" no_file requests.jsonl
t "fin annoncée" out_has "Essai à blanc terminé"

echo "Refus et replis"
S="$TMP/dsn-invalide"; mkdir -p "$S"; printf 'https://pas-un-dsn.example/1\n' > "$S/answers.DSN"
run dsn-invalide --etape=1
t "DSN invalide : rien posé sur Railway" no_file railway.stdin.SENTRY_DSN
t "DSN invalide : dit pourquoi" out_has "Ce n'est pas un DSN Sentry"

HAS_DSN=1 GO_SKIP="Le remplacer|erreur de test" run dsn-garde --etape=1
t "DSN déjà posé, gardé : rien demandé ni posé" bash -c "[[ ! -e '$S/railway.stdin.SENTRY_DSN' ]] && ! grep -q '^DSN\$' '$S/asked.log' 2>/dev/null"
t "… et le récap le dit" out_has "déjà posé, gardé"

RAILWAY_LIST_RC=1 run dsn-illisible --etape=1
t "variables Railway illisibles : avertit, ne conclut pas à l'absence" out_has "Variables Railway illisibles"

RAILWAY_SET_RC=1 run railway-refuse --etape=1
t "Railway refuse : échec dit, rien d'annoncé comme fait" bash -c "grep -qF 'Railway a refusé SENTRY_DSN' '$S/out' && ! grep -qF '✓ 1 SENTRY_DSN' '$S/out'"
t "Railway refuse : aucun secret affiché" no_leak

SENTRY_RC=403 GO_SKIP="Créer l'alerte|adresses IP" run sentry-refuse --etape=2
t "erreur de test refusée par Sentry : dit, sans le DSN" bash -c "grep -qF 'Sentry refuse' '$S/out'"
t "… aucun secret affiché" no_leak

TOKEN_PROJECT=autre-projet run jeton-autre --etape=3
t "jeton d'un autre projet : pas de secret GitHub" no_file gh.stdin.RAILWAY_TOKEN
t "… dit pourquoi" out_has "ne reconnaît pas ce jeton"

TOKEN_ENV=staging run jeton-staging --etape=3
t "jeton d'un autre environnement : pas de secret GitHub" no_file gh.stdin.RAILWAY_TOKEN
t "… dit pourquoi" out_has "pas production"

S="$TMP/jeton-faux"; mkdir -p "$S"; printf 'mauvais-jeton-0000000000000\n' > "$S/answers.RW_TOKEN"
run jeton-faux --etape=3
t "jeton inconnu de Railway : pas de secret GitHub" no_file gh.stdin.RAILWAY_TOKEN

GH_AUTH_RC=1 run gh-absent --etape=3
t "gh non connecté : aucun jeton demandé" bash -c "! grep -q RW_TOKEN '$S/asked.log' 2>/dev/null"
t "… dit quoi faire" out_has "gh auth login"

OUI=oui run previews-oui --etape=4
t "previews acceptées : plafond de dépense d'abord, puis les environnements de PR" bash -c "grep -n 'workspace/usage' '$S/open.log' | cut -d: -f1 | head -1 | { read -r a; b=\$(grep -n 'settings/environments' '$S/open.log' | cut -d: -f1 | head -1); [[ -n \"\$a\" && -n \"\$b\" && \$a -lt \$b ]]; }"
t "… et le récap le dit" out_has "Previews de PR activées"

GH_WORKFLOW_RC=1 run avant-merge --etape=5
t "avant le merge : pas de workflow lancée, relance conseillée" bash -c "[[ ! -e '$S/workflow-run' ]] && grep -qF 'après le merge' '$S/out'"

echo
echo "Résultat : $PASS réussis, $FAIL en échec"
[[ "$FAIL" -eq 0 ]]
