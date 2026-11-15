#!/usr/bin/env bash
# Entrée du conteneur Cortex : boot de prod (volume, migrations, seed —
# no-op si non configurés) puis `next start`. Le worker de jobs vit dans le
# même process : instrumentation.ts pompe la file au boot puis toutes les 60 s,
# et chaque job est un process enfant tsx (lib/jobs.ts).
set -euo pipefail
cd "$(dirname "$0")/.."

# CONTENEUR SANS ROOT (Dockerfile : USER cortex). Railway monte le volume en root
# et ne le rend inscriptible qu'à root : avec RAILWAY_RUN_UID=0, le conteneur
# démarre en root, on donne le volume à `cortex` (seuls les fichiers qui ne lui
# appartiennent pas encore : rapide à chaque démarrage), puis on abandonne root
# pour tout le reste : prod-boot, next, workers, tectonic, pdftoppm, sauvegardes.
app_user=cortex
if [ "$(id -u)" = "0" ]; then
  if [ -n "${CORTEX_DATA_DIR:-}" ]; then
    mkdir -p "$CORTEX_DATA_DIR"
    find "$CORTEX_DATA_DIR" -xdev \( ! -user "$app_user" -o ! -group "$app_user" \) -exec chown -h "$app_user:$app_user" {} +
  fi
  echo "[entrypoint] volume prêt, abandon de root → ${app_user}"
  exec setpriv --reuid="$app_user" --regid="$app_user" --init-groups -- bash "$PWD/scripts/docker-entrypoint.sh" "$@"
fi
# Sans root et volume monté en root : refuser de démarrer plutôt que de servir
# une app qui ne peut rien écrire (imports, examens, base sqlite).
if [ -n "${CORTEX_DATA_DIR:-}" ]; then
  probe="${CORTEX_DATA_DIR%/}/.cortex-write-probe"
  if ! { mkdir -p "$CORTEX_DATA_DIR" && : > "$probe" && rm -f "$probe"; } 2>/dev/null; then
    echo "[entrypoint] refus : ${CORTEX_DATA_DIR} n'est pas inscriptible par $(id -un) (uid $(id -u))." >&2
    echo "[entrypoint] Volume Railway monté en root : pose RAILWAY_RUN_UID=0 sur le service (l'entrypoint en fait le chown puis abandonne root)." >&2
    exit 1
  fi
fi

if [ -f scripts/prod-boot.ts ]; then
  echo "[entrypoint] prod-boot (volume/migrations/seed)…"
  node_modules/.bin/tsx scripts/prod-boot.ts
fi

echo "[entrypoint] next start sur le port ${PORT:-3000}"
exec node_modules/.bin/next start -p "${PORT:-3000}"
