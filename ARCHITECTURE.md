# Architecture

Comment Cortex est construit, et les raisons derrière les choix qui ne sont pas évidents.

---

## Vue d'ensemble

```
┌─────────────────────────────────────────────────────────────┐
│  UN conteneur = app Next.js + worker de jobs                │
│                                                              │
│   Next.js (App Router)                                       │
│     ├── pages : accueil, programme, faiblesses, examens,     │
│     │           entraînement, sources, recherche             │
│     └── routes API (/api/*)                                  │
│                                                              │
│   instrumentation.ts  ──►  pompe la file de jobs au boot     │
│     └── chaque job = process enfant `tsx scripts/run-job.ts` │
│                                                              │
│   lib/  = le moteur (génération, vérification, facturation)  │
└─────────────────────────────────────────────────────────────┘
        │                    │                     │
   PostgreSQL          Volume persistant      Fournisseur LLM
   (1 schéma par        (PDF générés,          (Anthropic / OpenAI-
    user × cours)        imports)               compatible / CLI)
```

Le worker **n'est pas** un service séparé. `instrumentation.ts` démarre avec `next start`, réconcilie les jobs interrompus et consomme la file ; chaque génération est un process enfant. Conséquence assumée : **un seul replica**. La file est locale au conteneur (PID + heartbeat) — scaler horizontalement la casserait.

---

## Le pipeline de génération

Générer un examen crédible demande plus qu'un appel à un modèle. Le chemin :

1. **Ingestion** (`scripts/ingest.ts`) — parse les documents importés, découpe en items, construit l'index plein texte et un vocabulaire pour la tolérance aux fautes.
2. **ADN d'examen** (`lib/exam-dna.ts`) — déduit des annales le format réel du cours : moules d'exercices, genres de figures, répartition du barème. Rien n'est codé en dur par matière.
3. **Profil de cours** (`lib/course-profile.ts`) — assemble les directives de génération. Un profil curaté peut exister pour un cours donné (`lib/profiles/`) ; sinon `lib/profiles/generic.ts` dérive tout de l'ADN. **Le chemin générique est le chemin par défaut**, pas un repli dégradé.
4. **Composition** (`lib/blueprint.ts`, `lib/composer.ts`) — choisit les exercices, leur poids, leur difficulté.
5. **Rédaction multi-passes** (`lib/architect.ts`) — étude du corpus → conception du piège → rédaction → audit adverse → vérification. Chaque passe a un rôle distinct ; c'est ce qui sépare un sujet crédible d'un QCM générique.
6. **Vérification** (`lib/verify-*.ts`) — voir ci-dessous.
7. **Rendu** (`lib/exam-latex.ts` + `latex/`) — LaTeX → PDF via tectonic, figures via matplotlib ou TikZ.

## Vérification déterministe

Le principe : **une réponse n'est validée que si elle est prouvée**.

- **Code** — compilé et exécuté dans un bac à sable : espace de noms isolé (`unshare`), réseau coupé, écriture hors du répertoire de travail refusée, timeout. Sans isolation disponible, le moteur **refuse d'exécuter** plutôt que d'exécuter à nu.
- **Numérique** — comparaison à tolérance relative ; c'est le *dernier* nombre de la réponse qui fait foi (évite les faux positifs sur les calculs intermédiaires).
- **Symbolique** — sympy, en sandbox.
- **Figures** — la valeur lue doit correspondre à une vérité unique ; 0 ou plusieurs vérités ⇒ non concluant.

En cas d'ambiguïté, le verdict est `not_applicable`. **Un faux « prouvé » est considéré comme un bug grave** — plusieurs tests existent uniquement pour l'empêcher.

## Données et isolation

`db/context.ts` calcule un nom de schéma `t_<utilisateur>_<cours>` (préfixe normalisé + hash tronqué, pour qu'aucune troncature ne fasse collisionner deux comptes). Le driver PostgreSQL pose `search_path` **au niveau de la connexion** : les tables des autres tenants ne sont pas accessibles, même via une requête oubliant un filtre. Les identifiants sont assainis avant interpolation.

Les fichiers suivent la même logique (`data/u/<user>/<cours>/…`), et le téléchargement d'un examen vérifie l'appartenance **en base**, pas seulement le chemin — sinon l'énumération d'identifiants suffirait.

En développement, sans configuration, tout tourne sur SQLite en mono-utilisateur. Un garde-fou interdit explicitement d'activer l'authentification sur SQLite.

## Coût et facturation

Tous les appels au modèle passent par `lib/llm/index.ts` — **point d'entrée unique**, sans chemin de contournement. Il impose :

- un **plafond de dépense global** (`SPEND_CAP_USD`) qui coupe les appels payants quand il est atteint ;
- l'**enregistrement du coût réel** de chaque appel (`llm_usage`) ;
- des **quotas quotidiens** par utilisateur, appliqués en amont des générations.

La facturation est un modèle de **crédits prépayés** : solde = somme des deltas dans `credit_transactions`, idempotence garantie par contrainte d'unicité. Les webhooks de paiement sont vérifiés par signature et idempotents par identifiant d'événement ; les remboursements re-créditent exactement ce qui avait été débité, pas le tarif courant.

## Tests et CI

Les tests couvrent le moteur (moules, ADN, vérification déterministe, sandbox), la couche LLM (limiteur, retries, cache, fournisseurs), les drivers de base, l'isolation multi-tenant et la facturation — y compris des cas adverses : rejeu de webhook, signature falsifiée, collision d'identifiants entre tenants.

La CI ajoute deux garanties que le poste de développement ne peut pas donner :

1. **Invariant de non-régression** — un cours de référence doit produire un prompt et un `.tex` byte-identiques aux empreintes canoniques, après réparation de la base et ré-ingestion sur un clone neuf.
2. **Build de l'image + test de fumée réel** — l'image complète est construite, l'application démarrée, `/api/health` interrogé, et **une compilation LaTeX réellement exécutée** dans le conteneur.

## Choix structurants

| Choix | Raison |
|---|---|
| Un seul conteneur app + worker | Une génération dure des minutes : incompatible avec des fonctions serverless à timeout court. |
| Sources TypeScript embarquées (pas de build `standalone`) | Les jobs sont des process enfants `tsx` ; ils ont besoin des sources. |
| Un schéma par tenant plutôt qu'une colonne `user_id` | L'isolation devient structurelle et ne dépend pas de la rigueur de chaque requête. |
| Vérification par exécution plutôt que par relecture | Un modèle qui relit sa propre réponse valide ses propres erreurs. |
| Invariant byte-identique en CI | Le seul moyen de détecter qu'un « petit refactor » a silencieusement changé la qualité des sujets générés. |
