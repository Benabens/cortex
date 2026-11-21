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

# ── Image de base : Node 22 (Debian slim), la même pour les trois étapes ──
# Tirée du miroir AWS des images officielles Docker, pas de Docker Hub : le
# 9 octobre 2026, Docker Hub a refusé les pulls pendant une heure (429, puis
# 504) et deux builds de production ont échoué sur cette ligne.
# Épinglée par son condensé, identique sur Docker Hub : c'est bit pour bit
# l'image officielle `node:22-slim`, et un tag déplacé sur le miroir ne change
# pas ce qui est construit. Contrepartie : la base ne se met plus à jour toute
# seule. Pour la monter (cortex/.ci/node-image-digest.sh) ou revenir à Docker
# Hub, voir DEPLOY.md § 1.
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

# ── Étape 1 : dépendances (npm ci complet, devDeps incluses pour le build) ──
FROM ${NODE_IMAGE} AS deps
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
FROM ${NODE_IMAGE} AS build
WORKDIR /app/cortex
COPY --from=deps /app/cortex/node_modules ./node_modules
COPY cortex/ ./
# next build DOIT tourner sans NODE_ENV=development (le pré-rendu des pages
# internes Next casse en mode dev — piège vérifié).
ENV NODE_ENV=
RUN npm run build \
    && npm prune --omit=dev
# Wheels pandas de la vérification Python en WebAssembly (CORTEX_PYTHON_WASM=1) : le paquet npm
# pyodide ne les contient pas, et loadPackage les téléchargerait depuis le CDN jsDelivr dans
# chaque nouveau conteneur, pendant une vérification. Toléré en échec (réseau), comme le
# préchauffage tectonic ; la CI vérifie, réseau coupé, que l'image les contient.
RUN node_modules/.bin/tsx scripts/pyodide-prefetch.ts \
    || echo "AVERTISSEMENT: wheels Pyodide absents (téléchargés depuis le CDN au premier chargement)"

# ── Étape 3 : runtime ───────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl ca-certificates gnupg \
    python3 python3-matplotlib python3-numpy python3-sympy \
    sqlite3 poppler-utils poppler-data procps util-linux gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*

