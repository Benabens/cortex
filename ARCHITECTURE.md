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
