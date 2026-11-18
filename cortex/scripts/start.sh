#!/usr/bin/env bash
# Démarrage du conteneur (CMD du Dockerfile). Aiguille avant tout le reste :
#   - environnement de PR Railway (« …-pr-<n> ») → preview-entrypoint.sh, qui
#     neutralise les variables copiées de la prod puis lance docker-entrypoint.sh ;
#   - partout ailleurs (production, docker run local, CI) → docker-entrypoint.sh.
# Cet aiguillage était fait par railway.json (environments.pr.deploy.startCommand,
# supprimé depuis), et l'Infrastructure as Code ne peut pas le remplacer :
# .railway/railway.ts n'est appliqué qu'à la main, jamais aux environnements de
# PR que Railway crée tout seul. Ici, la règle voyage avec l'image.
set -euo pipefail
cd "$(dirname "$0")/.."

# Même reconnaissance que lib/railway-env (isPrEnvironment, insensible à la casse) :
# dans le doute, c'est preview-entrypoint.sh qui tranche, et il refuse plutôt que
# de démarrer avec les secrets de la prod.
name="${RAILWAY_ENVIRONMENT_NAME:-${RAILWAY_ENVIRONMENT:-}}"
name="${name#"${name%%[![:space:]]*}"}"; name="${name%"${name##*[![:space:]]}"}"
shopt -s nocasematch
if [[ "$name" =~ (^|-)pr-[0-9]+$ ]]; then
  exec bash scripts/preview-entrypoint.sh "$@"
fi
exec bash scripts/docker-entrypoint.sh "$@"