# Outils client PostgreSQL (pg_dump / pg_restore / psql) pour les sauvegardes
# quotidiennes (lib/backup). pg_dump REFUSE un serveur plus récent que lui
# (« server version mismatch ») : PG_CLIENT_MAJOR doit être ≥ la version
# majeure du Postgres managé (Railway : 18). Debian n'embarque que la 15 →
# dépôt officiel PGDG. Surcharge : docker build --build-arg PG_CLIENT_MAJOR=19.
ARG PG_CLIENT_MAJOR=18
RUN set -eux; \
    install -d /usr/share/postgresql-common/pgdg; \
    curl --http1.1 --retry 5 --retry-all-errors -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc; \
    . /etc/os-release; \
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends "postgresql-client-${PG_CLIENT_MAJOR}"; \
    rm -rf /var/lib/apt/lists/*; \
    pg_dump --version; pg_restore --version

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

# ── Utilisateur sans privilège ──────────────────────────────────────────────
# L'app, les workers, tectonic et pdftoppm traitent des fichiers NON FIABLES
# (annales importées, LaTeX généré) : une faille dans l'un d'eux ne doit pas
# donner root (audit du 14/11/2026, n° 17). Le code reste à root, en lecture
# seule pour `cortex` ; seuls .next/ (cache de Next), data/ (sans volume),
# backups/ et HOME (cache tectonic, fontconfig) lui appartiennent.
# Le volume Railway est monté en root : RAILWAY_RUN_UID=0 lance le conteneur en
# root, l'entrypoint fait le chown du volume puis abandonne root (setpriv).
RUN groupadd --system --gid 10001 cortex \
    && useradd --system --uid 10001 --gid cortex --home-dir /home/cortex --create-home --shell /usr/sbin/nologin cortex
ENV HOME=/home/cortex \
    XDG_CACHE_HOME=/home/cortex/.cache

# Préchauffe le cache de bundles tectonic ($XDG_CACHE_HOME/Tectonic) en compilant un
# document avec le VRAI préambule — sinon la 1ʳᵉ génération en prod télécharge
# ~100 Mo. multicol en plus : les QCM sur deux colonnes d'une annale (lib/exam-layout-pdf). Toléré en échec (réseau) : le runtime retéléchargera au besoin.
# AVANT la copie de l'app (audit fuites P2) : cette couche ne dépend que de tectonic
# et des quatre fichiers LaTeX copiés ici, elle reste donc en cache d'un build à
# l'autre ; placée après, chaque commit refaisait le téléchargement et la compilation.
# Tourne en `cortex` : le cache de bundles lui appartient (--chown : les sources et
# leur dossier aussi, pour que la même couche les efface).
# Second document : les polices Unicode (cyrillique, grec, CJK) que lib/exam-latex ajoute quand
# un examen imprime une écriture au-delà de Latin-1 ; elles sont alors en cache, hors ligne.
# poppler-data (étape runtime) donne à poppler les tables CJK (Adobe-GB1…) : sans elles, pdftotext
# et pdftoppm ne lisent pas le chinois d'un PDF, généré (Fandol) ou déposé.
COPY --chown=cortex:cortex cortex/latex/preamble.tex cortex/latex/figures.tex cortex/latex/generic.tex cortex/latex/unicode-fonts.tex cortex/latex/cjk-fonts.tex cortex/latex/epfl-logo.png /tmp/tectonic-warm/
USER cortex
RUN set -eux; \
    cd /tmp/tectonic-warm; \
    cat preamble.tex figures.tex generic.tex > warm.tex; \
    printf '\n\\usepackage{multicol}\n\\newcommand{\\FOOTDATE}{Warm}\n\\begin{document}\nWarm-up.\n\\end{document}\n' >> warm.tex; \
    /usr/local/bin/tectonic --chatter minimal warm.tex \
      || echo "AVERTISSEMENT: warm-up tectonic incomplet (bundle téléchargé au 1er run)"; \
    cat preamble.tex figures.tex generic.tex unicode-fonts.tex cjk-fonts.tex > warm-unicode.tex; \
    printf '\n\\newcommand{\\FOOTDATE}{Warm}\n\\begin{document}\nЖα中 \\textbf{Жα中} \\textit{Жα} \\textbf{\\textit{Жα}} \\textsf{Жα中 \\textbf{Жα中} \\textit{Жα} \\textbf{\\textit{Жα}}} \\texttt{Жα中 \\textbf{Жα} \\textit{Жα} \\textbf{\\textit{Жα}}}\n\\end{document}\n' >> warm-unicode.tex; \
    /usr/local/bin/tectonic --chatter minimal warm-unicode.tex \
      || echo "AVERTISSEMENT: warm-up des polices Unicode incomplet (téléchargées au 1er examen concerné)"; \
    cd /; rm -rf /tmp/tectonic-warm
USER root

# Coréen (hangul-fonts.tex), hébreu et arabe (hebrew-fonts.tex, arabic-fonts.tex, balisés par
# lib/tex-bidi) : leurs polices du bundle (Un, FreeSerif, Amiri) en cache, chaque graisse et
# chaque style, pour compiler hors ligne. Couche à part : +26 Mo de cache tectonic (mesure du 21/11).
COPY --chown=cortex:cortex cortex/latex/preamble.tex cortex/latex/figures.tex cortex/latex/generic.tex cortex/latex/unicode-fonts.tex cortex/latex/cjk-fonts.tex cortex/latex/hangul-fonts.tex cortex/latex/hebrew-fonts.tex cortex/latex/arabic-fonts.tex cortex/latex/epfl-logo.png /tmp/tectonic-warm-rtl/
USER cortex
RUN set -eux; \
    cd /tmp/tectonic-warm-rtl; \
    cat preamble.tex figures.tex generic.tex unicode-fonts.tex cjk-fonts.tex hangul-fonts.tex hebrew-fonts.tex arabic-fonts.tex > warm-rtl.tex; \
    printf '\n\\newcommand{\\FOOTDATE}{Warm}\n\\begin{document}\n한 \\textbf{한} \\textsf{한 \\textbf{한}} \\texttt{한}\n\\CortexRL{\\CortexHe{א \\textbf{א} \\textit{א} \\textbf{\\textit{א}}} \\CortexLR{1}} \\CortexRL{\\CortexAr{ب \\textbf{ب} \\textit{ب} \\textbf{\\textit{ب}}}}\n\\end{document}\n' >> warm-rtl.tex; \
    /usr/local/bin/tectonic --chatter minimal warm-rtl.tex \
      || echo "AVERTISSEMENT: warm-up des polices coréennes, hébraïques et arabes incomplet (téléchargées au 1er examen concerné)"; \
    cd /; rm -rf /tmp/tectonic-warm-rtl
USER root

# Aucun contenu de cours n'est embarqué : annales, slides et supports
# appartiennent à leur université et ne sont pas dans ce dépôt. Ce que
# l'utilisateur importe via l'app vit sur le volume persistant
# (CORTEX_DATA_DIR), pas dans l'image.
WORKDIR /app

# L'app : .next + node_modules (prod + tsx) + sources TS + latex/.
COPY --from=build /app/cortex /app/cortex
WORKDIR /app/cortex
RUN mkdir -p .next/cache data backups \
    && chown -R cortex:cortex .next data backups

# La suite (test de la sandbox) et le conteneur tournent en `cortex`.
USER cortex

#   CORTEX_SEED_COURSES : vide — aucun contenu de cours n'est committé, chaque
#   utilisateur importe ses propres annales depuis l'app.
#   SEED_NEW_TENANTS : 0 — un nouvel utilisateur démarre sur un espace VIDE et
#   crée sa matière (à 1, il recevrait une copie du contenu d'un autre tenant,
#   ce qui n'a de sens qu'avec un cours de démonstration dédié).
#   NODE_ENV=production : `next start` le pose pour lui-même, mais prod-boot et
#   les workers tsx tournent hors de Next ; explicite, il active leurs gardes de
#   production (refus de démarrer sans auth, magic-link jamais loggé).
#   NEXT_MANUAL_SIG_HANDLE=1 : `next start` ne sort plus de lui-même au SIGTERM ;
#   instrumentation.ts laisse finir les jobs en cours avant de sortir (lib/drain),
#   dans le délai RAILWAY_DEPLOYMENT_DRAINING_SECONDS du service.
ENV NODE_ENV=production \
    CORTEX_TEX_BIN=/usr/local/bin/tectonic \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_MANUAL_SIG_HANDLE=1 \
    PORT=3000 \
    CORTEX_SEED_COURSES= \
    SEED_NEW_TENANTS=0

# Vérification de la SANDBOX à la construction : sans isolation, le moteur
# REFUSE d'exécuter du code (règle « aucune isolation → aucune exécution ») et
# les examens perdent leurs figures matplotlib et la vérification de code. Un
# `unshare -rn` peut être bloqué par la politique seccomp de l'hôte : on le
# teste ici pour que l'écart soit visible au build, pas découvert en prod.
# (Non bloquant : l'image reste utilisable, /api/health signale « sandbox » avec METRICS_TOKEN.)
RUN if unshare -rn true 2>/dev/null; then \
      echo "✓ sandbox : unshare -rn opérationnel"; \
    else \
      echo "⚠ AVERTISSEMENT : unshare -rn indisponible au BUILD (normal chez certains builders)."; \
      echo "  Vérifie /api/health avec METRICS_TOKEN (champ sandbox) : si false,"; \
      echo "  les figures matplotlib et la vérif de code seront désactivées."; \
    fi

EXPOSE 3000

# Railway utilise le healthcheck réglé sur le service (/api/health) ; ce HEALTHCHECK sert au
# docker run local / CI.
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=8 \
  CMD curl -fsS "http://localhost:${PORT}/api/health" || exit 1

# start.sh aiguille : preview de PR Railway → preview-entrypoint.sh, sinon
# docker-entrypoint.sh (ce que faisait railway.json, lu jusqu'au 2026-12-01).
CMD ["bash", "scripts/start.sh"]
