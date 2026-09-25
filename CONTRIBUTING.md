# Contribuer à Cortex

Conventions et invariants du dépôt, à lire avant toute modification.

Contexte technique : [ARCHITECTURE.md](ARCHITECTURE.md). Déploiement : [DEPLOY.md](DEPLOY.md).

---

## Invariants

1. **Non-régression du moteur.** Un cours de référence doit produire un prompt et un `.tex` **byte-identiques** aux empreintes canoniques. Si un changement les fait dériver, la qualité des sujets générés a changé : la dérive doit être comprise et justifiée avant de mettre à jour les empreintes.

2. **Jamais de faux « prouvé ».** La vérification déterministe répond `not_applicable` en cas de doute plutôt que de valider. Un faux positif est un bug grave — plusieurs tests existent uniquement pour l'empêcher.

3. **Aucune exécution sans isolation.** Si le bac à sable n'est pas disponible, le moteur refuse d'exécuter du code. Il n'existe pas de chemin d'exécution nue.

4. **Isolation multi-tenant.** Les accès aux données passent par le contexte de tenant (`db/context.ts`). Aucune requête ne contourne le `search_path`, aucun fichier n'est servi sans vérification d'appartenance en base.

5. **Point d'entrée LLM unique.** Tout appel au modèle passe par `lib/llm/` : c'est là que vivent le plafond de dépense, la comptabilisation du coût et les quotas.

6. **Développement sans service externe.** Sans aucune variable d'environnement, l'application tourne en local sur SQLite, sans authentification ni appel payant. Toute fonctionnalité est **activée par configuration**, jamais imposée par défaut.

7. **Aucun secret dans le dépôt.** Tout passe par des variables d'environnement ; `.env.example` est tenu à jour.

8. **Aucun contenu de cours dans le dépôt.** Annales, slides et supports appartiennent à leur établissement. Ils vivent sur le volume de données, jamais dans git.

## Organisation

```
cortex/
  app/           pages (App Router) et routes API
  components/    composants React
  lib/           le moteur : génération, vérification, LLM, facturation, auth
  db/            drivers SQLite/PostgreSQL, contexte de tenant, migrations
  scripts/       ingestion, jobs, sauvegarde, maintenance
  tests/         tests unitaires (node:test)
  latex/         préambule et macros de rendu
```

## Avant de proposer un changement

```bash
cd cortex
npx tsc --noEmit     # typecheck
npm run build        # build Next
npm run lint         # lint (budget anti-régression : ne pas le dépasser)
npm test             # tests unitaires
```

Les quatre doivent passer. La CI les rejoue sur un clone neuf, avec en plus l'invariant de non-régression et un build Docker qui compile réellement du LaTeX.

## Git

- `main` est la seule branche permanente, et la seule qui déploie.
- Les branches de travail partent de `main`, sont fusionnées par pull request avec CI verte, puis supprimées.
- Messages de commit en français, à l'impératif, qui expliquent le **pourquoi** plutôt que le quoi.

## Pull requests

Décrire ce qui a été testé, et ce qui ne l'a pas été. Un changement qui n'a pas pu être vérifié dans un environnement donné (Postgres managé, sandbox indisponible…) le dit explicitement.

## Style

- Interface et messages utilisateur en français.
- Thème sombre partout, y compris sur les pages d'erreur.
- Les commentaires expliquent les décisions non évidentes et les pièges, pas la syntaxe.
