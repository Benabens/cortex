#!/usr/bin/env bash
# Banc d'essai de scripts/resend-ben.sh. Le script est chargé (source) puis déroulé
# avec de faux curl, railway, open, pbcopy et sleep : aucune API réelle n'est
# appelée, rien n'est ouvert ni copié, et les « clés » sont des leurres.
#
#   bash scripts/resend-ben.test.sh
#   MONTRER=premier bash scripts/resend-ben.test.sh    (affiche aussi l'écran d'un scénario)
#
# Ce qui est vérifié : le déroulé de chaque étape, que seuls les enregistrements
# de Resend sont ajoutés à la zone, les replis (API Spaceship en échec, conflit,
# vérification qui ne passe pas, Railway qui refuse), et qu'aucune clé n'apparaît
# à l'écran, dans les arguments d'une commande ou dans le presse-papiers.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/resend-ben.sh"
TMP="$(mktemp -d)"
SERVER_PID=""
cleanup() {
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null
  # MONTRER=<scénario> : affiche ce que le script a écrit à l'écran pendant ce scénario.
  if [[ -n "${MONTRER:-}" && -f "$TMP/$MONTRER/out" ]]; then printf '\n───── écran du scénario « %s » ─────\n' "$MONTRER"; cat "$TMP/$MONTRER/out"; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

export FAKE_SETUP="re_SETUPleurre_0123456789abcdefABCDEF"
export FAKE_SEND="re_SENDleurre_zyxwvutsrq9876543210"
export FAKE_SS_KEY="ssk_LEURRE-cle.0123456789"
# Guillemet et antislash : ce sont eux qui mettent à l'épreuve l'échappement vers curl.
export FAKE_SS_SECRET='ssLeurre"avec\antislash+et/barre=='

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
rc_is() { [[ "$(cat "$S/rc")" == "$1" ]]; }
# Nombre de requêtes reçues par la fausse API : méthode, puis fragment d'adresse.
nreq() {
  [[ -f "$S/requests.jsonl" ]] || { echo 0; return 0; }
  node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map((x)=>JSON.parse(x));console.log(l.filter((r)=>r.method===process.argv[2]&&r.url.includes(process.argv[3])).length)' "$S/requests.jsonl" "$1" "$2"
}
req_is() { [[ "$(nreq "$1" "$2")" == "$3" ]]; }
# Expression JavaScript évaluée sur l'état final de la fausse API (st).
state() { node -e 'const st=JSON.parse(require("fs").readFileSync(process.argv[1]+"/state.json","utf8"));const v=eval(process.argv[2]);process.stdout.write(typeof v==="string"?v:JSON.stringify(v))' "$S" "$1"; }
state_is() { [[ "$(state "$1")" == "$2" ]]; }
# Aucune des clés leurres dans ce que le script montre, passe en argument, ouvre ou copie.
no_leak() {
  local f s
  for f in out curl.argv railway.argv open.log pbcopy.log go.log wait.log; do
    [[ -f "$S/$f" ]] || continue
    for s in "$FAKE_SETUP" "$FAKE_SEND" "$FAKE_SS_KEY" "$FAKE_SS_SECRET"; do
      if grep -qF -- "$s" "$S/$f"; then echo "fuite dans $f"; return 1; fi
    done
  done
}
zone_intact() { # les quatre enregistrements d'origine sont toujours là, à l'identique
  state_is 'JSON.stringify(st.zone.slice(0,4).map((r)=>[r.type,r.name,r.address||r.cname||r.value,r.ttl]))' '[["A","@","216.198.79.1",1800],["CNAME","www","cname.vercel-dns.com",1800],["CNAME","app","k3x9.up.railway.app",1800],["TXT","_railway-verify.app","railway-verify=abc123",1800]]'
}

# ───────────────────────────── Fausse API ─────────────────────────────

cat > "$TMP/records.json" <<'EOF'
[
  { "record": "SPF", "name": "send", "type": "MX", "ttl": "Auto", "status": "not_started", "value": "feedback-smtp.eu-west-1.amazonses.com", "priority": 10 },
  { "record": "SPF", "name": "send", "value": "\"v=spf1 include:amazonses.com ~all\"", "type": "TXT", "ttl": "Auto", "status": "not_started" },
  { "record": "DKIM", "name": "resend._domainkey", "value": "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDsc4Lh8xilsngyKEgN2S84+21gn+x6SEXtjWvPiAAmnmggr5FWG42WnqczpzQ/mNblqHz4CDwUum6LtY6SdoOlDmrhvp5khA3cd661W9FlK3yp7+jVACQElS7d9O6jv8VsBbVg4COess3gyLE5RyxqF1vYsrEXqyM8TBz1n5AGkQIDAQAB", "type": "TXT", "status": "not_started", "ttl": "Auto" }
]
EOF

# Reçoit ce que le script remet à curl (un fichier de configuration sur l'entrée
# standard), y répond comme Resend ou Spaceship, et note tout pour les vérifications.
cat > "$TMP/fake-api.js" <<'EOF'
const fs = require("fs");
const S = process.env.S, E = process.env;
const req = { method: "GET", url: "", headers: {}, data: "" };
for (const line of fs.readFileSync(0, "utf8").split("\n")) {
  if (!line) continue;
  const m = /^([a-z]+) = "(.*)"$/.exec(line);
  if (!m) { fs.appendFileSync(S + "/fake.err", "ligne de configuration illisible : " + line + "\n"); continue; }
  const v = m[2].replace(/\\(.)/g, "$1");
  if (m[1] === "url") req.url = v;
  else if (m[1] === "request") req.method = v;
  else if (m[1] === "data") req.data = v;
  else if (m[1] === "header") { const i = v.indexOf(": "); req.headers[v.slice(0, i).toLowerCase()] = v.slice(i + 2); }
}
fs.appendFileSync(S + "/requests.jsonl", JSON.stringify(req) + "\n");
const stPath = S + "/state.json";
const st = JSON.parse(fs.readFileSync(stPath, "utf8"));
const reply = (code, body) => {
  fs.writeFileSync(stPath, JSON.stringify(st));
  process.stdout.write((body === undefined ? "" : JSON.stringify(body)) + "\n" + code);
  process.exit(0);
};
let body = null;
if (req.data) {
  try { body = JSON.parse(req.data); }
  catch { fs.appendFileSync(S + "/fake.err", "corps JSON illisible : " + req.data + "\n"); reply(400, { message: "corps illisible" }); }
}
const u = new URL(req.url);
const p = u.pathname;
const records = JSON.parse(fs.readFileSync(E.RECORDS, "utf8"));

if (u.origin === "https://api.resend.com") {
  const auth = req.headers.authorization || "";
  const isSetup = auth === "Bearer " + E.FAKE_SETUP, isSend = auth === "Bearer " + E.FAKE_SEND;
  if (E.RESEND_DOWN) reply(503, { statusCode: 503, name: "service_unavailable", message: "Service unavailable" });
  if (!isSetup && !isSend) reply(403, { statusCode: 403, name: "validation_error", message: "API key is invalid" });
  if (isSend && !(req.method === "POST" && p === "/emails")) reply(401, { statusCode: 401, name: "restricted_api_key", message: "This API key is restricted to only send emails" });
  const view = (d, full) => Object.assign(
    { object: "domain", id: d.id, name: d.name, status: d.status, region: d.region, created_at: "2026-10-08 00:00:00+00" },
    full ? { records: E.RESEND_NO_RECORDS ? [] : records.map((r) => Object.assign({}, r, { status: d.status })) } : {});
  if (req.method === "GET" && p === "/domains") reply(200, { object: "list", has_more: false, data: st.domain ? [view(st.domain)] : [] });
  if (req.method === "POST" && p === "/domains") {
    if (st.domain) reply(403, { statusCode: 403, name: "validation_error", message: "The domain has been registered already." });
    if (E.REGION_REFUSED && body.region) reply(422, { statusCode: 422, name: "invalid_parameter", message: "Region not available" });
    st.domain = { id: "4dd369bc-aa82-4ff3-97de-514ae3000ee0", name: body.name, status: "not_started", region: body.region || "us-east-1", polls: 0 };
    reply(201, view(st.domain, true));
  }
  const m = /^\/domains\/([0-9a-f-]{36})(\/verify)?$/.exec(p);
  if (m && st.domain && m[1] === st.domain.id) {
    if (req.method === "POST" && m[2]) { st.domain.status = "pending"; st.domain.verifying = true; reply(200, { object: "domain", id: st.domain.id }); }
    if (req.method === "GET" && !m[2]) {
      if (st.domain.verifying) {
        st.domain.polls++;
        if (E.VERIFY_AFTER === "failed") st.domain.status = "failed";
        else if (E.VERIFY_AFTER !== "never" && st.domain.polls >= Number(E.VERIFY_AFTER || 2)) { st.domain.status = "verified"; st.domain.verifying = false; }
      }
      reply(200, view(st.domain, true));
    }
  }
  if (req.method === "GET" && p === "/api-keys") reply(200, { object: "list", data: st.keys });
  if (req.method === "POST" && p === "/api-keys") {
    st.keys.push({ id: "k" + st.keys.length, name: body.name });
    st.createdKey = body;
    reply(201, { id: "dacf4072-4119-4d88-932f-6202748ac7c8", object: "api_key", token: E.FAKE_SEND });
  }
  if (req.method === "POST" && p === "/emails") { st.emails.push({ body, key: isSend ? "send" : "setup" }); reply(200, { id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }); }
  reply(404, { statusCode: 404, name: "not_found", message: "Not found" });
}

if (u.origin === "https://spaceship.dev") {
  if (E.SS_AUTH_FAIL || req.headers["x-api-key"] !== E.FAKE_SS_KEY || req.headers["x-api-secret"] !== E.FAKE_SS_SECRET) reply(401, { detail: "Unauthorized" });
  if (p !== "/api/v1/dns/records/cortexexam.com") reply(404, { detail: "Not found" });
  if (req.method === "GET") {
    if (u.searchParams.get("take") !== "500" || u.searchParams.get("skip") !== "0") reply(400, { detail: "take et skip attendus" });
    reply(200, { items: st.zone, total: st.zone.length + Number(E.SS_EXTRA_TOTAL || 0) });
  }
  if (req.method === "PUT") {
    if (E.SS_PUT_REFUSED) reply(422, { detail: "Conflict with existing records" });
    if (!body || body.force !== false || !Array.isArray(body.items) || !body.items.length) reply(400, { detail: "force:false et items attendus" });
    st.puts.push(body);
    for (const it of body.items) st.zone.push(Object.assign({ group: { type: "custom" } }, it));
    // Une zone qui perd un enregistrement à l'écriture : à chaque fois, ou seulement la première.
    if (E.SS_PUT_DROPS === "toujours" || (E.SS_PUT_DROPS === "une-fois" && st.puts.length === 1)) st.zone = st.zone.filter((r) => !(r.type === "CNAME" && r.name === "www"));
    reply(204);
  }
  reply(405, { detail: "Method not allowed" });
}
reply(404, { message: "hôte inattendu : " + u.origin });
EOF

# État de départ de la fausse API. Variables lues : DOMAIN_STATUS (domaine déjà
# chez Resend, avec ce statut), ZONE_HAS_RESEND (enregistrements déjà posés),
# ZONE_OLD_DKIM (un ancien DKIM sous le même nom), KEY_EXISTS (clé d'envoi déjà créée).
init_state() {
  RECORDS="$TMP/records.json" node -e '
    const fs = require("fs"), E = process.env;
    const zone = [
      { type: "A", name: "@", address: "216.198.79.1", ttl: 1800, group: { type: "custom" } },
      { type: "CNAME", name: "www", cname: "cname.vercel-dns.com", ttl: 1800, group: { type: "custom" } },
      { type: "CNAME", name: "app", cname: "k3x9.up.railway.app", ttl: 1800, group: { type: "custom" } },
      { type: "TXT", name: "_railway-verify.app", value: "railway-verify=abc123", ttl: 1800, group: { type: "custom" } },
    ];
    const rec = JSON.parse(fs.readFileSync(E.RECORDS, "utf8"));
    if (E.ZONE_HAS_RESEND) {
      zone.push({ type: "MX", name: "send", exchange: rec[0].value, preference: 10, ttl: 3600 });
      zone.push({ type: "TXT", name: "send", value: "v=spf1 include:amazonses.com ~all", ttl: 3600 });
      zone.push({ type: "TXT", name: "resend._domainkey", value: rec[2].value, ttl: 3600 });
    }
    if (E.ZONE_OLD_DKIM) zone.push({ type: "TXT", name: "resend._domainkey", value: "p=ANCIENNECLE", ttl: 3600 });
    const st = { domain: null, zone, puts: [], keys: [{ id: "k0", name: "cortex-setup" }], emails: [], createdKey: null };
    if (E.DOMAIN_STATUS) st.domain = { id: "4dd369bc-aa82-4ff3-97de-514ae3000ee0", name: "cortexexam.com", status: E.DOMAIN_STATUS, region: "eu-west-1", polls: 0 };
    if (E.KEY_EXISTS) st.keys.push({ id: "k1", name: "cortex-app" });
    fs.writeFileSync(process.argv[1] + "/state.json", JSON.stringify(st));
  ' "$S"
}

# Déroule le script dans un sous-shell, avec les doublures. $1 = nom du scénario,
# le reste = arguments du script. Réponses aux saisies masquées : $S/answers.<VARIABLE>,
# une par ligne, servies dans l'ordre. GO_SKIP = fragments d'invites à passer, séparés par « | ».
REAL_PROMPTS=0
run() {
  local name="$1"
  shift
  S="$TMP/$name"
  mkdir -p "$S/home"
  init_state
  [[ -f "$S/answers.SETUP_KEY" ]] || printf '%s\n' "$FAKE_SETUP" > "$S/answers.SETUP_KEY"
  [[ -f "$S/answers.SS_KEY" ]] || printf '%s\n' "$FAKE_SS_KEY" > "$S/answers.SS_KEY"
  [[ -f "$S/answers.SS_SECRET" ]] || printf '%s\n' "$FAKE_SS_SECRET" > "$S/answers.SS_SECRET"
  (
    export S RECORDS="$TMP/records.json" HOME="$S/home"
    # shellcheck source=/dev/null
    source "$SCRIPT"
    curl() {
      printf '%s\n' "$*" >> "$S/curl.argv"
      case " $* " in
        *" -K - "*) node "$TMP/fake-api.js" ;;
        *) if [[ -n "${HEALTH_DOWN:-}" ]]; then printf 'Bad gateway'; else printf '{"status":"ok"}'; fi ;;
      esac
    }
    railway() {
      printf '%s\n' "$*" >> "$S/railway.argv"
      case "${1:-} ${2:-}" in
        "whoami "*) return "${RAILWAY_WHOAMI_RC:-0}" ;;
        "variable set")
          if [[ " $* " == *" --stdin "* ]]; then cat > "$S/railway.stdin.$3"; return "${RAILWAY_KEY_RC:-0}"; fi
          return "${RAILWAY_FROM_RC:-0}" ;;
        "deployment list")
          if [[ -f "$S/redeployed" ]]; then printf '[{"id":"dep-2","status":"SUCCESS"}]'; else printf '[{"id":"dep-1","status":"SUCCESS"}]'; fi ;;
        "deployment redeploy") : > "$S/redeployed" ;;
      esac
    }
    open() { printf '%s\n' "$*" >> "$S/open.log"; }
    pbcopy() { { cat; echo; } >> "$S/pbcopy.log"; }
    sleep() { echo "$*" >> "$S/sleep.log"; }
    if [[ "$REAL_PROMPTS" -eq 0 ]]; then
      require_terminal() { :; }
      go() {
        local p IFS='|'
        echo "$1" >> "$S/go.log"
        for p in ${GO_SKIP:-}; do [[ "$1" == *"$p"* ]] && return 1; done
        return 0
      }
      wait_enter() { echo "$1" >> "$S/wait.log"; }
      ask_secret() {
        local file="$S/answers.$1" val=""
        echo "$1" >> "$S/asked.log"
        if [[ -s "$file" ]]; then val="$(head -1 "$file")"; tail -n +2 "$file" > "$file.next"; mv "$file.next" "$file"; fi
        printf -v "$1" '%s' "$val"
      }
    else
      require_terminal() { :; }
    fi
    main "$@"
  ) > "$S/out" 2>&1
  echo "$?" > "$S/rc"
}

