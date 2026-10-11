#!/usr/bin/env bash
# Tire une image officielle Docker (« postgres:18 ») depuis la première source
# qui répond, et la nomme comme sur Docker Hub : le reste de la CI n'a rien à
# savoir du registre. Sert au Postgres des tests ; l'image de production, elle,
# nomme sa base dans le Dockerfile.
#
# Pourquoi trois sources : le 9 octobre 2026, Docker Hub a refusé les pulls des
# runners GitHub pendant plus d'une demi-heure (« toomanyrequests », puis 504
# sur son service d'authentification), et le miroir AWS a répondu « Rate
# exceeded » à son tour. Aucune source seule ne tient ; une CI rouge sur main,
# c'est le déploiement bloqué.
set -euo pipefail

image="${1:?usage : pull-official.sh <image:tag>}"
for source in public.ecr.aws/docker/library mirror.gcr.io/library docker.io/library; do
  for attempt in 1 2 3; do
    if docker pull --quiet "$source/$image" >/dev/null; then
      docker tag "$source/$image" "$image"
      # Le condensé reste au journal : c'est lui qui dit quelle image la CI a validée.
      echo "✓ $image tirée depuis $source ($(docker image inspect --format '{{index .RepoDigests 0}}' "$source/$image"))"
      exit 0
    fi
    if [ "$attempt" -lt 3 ]; then sleep $((attempt * 5)); fi
  done
  echo "… $source ne sert pas $image pour l'instant"
done
echo "::error::$image introuvable sur les trois sources"
exit 1
