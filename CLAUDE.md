# Contribuer à Cortex

Conventions et invariants du dépôt. Ce fichier s'adresse autant à un humain qu'à un agent de codage — lis-le avant de modifier quoi que ce soit.

Contexte technique : [ARCHITECTURE.md](ARCHITECTURE.md). Déploiement : [DEPLOY.md](DEPLOY.md).

---

## Invariants — ne jamais casser

1. **Non-régression du moteur.** Un cours de référence doit produire un prompt et un `.tex` **byte-identiques** aux empreintes canoniques vérifiées en CI. Si un changement les fait dériver, c'est que la qualité des sujets générés a changé : **arrête-toi et explique**, ne re-baseline pas les empreintes de ta propre initiative.

2. **Jamais de faux « prouvé ».** La vérification déterministe doit répondre `not_applicable` en cas de doute plutôt que valider. Un faux positif est un bug grave — des tests existent uniquement pour ça.

3. **Aucune exécution sans isolation.** Si le bac à sable n'est pas disponible, le moteur refuse d'exécuter du code. Ne jamais ajouter de chemin d'exécution nue.

4. **Isolation multi-tenant.** Les accès aux données passent par le contexte de tenant (`db/context.ts`). Ne jamais construire une requête qui contourne le `search_path`, ni servir un fichier sans vérifier l'appartenance en base.

5. **Point d'entrée LLM unique.** Tout appel au modèle passe par `lib/llm/`. C'est là que vivent le plafond de dépense, la comptabilisation du coût et les quotas. Ne jamais appeler un fournisseur directement.

6. **Développement à coût nul.** Sans aucune variable d'environnement, l'application tourne en local sur SQLite, sans authentification et sans appel payant. Toute nouveauté doit être **activée par configuration**, jamais imposée par défaut.

7. **Aucun secret dans le dépôt.** Tout par variables d'environnement, `.env.example` tenu à jour. Aucune clé, aucun jeton, aucun identifiant réel — y compris dans les messages de commit et les fichiers de test.

8. **Aucun contenu de cours dans le dépôt.** Annales, slides et supports appartiennent à leur établissement. Ils vivent sur le volume de données, jamais dans git. `data/` est ignoré.

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
npm run lint         # lint (budget anti-régression : ne pas dépasser)
npm test             # tests unitaires
```

Les quatre doivent passer. La CI les rejoue sur un clone neuf, plus l'invariant de non-régression et un build Docker avec compilation LaTeX réelle.

## Git

- `main` est la **seule branche permanente**, et la seule qui déploie.
- Toute branche de travail est éphémère : créée depuis `main`, fusionnée par **pull request avec CI verte**, puis supprimée.
- Pas de push direct sur `main` pour du code.
- Commits en français, à l'impératif, expliquant le **pourquoi** plutôt que le quoi.

## Style

- Interface et messages utilisateur **en français**.
- Thème **sombre** — pas de fond clair, y compris sur les pages d'erreur.
- Les commentaires expliquent les décisions non évidentes et les pièges, pas la syntaxe.
- Préférer supprimer du code à en ajouter.

## Honnêteté

Si quelque chose ne marche pas, n'est pas testé, ou n'a pas pu être vérifié dans l'environnement courant : **dis-le explicitement**. Un rapport qui signale ses propres limites vaut mieux qu'un rapport qui affirme que tout est vert. Ne jamais qualifier de « vérifié » ou « prouvé » ce qui n'a pas été exécuté.
