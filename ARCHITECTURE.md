# Cortex — Architecture

> Le « second cerveau » de révision pour **Computer Systems (CS202)**.
> App locale, mono-utilisateur (Ben), avec clé API Claude. Tourne en local, données 100% locales.

## Principe directeur

Les sites HTML statiques existants (reviews.html, exercices/, cheatsheets…) sont **sacrés** : on n'y touche pas, on ne les réécrit pas. Cortex est le **cerveau autour** : il les **indexe**, retient les **faiblesses**, et **génère des examens** inédits. Esthétique fidèle : thème sombre, mêmes design tokens.

Anti-théâtre de productivité : aucune feature « jolie pour rien ». Chaque écran sert l'un de : rappel actif, répétition espacée, reconnaissance de patterns, suivi des erreurs, recherche/lookup, amorçage pré-examen.

## Stack technique

- **Next.js 15** (App Router, TypeScript, Turbopack) — UI + API routes.
- **Tailwind v4** mappé sur les design tokens existants (gold `#C58A4F`, bleu `#6FA8D6`, vert `#4FB89B`, bg `#1F1E1D`).
- **SQLite** (better-sqlite3) + **Drizzle ORM** — persistance locale typée, migrations.
- **SQLite FTS5** — index full-text → la recherche globale cross-sites.
- **@anthropic-ai/sdk** — génération d'examens + analyse des faiblesses.
- **PDF** : pdf parsing pour ingérer les 2 PDF du cours.
- Clé API : `.env.local` (gitignoré). Jamais commitée.

## Modèle de données (tables)

- **sources** — chaque artefact ingéré (PDF cours, série, midterm, final, review de lecture, lab, cheatsheet). Champs : `type`, `year`, `recency_weight` (2024/25 ≫ 2014), `path`, `title`.
- **items** — unités atomiques extraites (une carte, un exo, une définition). Champs : `source_id`, `type`, `lecture_id`, `text`, `html`, `images[]`, `tags[]`.
- **fts_items** — table virtuelle FTS5 sur `items.text` + texte brut des pages → recherche globale.
- **weaknesses** — `topic`, `description` (analyse Claude), `screenshot_path`, `severity`, `logged_at`, `related_item_ids`, `times_seen`, `last_reviewed`.
- **schedule** — état de répétition espacée par concept : `concept`, `last_tested_at`, `interval_days`, `next_due_at`, `ease`.
- **exams** — examens générés : `created_at`, `format_template`, `targeted_weakness_ids`, `html_path`, `status`.
- **exam_questions** — `exam_id`, `concept`, `statement_html`, `solution_html`, `source_inspiration`, `weakness_id`.

## Fonctionnalités (pages)

1. **/** — Hub : liens vers les sites statiques existants + accès aux outils du cerveau.
2. **/recherche** — Ctrl-F universel : full-text sur TOUT le contenu, résultats groupés par source, deep-links.
3. **/faiblesses** — Intake (note + screenshot PNG), liste, analyse Claude (« explique ma faiblesse »), liens vers items concernés.
4. **/examens** — Génération (Claude API : corpus + faiblesses + schedule → exam inédit au format prof), consultation, marquage fait.
5. **/sources** — Gérer les sources, uploader PDFs, régler les poids de récence, réindexer.

## Jobs

- `npm run ingest` — (ré)indexe tout le contenu (HTML + PDF) → DB + FTS.
- `npm run nightly` — avance la répétition espacée + génère un examen ciblant les concepts dus → écrit un `.html` au format des sites exos.

## Moteur IA : Claude Code (via abonnement Max), PAS l'API payante

