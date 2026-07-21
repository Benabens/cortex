# ═══════════════════════════════════════════════════════════════════════════
# Cortex — image de production : UN conteneur = app Next.js + worker de jobs.
#
# Le « worker » n'est pas un process séparé : instrumentation.ts (au boot de
# `next start`) réconcilie + pompe la file de jobs, et chaque job est un
# process enfant `tsx scripts/run-job.ts` spawné par lib/jobs.ts. L'image doit
# donc embarquer les SOURCES TypeScript (lib/, scripts/, db/) + tsx — pas de
# build `standalone`.
#
# Contexte de build = RACINE du repo (pas cortex/) : l'app sert les sites de
# révision situés au-dessus de cortex/ (app/voir → CONTENT_ROOT = parent du
# cwd, et public/sites/* sont des symlinks relatifs vers ../../../).
#
# Outillage embarqué : tectonic (LaTeX→PDF, cache de bundles préchauffé au
# build), python3 + matplotlib + numpy + sympy (figures + vérif symbolique),
# sqlite3 (réparation cs-202), poppler-utils (pdftoppm, vision des annales),
# procps (ps — annulation de jobs), util-linux (unshare — sandbox), gcc
# (vérif des exos C).
# ═══════════════════════════════════════════════════════════════════════════

# ── Étape 1 : dépendances (npm ci complet, devDeps incluses pour le build) ──
FROM node:22-slim AS deps
# Outils de compilation au cas où better-sqlite3 n'a pas de prebuild pour la
# plateforme (sinon npm les ignore).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/cortex
COPY cortex/package.json cortex/package-lock.json ./
# NODE_ENV ne doit PAS valoir production ici (sinon npm omet les devDeps).
ENV NODE_ENV=
RUN npm ci

# ── Étape 2 : build Next + élagage des devDeps ──────────────────────────────
FROM node:22-slim AS build
WORKDIR /app/cortex
COPY --from=deps /app/cortex/node_modules ./node_modules
COPY cortex/ ./
# next build DOIT tourner sans NODE_ENV=development (le pré-rendu des pages
# internes Next casse en mode dev — piège vérifié).
ENV NODE_ENV=
RUN npm run build \
    && npm prune --omit=dev

# ── Étape 3 : runtime ───────────────────────────────────────────────────────
FROM node:22-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl ca-certificates \
    python3 python3-matplotlib python3-numpy python3-sympy \
    sqlite3 poppler-utils procps util-linux gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*

# tectonic : binaire statique musl officiel, pinné.
ARG TARGETARCH=amd64
ARG TECTONIC_VERSION=0.15.0
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) TECTONIC_ARCH=x86_64 ;; \
      arm64) TECTONIC_ARCH=aarch64 ;; \
      *) echo "arch non gérée: ${TARGETARCH}" && exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-${TECTONIC_ARCH}-unknown-linux-musl.tar.gz" \
      | tar -xz -C /usr/local/bin tectonic; \
    /usr/local/bin/tectonic --version

# Sites de révision statiques (lecture seule) au-dessus de cortex/ — servis
# par /sites (symlinks de public/sites) et /voir (CONTENT_ROOT = parent).
WORKDIR /app
COPY reviews.html index.html c_cheatsheet.html cheatsheet_v5_preview.html \
     c_errors_journal.html exam_packets_R1_table.html final2020_enonce.html \
     lab4_inode_walk.html ./
COPY exercices/ ./exercices/
COPY cours/ ./cours/
COPY labs/ ./labs/
COPY notes/ ./notes/

# L'app : .next + node_modules (prod + tsx) + sources TS + latex/ + data/ committée.
COPY --from=build /app/cortex /app/cortex
WORKDIR /app/cortex

# Préchauffe le cache de bundles tectonic (~/.cache/Tectonic) en compilant un
# document avec le VRAI préambule — sinon la 1ʳᵉ génération en prod télécharge
# ~100 Mo. Toléré en échec (réseau) : le runtime retéléchargera au besoin.
RUN set -eux; \
    mkdir -p /tmp/tectonic-warm; \
    cp latex/epfl-logo.png /tmp/tectonic-warm/ 2>/dev/null || true; \
    cat latex/preamble.tex latex/figures.tex > /tmp/tectonic-warm/warm.tex; \
    printf '\n\\begin{document}\nWarm-up.\n\\end{document}\n' >> /tmp/tectonic-warm/warm.tex; \
    (cd /tmp/tectonic-warm && /usr/local/bin/tectonic --chatter minimal warm.tex) \
      || echo "AVERTISSEMENT: warm-up tectonic incomplet (bundle téléchargé au 1er run)"; \
    rm -rf /tmp/tectonic-warm

ENV CORTEX_TEX_BIN=/usr/local/bin/tectonic \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000

EXPOSE 3000

# Railway utilise healthcheckPath (railway.json) ; ce HEALTHCHECK sert au
# docker run local / CI.
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=8 \
  CMD curl -fsS "http://localhost:${PORT}/api/health" || exit 1

CMD ["bash", "scripts/docker-entrypoint.sh"]