# ───────────────────────────── Vérifications statiques ─────────────────────────────

echo "Statique"
t "syntaxe valide pour le bash de macOS (3.2)" bash -n "$SCRIPT"
# Un « here-string » passe par un fichier temporaire : une clé s'y retrouverait sur disque.
t "aucun here-string (<<<)" bash -c "! grep -n '<<<' '$SCRIPT'"
t "aucune trace d'exécution activée" bash -c "! grep -nE 'set -[a-z]*x|set -o xtrace' '$SCRIPT'"
t "aucune clé écrite dans un fichier" bash -c "! grep -nE '(SETUP_KEY|SEND_KEY|SS_KEY|SS_SECRET|token)[^|]*>>?[^&]' '$SCRIPT'"
t "bash -x est refusé avant toute saisie" bash -c "bash -x '$SCRIPT' --dry-run 2>&1 </dev/null | grep -q 'elle afficherait les clés'"
t "refus hors d'un terminal, avant toute action" bash -c "out=\"\$(bash '$SCRIPT' </dev/null 2>&1)\"; [[ \$? -eq 1 && \"\$out\" == *'À lancer dans un Terminal'* ]]"
t "option inconnue refusée" bash -c "! bash '$SCRIPT' --nimporte </dev/null >/dev/null 2>&1"