Décision (Ben) : pour éviter tout coût API (l'API est facturée séparément du Max),
**le moteur de génération/analyse = Claude Code (moi)**, pas un appel API in-app.

Workflow « moi = moteur » (zéro coût, via Max) :
- `npm run exam:brief` → imprime le contexte (faiblesses + concepts dus + style anciens
  examens + matière) + le schéma JSON. Je lis, je rédige l'examen, j'écris un `.json`.
- `npm run exam:save -- <fichier.json>` → `persistExam()` : DB + HTML + répétition espacée.
- `npm run weakness:brief -- <id>` → contexte + chemin du screenshot (je le lis comme image).
- `npm run weakness:save -- <id> <fichier.json>` → met à jour la faiblesse + recalcule les liens.

La voie API directe (`/api/exams/generate`, `/api/weaknesses/analyze`, Opus 4.8) reste
en place mais **optionnelle** (payante) ; elles renvoient un message clair si pas de clé.

## Deux régimes

1. **Construction (en cours)** : Claude (moi) construit l'app. Continuité via STATE.md + git.
2. **Exploitation** : routine planifiée nocturne où je lance `exam:brief`, je rédige,
   je `exam:save` → un examen frais le matin, sans coût API.

## Refonte backend « produit » (branche `backend-overhaul`, juillet 2026)

> Objectif : passer d'un super-outil solo à une fondation multi-utilisateurs, SANS changer le
> comportement par défaut (dev €0, SQLite local, moteur Claude Code via Max). Tout est
> config-driven : les défauts = comportement historique. Preuve d'invariance à chaque phase :
> `scripts/regression-cs202.ts` byte-identique (`350d533f7b765a97` / `9a294bb25e9d919c`).

### Moteur LLM — `lib/llm/` (Phase A)
- Interface unique : `complete()` / `completeText()` / `completeVia(provider)` + `LlmError`
  (codes TIMEOUT/UNAVAILABLE préservés → mêmes mappings HTTP).
- 3 providers par `LLM_PROVIDER` : **claude-code** (défaut €0 : `claude -p` headless via Max,
  clés API strippées de l'env enfant, vision par chemins + `--add-dir`) · **anthropic**
  (SDK officiel, streaming) · **openai-compatible** (endpoint générique — NVIDIA NIM, vLLM…).
- Robustesse : retries backoff+jitter (erreurs retryable seulement — les fallbacks métier des
  call sites exigent le throw immédiat), timeout par appel, AbortSignal, limiteur de
  concurrence global FIFO (`LLM_MAX_CONCURRENCY`).
- 26 call sites migrés ; `lib/claude-code.ts` reste le pont bas niveau (inchangé).

### Données — `db/` (Phase B)
- **`db/tables.ts`** : SOURCE DE VÉRITÉ du schéma (20 tables, y c. les ex-« lazy ») → DDL
  généré pour les deux dialectes. `db/schema.ts`/migrations Drizzle conservés en héritage
  (Drizzle n'était PAS utilisé au runtime — tout le code est en SQL brut).
- **`db/q.ts`** : façade de requêtes ASYNC unique (`q.all/get/run/insert/exec/tx`,
  `ensureTable/ensureColumns`, `nowStr()/nowPlusDays()` — les ~200 sites SQL bruts ont été
  convertis ; SQL portable : plus de `datetime('now')`, `OR REPLACE` → `ON CONFLICT`).
- **Driver sqlite** (défaut) : better-sqlite3 par cours (ALS), cache de statements, mutex de
  transaction par connexion — comportement historique.
- **Driver postgres** (`DB_DRIVER=postgres` + `DATABASE_URL`) : postgres.js OU **PGlite**
  (`pglite://…`, Postgres WASM in-process — tests/démo sans Docker). **Multi-tenant par
  SCHÉMA** : `t_<user>_<cours>` via `search_path` — isolation STRUCTURELLE (aucun WHERE
  user_id à oublier, SQL applicatif identique aux deux dialectes ; miroir du modèle
  fichier-par-cours). Choix assumé vs colonnes user_id : isolation plus dure, zéro réécriture.
- **Recherche** : FTS5 (sqlite) · tsvector GIN 'simple' sur ombre normalisée `items.text_norm`
  (postgres) — même expansion floue du vocabulaire, divergence de ranking assumée (bm25 vs ts_rank).
- **Migration** : `scripts/migrate-to-postgres.ts` (ids préservés, séquences resynchronisées,
  sanitisation NUL/surrogates, idempotent, vérification des comptes par table).

### Auth & tenancy (Phase B4)
- **Auth.js v5 (NextAuth)**, OPT-IN par `AUTH_ENABLED=1` — sans elle, AUCUNE auth (mono-user
  « owner », historique). Magic-link e-mail (lien loggé en console si aucun endpoint d'envoi
  — dev €0) + Google OAuth optionnel. Sessions JWT ; store users/accounts/tokens séparé
  (`data/auth.db` en sqlite, schéma `public` en PG).
- **`proxy.ts`** (Next 16, ex-middleware) : garde toutes les routes, pose le header interne
  `x-cortex-user` (strippé des requêtes entrantes — anti-usurpation) → `useCourse()` installe
  le contexte AsyncLocalStorage {user, cours} → tenant DB.
- Preuves : test d'isolation 2 users sur Postgres réel (PGlite) ; login magic-link E2E via curl.

### Lancer le mode « prod-like »
```
docker compose up -d postgres            # (cortex/docker-compose.yml)
# .env.local : DB_DRIVER=postgres · DATABASE_URL=postgres://cortex:cortex@localhost:5433/cortex
#              AUTH_ENABLED=1 · AUTH_SECRET=…
npx tsx scripts/migrate-to-postgres.ts   # importe les DB SQLite locales
npm run dev
```
