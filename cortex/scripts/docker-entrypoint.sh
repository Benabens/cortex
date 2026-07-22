#!/usr/bin/env bash
# Entrée du conteneur Cortex : boot de prod (volume, migrations, seed —
# no-op si non configurés) puis `next start`. Le worker de jobs vit dans le
# même process : instrumentation.ts pompe la file au boot puis toutes les 60 s,
# et chaque job est un process enfant tsx (lib/jobs.ts).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f scripts/prod-boot.ts ]; then
  echo "[entrypoint] prod-boot (volume/migrations/seed)…"
  node_modules/.bin/tsx scripts/prod-boot.ts
fi

echo "[entrypoint] next start sur le port ${PORT:-3000}"
exec node_modules/.bin/next start -p "${PORT:-3000}"