# ───────────────────────────── Vrai curl, serveur local ─────────────────────────────

# La fausse API relit le fichier de configuration à ma façon ; ce test prouve que le
# VRAI curl le lit pareil : en-têtes, corps avec guillemets, antislashs et accents.
echo "Vrai curl contre un serveur local"
S="$TMP/curl-reel"
mkdir -p "$S"
node -e '
  const fs = require("fs"), http = require("http");
  http.createServer((q, r) => {
    let b = "";
    q.on("data", (c) => (b += c)).on("end", () => {
      fs.writeFileSync(process.argv[1] + "/seen.json", JSON.stringify({ method: q.method, url: q.url, headers: q.headers, body: b }));
      r.writeHead(207, { "content-type": "application/json" });
      r.end("{\"message\":\"vu\"}");
    });
  }).listen(0, "127.0.0.1", function () { fs.writeFileSync(process.argv[1] + "/port", String(this.address().port)); });
' "$S" &
SERVER_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [[ -s "$S/port" ]] && break; /bin/sleep 0.2 2>/dev/null || command sleep 1; done
TRICKY='{"a":"guillemet \" antislash \\ accent é é","b":"p=MIG+/==","c":["x y"]}'
(
  # shellcheck source=/dev/null
  source "$SCRIPT"
  http_call PUT "http://127.0.0.1:$(cat "$S/port")/chemin?take=500&skip=0" "$TRICKY" "X-API-Secret: $FAKE_SS_SECRET" "Authorization: Bearer $FAKE_SETUP"
  printf '%s' "$HTTP_CODE" > "$S/code"
  printf '%s' "$HTTP_BODY" > "$S/body"
  http_call GET "http://127.0.0.1:1/ferme" ""
  printf '%s' "$HTTP_CODE" > "$S/code-ferme"
) > "$S/out" 2>&1
{ kill "$SERVER_PID" && wait "$SERVER_PID"; } 2>/dev/null
SERVER_PID=""
seen() { node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1]+"/seen.json","utf8"));process.stdout.write(String(eval(process.argv[2])))' "$S" "$1"; }
t "code HTTP relu" test "$(cat "$S/code" 2>/dev/null)" = "207"
t "corps de la réponse relu" test "$(cat "$S/body" 2>/dev/null)" = '{"message":"vu"}'
t "méthode et adresse intactes" test "$(seen 's.method+" "+s.url')" = "PUT /chemin?take=500&skip=0"
t "corps reçu à l'octet près" test "$(seen 's.body')" = "$TRICKY"
t "en-tête secret reçu à l'identique (guillemet, antislash)" test "$(seen 's.headers["x-api-secret"]')" = "$FAKE_SS_SECRET"
t "en-tête Authorization reçu" test "$(seen 's.headers.authorization')" = "Bearer $FAKE_SETUP"
t "type de contenu JSON" test "$(seen 's.headers["content-type"]')" = "application/json"
t "serveur injoignable → code 000, sans arrêt du script" test "$(cat "$S/code-ferme" 2>/dev/null)" = "000"

