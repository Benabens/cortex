#!/usr/bin/env bash
# Coût RÉEL d'un examen en prod (audit du 13/11/2026, Y1) — LECTURE SEULE.
#
#   bash scripts/cout-reel-ben.sh              # interroge la base de prod (transaction READ ONLY)
#   bash scripts/cout-reel-ben.sh --dry-run    # montre ce qui serait lancé, sans rien toucher
#
# Lit public.llm_usage (tokens et coût de chaque appel au modèle) et rend :
# dépense par mois, coût moyen par type de génération face au prix en crédits,
# les 15 derniers jobs, les appels interactifs. Rien n'est écrit, nulle part.
#
# Réglages (variables d'environnement, valeurs par défaut entre parenthèses) :
#   EUR_PER_USD  taux de change € par $ (0.86) — à ajuster au jour du calcul
#   CREDIT_PACK  € nets encaissés par crédit d'un pack (0.86 = 9 € − frais Stripe ≈ 0,39 €, ÷ 10)
#   CREDIT_ABO   € nets par crédit d'abonnement mensuel (0.70 = 14,90 € − frais ≈ 0,58 €, ÷ 20)
set -euo pipefail

PROJECT=d32e7d48-251b-437d-9f7a-b7a71ea58e5c
PSQL=/opt/homebrew/opt/libpq/bin/psql   # psql 18 (le serveur est en 18)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL="$HERE/cout-reel-ben.sql"
EUR_PER_USD="${EUR_PER_USD:-0.86}"
CREDIT_PACK="${CREDIT_PACK:-0.86}"
CREDIT_ABO="${CREDIT_ABO:-0.70}"

command -v railway >/dev/null || { echo "railway CLI absente (brew install railway)"; exit 1; }
[[ -x "$PSQL" ]] || { echo "psql 18 absent : brew install libpq"; exit 1; }
[[ -f "$SQL" ]] || { echo "Fichier SQL introuvable : $SQL"; exit 1; }
for v in "$EUR_PER_USD" "$CREDIT_PACK" "$CREDIT_ABO"; do
  [[ "$v" =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "Valeur numérique attendue (point décimal) : $v"; exit 1; }
done

echo "Coût réel Cortex — taux $EUR_PER_USD €/\$, crédit pack $CREDIT_PACK €, crédit abonnement $CREDIT_ABO €"
if [[ "${1:-}" == "--dry-run" ]]; then
  echo "[dry-run] railway run -p $PROJECT -e production -s Postgres -- psql \"\$DATABASE_PUBLIC_URL\" -f $SQL"
  echo "[dry-run] requêtes (toutes en transaction READ ONLY) :"
  grep -E "^\\\\echo '==" "$SQL" | sed "s/^\\\\echo '//; s/'$//"
  exit 0
fi

railway run -p "$PROJECT" -e production -s Postgres -- bash -c \
  '"$0" "$DATABASE_PUBLIC_URL" -X -q -v eur="$1" -v credit_pack="$2" -v credit_abo="$3" -f "$4"' \
  "$PSQL" "$EUR_PER_USD" "$CREDIT_PACK" "$CREDIT_ABO" "$SQL"

cat <<'EOF'

Lecture :
- marge_abo_pct < 0 sur une ligne = ce type de génération est vendu à perte à un abonné.
- appels_estimes > 0 = tokens estimés (provider sans compteur), coût moins fiable.
- Pour changer un prix sans code : variable Railway CREDITS_COST_JSON, ex. {"qcm":2}.
EOF
