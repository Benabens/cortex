#!/usr/bin/env bash
# Essai de restauration de la dernière sauvegarde hors site (audit du 13/11/2026, Y5).
#
#   bash scripts/restauration-ben.sh             # rapatrie, restaure sur un Postgres jetable, chronomètre
#   bash scripts/restauration-ben.sh --dry-run   # montre les étapes sans rien toucher
#   GARDER=1 bash scripts/restauration-ben.sh    # garde la copie à la fin (sinon effacée)
#   BACKUP_DIR=<dossier> bash scripts/restauration-ben.sh   # restaure un dossier déjà rapatrié (saute 1-2)
#
# Côté prod : LECTURE SEULE. Le script lit les variables BACKUP_S3_* sur Railway
# et télécharge la sauvegarde ; il n'écrit ni dans la base, ni dans le bucket, ni
# dans les variables. La restauration se fait sur un Postgres LOCAL jetable
# (port 55490, TCP seul), arrêté et effacé à la fin.
#
# La copie contient les données personnelles des utilisateurs : elle va dans
# contenu-prive/ (hors git) et est effacée à la fin sauf GARDER=1.
set -euo pipefail

PROJECT=d32e7d48-251b-437d-9f7a-b7a71ea58e5c
PG18=/opt/homebrew/opt/libpq/bin            # pg_restore / psql 18 (dumps du serveur 18)
PG17=/opt/homebrew/opt/postgresql@17/bin    # serveur local jetable (restauration éprouvée le 13/10)
PORT=55490
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$HERE/../cortex"
WORK="$HOME/Projects/cortex/contenu-prive/restauration-$(date +%Y%m%d-%H%M%S)"
URL="postgresql://postgres@127.0.0.1:$PORT/restore"

step() { printf '\n▶ %s\n' "$*"; }
if [[ "${1:-}" == "--dry-run" ]]; then
  cat <<EOF
[dry-run] étapes, rien n'est lancé :
 1. lire BACKUP_S3_* du service cortex-app (railway variable list, valeurs jamais affichées)
 2. npm run backup:verify -- --latest --keep=$WORK/backup   (empreintes + table des matières du dump)
 3. initdb + pg_ctl : Postgres 17 jetable sur 127.0.0.1:$PORT, données dans $WORK/pg
 4. pg_restore 18 --no-owner --no-acl de postgres.dump → base « restore », chronométré
 5. contrôles : tables restaurées = tables du dump, comptes, crédits, schémas des cours
 6. tar -xzf data.tar.gz → $WORK/data, chronométré
 7. arrêt du Postgres jetable ; effacement de $WORK (sauf GARDER=1)
EOF
  exit 0
fi

for bin in "$PG18/pg_restore" "$PG18/psql" "$PG17/initdb" "$PG17/pg_ctl"; do
  [[ -x "$bin" ]] || { echo "Outil absent : $bin (brew install libpq postgresql@17)"; exit 1; }
done
command -v railway >/dev/null || { echo "railway CLI absente"; exit 1; }
command -v jq >/dev/null || { echo "jq absent (brew install jq)"; exit 1; }
if lsof -iTCP:"$PORT" -sTCP:LISTEN -n >/dev/null 2>&1; then echo "Port $PORT occupé : libère-le ou change PORT."; exit 1; fi

mkdir -p "$WORK"
chmod 700 "$WORK"
cleanup() {
  "$PG17/pg_ctl" -D "$WORK/pg" -m fast stop >/dev/null 2>&1 || true
  if [[ "${GARDER:-0}" == "1" ]]; then echo "Copie gardée : $WORK (à effacer : rm -rf \"$WORK\")"
  else rm -rf "$WORK"; echo "Copie locale effacée ($WORK)."; fi
}
trap cleanup EXIT
T0=$(date +%s)

if [[ -n "${BACKUP_DIR:-}" ]]; then
  DIR="$BACKUP_DIR"
  echo "Dossier local : $DIR (étapes 1-2 sautées)"