# ───────────────────────────── Scénarios ─────────────────────────────

echo "1. Premier passage, tout automatique"
run premier
t "se termine sans erreur" rc_is 0
t "la fausse API n'a rien reçu d'illisible" test ! -e "$S/fake.err"
t "domaine créé en eu-west-1" test "$(state 'st.domain.region')" = "eu-west-1"
t "un seul ajout dans la zone" req_is PUT /dns/records/cortexexam.com 1
t "l'ajout ne contient que les trois enregistrements de Resend, sans forcer" state_is 'JSON.stringify(st.puts[0])' '{"force":false,"items":[{"type":"MX","name":"send","ttl":3600,"exchange":"feedback-smtp.eu-west-1.amazonses.com","preference":10},{"type":"TXT","name":"send","ttl":3600,"value":"v=spf1 include:amazonses.com ~all"},{"type":"TXT","name":"resend._domainkey","ttl":3600,"value":"p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDsc4Lh8xilsngyKEgN2S84+21gn+x6SEXtjWvPiAAmnmggr5FWG42WnqczpzQ/mNblqHz4CDwUum6LtY6SdoOlDmrhvp5khA3cd661W9FlK3yp7+jVACQElS7d9O6jv8VsBbVg4COess3gyLE5RyxqF1vYsrEXqyM8TBz1n5AGkQIDAQAB"}]}'
t "les quatre enregistrements d'origine n'ont pas bougé" zone_intact
t "la zone compte sept enregistrements" state_is 'st.zone.length' 7
t "aucune suppression demandée à Spaceship" req_is DELETE spaceship.dev 0
t "vérification déclenchée une fois" req_is POST /verify 1
t "domaine vérifié" state_is 'st.domain.status' verified
t "clé d'envoi limitée au domaine" state_is 'JSON.stringify(st.createdKey)' '{"name":"cortex-app","permission":"sending_access","domain_id":"4dd369bc-aa82-4ff3-97de-514ae3000ee0"}'
t "la clé d'envoi arrive à Railway par l'entrée standard" test "$(cat "$S/railway.stdin.RESEND_API_KEY")" = "$FAKE_SEND"
t "RESEND_API_KEY posée sans déployer" log_has railway.argv "variable set RESEND_API_KEY --stdin -p d32e7d48-251b-437d-9f7a-b7a71ea58e5c -e production -s cortex-app --skip-deploys"
t "AUTH_EMAIL_FROM posée sans déployer" log_has railway.argv "variable set AUTH_EMAIL_FROM=Cortex <noreply@cortexexam.com> -p d32e7d48-251b-437d-9f7a-b7a71ea58e5c -e production -s cortex-app --skip-deploys"
t "un seul redéploiement" test "$(grep -c '^deployment redeploy' "$S/railway.argv")" = "1"
t "fin du redéploiement attendue et constatée" out_has "✓ Redéployé."
t "e-mail de test envoyé avec la clé d'envoi" state_is 'st.emails.length+" "+st.emails[0].key' "1 send"
t "expéditeur et destinataire du test" state_is 'st.emails[0].body.from+" → "+st.emails[0].body.to[0]' "Cortex <noreply@cortexexam.com> → abensur.benjamin@gmail.com"
t "suppression de la clé de mise en place proposée" out_has "La clé « cortex-setup » ne sert plus"
t "presse-papiers vidé après les saisies" test "$(grep -c '^$' "$S/pbcopy.log")" -ge 2
t "six étapes au récapitulatif" test "$(grep -c '^   ✓ [1-6] ' "$S/out")" = "6"
t "aucune clé à l'écran, en argument, ouverte ni copiée" no_leak
t "rien d'écrit dans le dossier personnel" test -z "$(ls -A "$S/home")"

