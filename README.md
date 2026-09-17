# Cortex

**Un moteur qui apprend le format d'un examen à partir des annales, puis génère des sujets d'entraînement fidèles à ce format.**

La plupart des générateurs de questions produisent du QCM générique qui ne ressemble pas à l'épreuve qu'on va passer. Cortex part du problème inverse : il lit les vrais examens passés d'un cours, en extrait la structure réelle — types d'exercices, barème, pièges récurrents, mise en page — et s'en sert comme gabarit. Le résultat est un PDF qui a la tête du vrai sujet.

> Application web (Next.js 16 / TypeScript / PostgreSQL), déployée en conteneur unique sur Railway.

---

## Ce que ça fait

| | |
|---|---|
| **Ingestion** | Importer les annales, séries et supports d'un cours (PDF, HTML). Extraction du texte, indexation plein texte (FTS5) avec tolérance aux fautes de frappe. |
| **ADN d'examen** | Analyse des annales pour déduire le format réel : archétypes d'exercices, poids au barème, nombre de questions, conventions de présentation. |
| **Génération** | Production d'un examen complet en LaTeX → PDF, via un pipeline multi-passes (étude → conception du piège → rédaction → audit adverse → vérification). |
| **Vérification** | Les réponses numériques, symboliques et le code sont **vérifiés par exécution** dans un bac à sable isolé, pas seulement « relus » par un modèle. |
| **Révision** | Suivi des faiblesses, planification espacée, entraînement ciblé sur ce qui tombe le plus. |

## Ce qui est un peu moins banal sous le capot

- **Vérification déterministe** — une réponse générée n'est validée que si elle est *prouvée* : exécution de code en sandbox (`unshare`, réseau coupé, écriture hors cwd refusée, timeout), comparaison numérique à tolérance, vérification symbolique via sympy. La règle est stricte : en cas de doute, `not_applicable` — **jamais de faux « prouvé »**.
- **Isolation multi-tenant structurelle** — un schéma PostgreSQL par couple (utilisateur, cours), avec `search_path` posé au niveau de la connexion. Les données d'un autre utilisateur ne sont pas « filtrées » : elles sont invisibles.
- **Garde-fous de coût** — tous les appels au modèle passent par un point d'entrée unique qui impose un plafond de dépense global, des quotas par utilisateur et une comptabilisation du coût réel par appel.
- **Abstraction du fournisseur LLM** — API Anthropic, endpoint OpenAI-compatible, ou CLI locale, au choix d'une variable d'environnement.
- **Invariant de non-régression** — la CI vérifie qu'un cours de référence produit un prompt et un `.tex` **byte-identiques** aux empreintes canoniques après réparation de la base et ré-ingestion sur un clone neuf. Toute dérive silencieuse du moteur casse le build.

## Stack

Next.js 16 (App Router, Turbopack) · TypeScript · PostgreSQL (SQLite en développement) · Auth.js · Stripe · tectonic (LaTeX→PDF) · matplotlib (figures) · Docker · GitHub Actions

## Démarrage

```bash
cd cortex
npm install
npm run dev
```

Sans aucune variable d'environnement, l'application tourne en local sur SQLite, sans authentification. Voir `cortex/.env.example` pour tout ce qui est configurable, et `DEPLOY.md` pour le déploiement.

```bash
npm test          # tests unitaires (moteur, sandbox, vérification, facturation, drivers DB)
npm run backup    # sauvegarde base + volume
```

## Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — comment le système est construit, et pourquoi.
- **[DEPLOY.md](DEPLOY.md)** — déploiement, sauvegardes, règles de production.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — conventions, invariants et checks à passer avant toute contribution.

## Contenu de cours

Ce dépôt ne contient **aucun** support de cours, annale ou slide : ces documents appartiennent à leurs auteurs et à leur établissement. Chaque utilisateur importe ses propres documents depuis l'application ; ils restent sur son espace de stockage.

## Statut

Projet personnel en développement actif. Le moteur de génération, l'isolation multi-utilisateurs et les garde-fous de coût sont fonctionnels et testés. L'interface de paiement, l'onboarding multi-cours et la page publique sont en cours.

## Licence

Aucune licence n'est accordée pour l'instant : le code est visible à titre de démonstration, tous droits réservés.
