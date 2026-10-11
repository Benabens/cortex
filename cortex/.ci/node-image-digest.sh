#!/usr/bin/env bash
# Lit le condensé du tag de l'image de base (défaut : node:22-slim) sur Docker
# Hub et sur le miroir AWS, sans Docker : c'est la valeur à écrire dans
# `ARG NODE_IMAGE` du Dockerfile quand on monte la base (DEPLOY.md § 1).
# Les deux doivent être identiques : sinon le miroir est en retard, attendre.
set -euo pipefail

image="${1:-node:22-slim}"
name="${image%%:*}"
tag="${image##*:}"
accept='Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json'
digest() { curl -fsSI -m 20 -H "Authorization: Bearer $1" -H "$accept" "$2" | tr -d '\r' | awk 'tolower($1) == "docker-content-digest:" { print $2 }'; }

hub_token=$(curl -fsS -m 20 "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/$name:pull" | jq -r .token)
aws_token=$(curl -fsS -m 20 https://public.ecr.aws/token/ | jq -r .token)
hub=$(digest "$hub_token" "https://registry-1.docker.io/v2/library/$name/manifests/$tag")
aws=$(digest "$aws_token" "https://public.ecr.aws/v2/docker/library/$name/manifests/$tag")

echo "Docker Hub : $hub"
echo "miroir AWS : $aws"
if [ -n "$hub" ] && [ "$hub" = "$aws" ]; then
  echo "✓ identiques. À écrire dans le Dockerfile :"
  echo "ARG NODE_IMAGE=public.ecr.aws/docker/library/$image@$hub"
else
  echo "✗ différents ou illisibles : ne pas monter la base maintenant."
  exit 1
fi