echo "2. Second passage : tout est déjà en place"
DOMAIN_STATUS=verified ZONE_HAS_RESEND=1 KEY_EXISTS=1 GO_SKIP="Continuer (l'ancienne" run second
t "se termine sans erreur" rc_is 0
t "domaine réutilisé, pas recréé" req_is POST api.resend.com/domains 0
t "aucun ajout dans la zone" req_is PUT /dns/records 0
t "zone inchangée" state_is 'st.zone.length' 7
t "vérification non redemandée" out_has "Domaine déjà vérifié"
t "clé d'envoi existante signalée, pas de doublon créé" state_is 'st.keys.length' 2
t "Railway n'est pas touché" log_lacks railway.argv "variable set"
t "aucune clé nulle part" no_leak

echo "3. L'API Spaceship refuse la clé : repli à la main"
SS_AUTH_FAIL=1 GO_SKIP="Demander la vérification|Créer la clé d'envoi|Envoyer un e-mail" run repli
t "se termine sans erreur" rc_is 0
t "aucun ajout par l'API" req_is PUT /dns/records 0
t "le refus de Spaceship est dit" out_has "Spaceship ne donne pas la zone (HTTP 401 : Unauthorized)"
t "page DNS ouverte" log_has open.log "https://www.spaceship.com/application/advanced-dns-application/manage/cortexexam.com/"
t "hôte send copié" log_has pbcopy.log "send"
t "valeur MX copiée" log_has pbcopy.log "feedback-smtp.eu-west-1.amazonses.com"
t "SPF copié sans ses guillemets" grep -qx 'v=spf1 include:amazonses.com ~all' "$S/pbcopy.log"
t "DKIM copié en entier" log_has pbcopy.log "8TBz1n5AGkQIDAQAB"
t "priorité du MX annoncée" out_has "priorité 10"
t "trois enregistrements proposés" out_has "Enregistrement 3/3"
t "zone inchangée" state_is 'st.zone.length' 4
t "aucune clé nulle part" no_leak