else
  step "1. Accès au bucket de sauvegarde (variables lues sur Railway, non affichées)"
  while IFS=$'\t' read -r key value; do export "$key=$value"; done < <(
    railway variable list -p "$PROJECT" -e production -s cortex-app --json \
      | jq -r 'to_entries[] | select(.key | startswith("BACKUP_S3_")) | [.key, .value] | @tsv'
  )
  [[ -n "${BACKUP_S3_BUCKET:-}" ]] || { echo "BACKUP_S3_BUCKET introuvable sur Railway."; exit 1; }
  echo "bucket : $BACKUP_S3_BUCKET"

  step "2. Rapatriement + vérification de la plus récente"
  T1=$(date +%s)
  (cd "$APP" && PATH="$PG18:$PATH" npx tsx scripts/backup-verify.ts --latest --keep="$WORK/backup")
  DIR=$(find "$WORK/backup" -mindepth 1 -maxdepth 1 -type d | head -1)
  echo "téléchargé en $(( $(date +%s) - T1 )) s : $(du -sh "$DIR" | cut -f1)"
fi
[[ -f "$DIR/postgres.dump" ]] || { echo "postgres.dump absent de $DIR"; exit 1; }

step "3. Postgres 17 jetable sur 127.0.0.1:$PORT"
LC_ALL=en_US.UTF-8 "$PG17/initdb" -D "$WORK/pg" -U postgres --auth=trust --locale=C -E UTF8 >/dev/null
"$PG17/pg_ctl" -D "$WORK/pg" -l "$WORK/pg.log" -w \
  -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" start >/dev/null
"$PG18/psql" "postgresql://postgres@127.0.0.1:$PORT/postgres" -X -q -c "CREATE DATABASE restore"

step "4. Restauration du dump Postgres"
T2=$(date +%s)
set +e
"$PG18/pg_restore" --no-owner --no-acl -d "$URL" "$DIR/postgres.dump" 2> "$WORK/pg_restore.err"
RC=$?
set -e
RESTORE_S=$(( $(date +%s) - T2 ))
ERRORS=$(grep -c "error:" "$WORK/pg_restore.err" || true)
echo "pg_restore : code $RC, $ERRORS erreur(s), $RESTORE_S s"
[[ "$ERRORS" -eq 0 ]] || { echo "Premières erreurs :"; grep "error:" "$WORK/pg_restore.err" | head -5; }

step "5. Contrôles"
EXPECTED=$("$PG18/pg_restore" -l "$DIR/postgres.dump" | grep " TABLE " | grep -vc " TABLE DATA " || true)
"$PG18/psql" "$URL" -X -q -v expected="$EXPECTED" <<'SQL'
\pset footer off
SELECT :expected AS tables_dans_le_dump,
       (SELECT count(*) FROM information_schema.tables
         WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')) AS tables_restaurees,
       (SELECT count(*) FROM information_schema.schemata WHERE schema_name LIKE 't\_%') AS schemas_de_cours;
SELECT (SELECT count(*) FROM public.users) AS comptes,
       (SELECT count(*) FROM public.credit_transactions) AS mouvements_de_credits,
       (SELECT count(*) FROM public.llm_usage) AS appels_llm,
       (SELECT max(created_at) FROM public.credit_transactions) AS dernier_mouvement;
SQL

step "6. Archive du volume (/data)"
T3=$(date +%s)
mkdir -p "$WORK/data"
tar -xzf "$DIR/data.tar.gz" -C "$WORK/data"
echo "extraite en $(( $(date +%s) - T3 )) s : $(du -sh "$WORK/data" | cut -f1), $(find "$WORK/data" -type f | wc -l | tr -d ' ') fichiers"

TOTAL=$(( $(date +%s) - T0 ))
echo
if [[ "$RC" -eq 0 && "$ERRORS" -eq 0 ]]; then
  echo "✓ Restauration OK en $TOTAL s au total (dump : $RESTORE_S s). Objectif de la checklist : moins de 5 min."
else
  echo "✗ Restauration INCOMPLÈTE ($ERRORS erreur(s)) : journal $WORK/pg_restore.err (relance avec GARDER=1 pour le lire)."
  exit 1
fi
