#!/usr/bin/env bash
# Régénère lib/disposable-domains.ts depuis la liste communautaire des domaines
# d'e-mail jetables (github.com/disposable-email-domains, domaine public CC0).
# La liste est VENDORÉE : l'app ne fait aucun appel réseau pour la consulter.
# À relancer de temps en temps (nouveaux domaines), relire le diff, commiter.
#   bash scripts/update-disposable-domains.sh            # télécharge la liste
#   bash scripts/update-disposable-domains.sh fichier    # depuis un fichier local
set -euo pipefail
cd "$(dirname "$0")/.."
URL="https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf"
src="${1:-}"
if [[ -z "$src" ]]; then
  src="$(mktemp)"; trap 'rm -f "$src"' EXIT
  curl -sSfL --max-time 60 -o "$src" "$URL"
fi
out=lib/disposable-domains.ts
{
  echo "// GÉNÉRÉ par scripts/update-disposable-domains.sh — ne pas éditer à la main."
  echo "// Source : $URL (CC0), $(date -u +%Y-%m-%d)."
  echo "// Un domaine par ligne, minuscules. Lu par lib/email-identity (isDisposableEmail)."
  echo 'export const DISPOSABLE_DOMAINS = `'
  tr -d '\r' < "$src" | tr 'A-Z' 'a-z' | grep -E '^[a-z0-9.-]+$' | sort -u
  echo '`;'
} > "$out"
echo "$(grep -cE '^[a-z0-9.-]+$' "$out") domaines → $out"