echo "4. Un ancien DKIM occupe déjà le nom : on n'y touche pas"
ZONE_OLD_DKIM=1 GO_SKIP="Demander la vérification|Créer la clé d'envoi|Envoyer un e-mail" run conflit
t "se termine sans erreur" rc_is 0
t "seuls les deux enregistrements libres sont ajoutés" state_is 'st.puts.length+" "+st.puts[0].items.map((i)=>i.type+" "+i.name).join(",")' "1 MX send,TXT send"
t "l'ancien DKIM est toujours là" state_is 'st.zone.filter((r)=>r.name==="resend._domainkey").map((r)=>r.value).join()' "p=ANCIENNECLE"
t "le conflit est annoncé" out_has "1 enregistrement(s) en conflit"
t "le bon DKIM est proposé à la main" log_has pbcopy.log "8TBz1n5AGkQIDAQAB"
t "les enregistrements d'origine n'ont pas bougé" zone_intact

echo "5. La zone perd un enregistrement pendant l'ajout : il est remis aussitôt"
SS_PUT_DROPS=une-fois GO_SKIP="Demander la vérification|Créer la clé d'envoi|Envoyer un e-mail" run perte
t "la perte est annoncée" out_has "ne sont plus dans la zone"
t "l'enregistrement perdu est nommé" out_has "CNAME www cname.vercel-dns.com"
t "il est remis par l'API, et lui seul" state_is 'JSON.stringify(st.puts[1])' '{"force":false,"items":[{"type":"CNAME","name":"www","cname":"cname.vercel-dns.com","ttl":1800}]}'
t "la remise en place est dite" out_has "Remis en place par l'API"
t "la zone a retrouvé ses quatre enregistrements d'origine, plus les trois de Resend" state_is 'st.zone.length+" "+st.zone.filter((r)=>r.name==="www").length' "7 1"

echo "5 bis. La remise en place échoue : la marche à suivre à la main"
SS_PUT_DROPS=toujours GO_SKIP="Demander la vérification|Créer la clé d'envoi|Envoyer un e-mail" run perte-definitive
t "l'échec est dit" out_has "Ils n'ont pas pu être remis par l'API"
t "la page DNS s'ouvre pour le remettre" log_has open.log "advanced-dns-application"

echo "6. Spaceship refuse l'ajout : repli à la main, zone intacte"
SS_PUT_REFUSED=1 GO_SKIP="Demander la vérification|Créer la clé d'envoi|Envoyer un e-mail" run refus
t "le refus est dit" out_has "Spaceship refuse l'ajout (HTTP 422 : Conflict with existing records)"
t "repli à la main" out_has "Enregistrement 1/3"
t "zone inchangée" zone_intact

echo "7. La zone ne tient pas en une page : pas d'écriture à l'aveugle"
SS_EXTRA_TOTAL=600 GO_SKIP="Demander la vérification|Créer la clé d'envoi|Envoyer un e-mail" run grande
t "aucun ajout par l'API" req_is PUT /dns/records 0
t "la raison est dite" out_has "plus d'enregistrements"

echo "8. La vérification ne passe pas : la clé d'envoi n'est pas mise en production"
VERIFY_AFTER=never run attente
t "se termine sans erreur" rc_is 0
t "soixante essais, puis abandon" test "$(wc -l < "$S/sleep.log" | tr -d ' ')" = "59"
t "l'attente est expliquée" out_has "Pas encore vérifié après 10 minutes (statut : pending)"
t "l'étape 5 refuse" out_has "Le domaine n'est pas encore vérifié"
t "aucune clé d'envoi créée" req_is POST /api-keys 0
t "Railway n'est pas touché" log_lacks railway.argv "variable set"

echo "9. Resend déclare l'échec : on n'attend pas dix minutes"
VERIFY_AFTER=failed run echec
t "arrêt au premier constat" test ! -e "$S/sleep.log"
t "l'échec est dit" out_has "Resend déclare la vérification en échec"

echo "10. Railway refuse la clé"
DOMAIN_STATUS=verified ZONE_HAS_RESEND=1 RAILWAY_KEY_RC=1 run railway-refus --etape=5
t "le refus est dit, avec la marche à suivre" out_has "Railway a refusé RESEND_API_KEY"
t "AUTH_EMAIL_FROM n'est pas posée" log_lacks railway.argv "AUTH_EMAIL_FROM"
t "pas de redéploiement" log_lacks railway.argv "deployment redeploy"
t "le test part quand même, avec la clé de mise en place" state_is 'st.emails.length+" "+st.emails[0].key' "1 setup"
t "aucune clé nulle part" no_leak

echo "11. Clé de mise en place : mal formée, puis refusée, puis bonne"
S="$TMP/saisie"; mkdir -p "$S"
printf '%s\n' "pas-une-cle" "$FAKE_SEND" "$FAKE_SETUP" > "$S/answers.SETUP_KEY"
GO_SKIP="Poser les enregistrements|Demander la vérification|Créer la clé d'envoi|Envoyer un e-mail" run saisie
t "trois saisies demandées" test "$(grep -c '^SETUP_KEY$' "$S/asked.log")" = "3"
t "la clé mal formée ne part pas sur le réseau" log_lacks requests.jsonl "pas-une-cle"
t "forme refusée" out_has "Ce n'est pas une clé Resend"
t "clé d'envoi refusée, avec l'explication" out_has "Il faut une clé « Full access »"
t "bonne clé acceptée" out_has "Clé acceptée par Resend"
t "aucune clé nulle part" no_leak

echo "12. Aucune clé saisie : rien n'est tenté"
S="$TMP/vide"; mkdir -p "$S"
: > "$S/answers.SETUP_KEY"
run vide
t "se termine sans erreur" rc_is 0
t "aucun appel à Resend ni à Spaceship" test ! -e "$S/requests.jsonl"
t "Railway n'est pas touché" log_lacks railway.argv "variable set"

echo "13. La région eu-west-1 est refusée : second essai sans région"
REGION_REFUSED=1 GO_SKIP="Demander la vérification|Créer la clé d'envoi|Envoyer un e-mail" run region
t "deux créations tentées" req_is POST api.resend.com/domains 2
t "domaine créé dans la région par défaut" state_is 'st.domain.region' us-east-1
t "le refus est dit" out_has "Création refusée en eu-west-1 (HTTP 422 : Region not available)"

echo "14. Essai à blanc"
run blanc --dry-run
t "se termine sans erreur" rc_is 0
t "aucun appel à une API" test ! -e "$S/requests.jsonl"
t "aucune clé demandée" test ! -e "$S/asked.log"
t "rien d'ouvert" test ! -e "$S/open.log"
t "rien de copié" test ! -e "$S/pbcopy.log"
t "Railway : lecture seule" bash -c "! grep -vE '^(whoami|deployment list)' '$S/railway.argv'"
t "les six étapes sont décrites" test "$(grep -c 'déroulé à blanc' "$S/out")" = "6"
t "l'essai à blanc est annoncé" out_has "Essai à blanc terminé : rien n'a été ouvert, copié ni écrit."

echo "15. Reprise à l'étape 3 avec les vraies invites, à la main (saisies sur l'entrée standard)"
S="$TMP/invites"; mkdir -p "$S"
# Dans l'ordre : faire l'étape 3, clé masquée, « s » = pas d'API Spaceship, six Entrée
# (hôte puis valeur de trois enregistrements), puis « s » aux étapes 4, 5 et 6.
REAL_PROMPTS=1
DOMAIN_STATUS=not_started run invites --etape=3 < <(printf '\n%s\ns\n\n\n\n\n\n\ns\ns\ns\n' "$FAKE_SETUP")
REAL_PROMPTS=0
t "se termine sans erreur" rc_is 0
t "la clé masquée a été lue et acceptée" out_has "Clé acceptée par Resend"
t "les trois enregistrements défilent" out_has "Enregistrement 3/3"
t "six copies d'enregistrement, plus le vidage du presse-papiers" test "$(wc -l < "$S/pbcopy.log" | tr -d ' ')" = "7"
t "les étapes passées sont listées" test "$(grep -c '· passé : ' "$S/out")" = "3"
t "aucun ajout par l'API" req_is PUT /dns/records 0
t "aucune clé nulle part" no_leak

echo "16. Resend ne renvoie aucun enregistrement : rien n'est écrit dans la zone"
RESEND_NO_RECORDS=1 GO_SKIP="Demander la vérification|Créer la clé d'envoi|Envoyer un e-mail" run sans-enregistrement
t "aucun ajout par l'API" req_is PUT /dns/records 0
t "ce n'est pas présenté comme « rien à ajouter »" out_lacks "Rien à ajouter"
t "le défaut est dit" out_has "illisibles"

echo
if [[ "$FAIL" -eq 0 ]]; then echo "Banc d'essai : $PASS vérifications réussies."; else echo "Banc d'essai : $FAIL échec(s) sur $((PASS + FAIL))."; exit 1; fi
