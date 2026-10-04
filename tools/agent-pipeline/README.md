# Pipeline Cortex

Le coordinateur (Codex) transmet des tâches aux chats Qwen, DeepSeek et Grok
connectés dans Chrome. AGY, via l'abonnement déjà disponible, relit le pipeline.
Les modèles proposent ; le coordinateur relit, applique les changements, teste
et publie une PR **brouillon**. Aucun modèle local, serveur permanent, clé API ou
nouvel abonnement n'est requis. Les limites gratuites des services restent
applicables : une limite rencontrée bloque le fournisseur, sans bascule payante.

Les chats web ne possèdent pas ici de droits GitHub. Le transport via Chrome est
piloté par le coordinateur pendant une session active ; ce script ne lance pas
de navigateur, ne contourne pas de CAPTCHA et ne fonctionne pas seul en arrière-plan.
Il fournit la file de tâches et les garde-fous du cycle jusqu'à la PR. Les
commandes de publication utilisent l'authentification GitHub existante de `gh`.

## Cycle

Depuis la racine du dépôt, dans une branche isolée :

```sh
node tools/agent-pipeline/cli.mjs prepare
node tools/agent-pipeline/cli.mjs status
```

`tasks.json` définit les agents, objectifs et fichiers autorisés, sans périmètres
qui se chevauchent. `prepare` conserve les prompts dans `.agent-runs/` (ignoré
par Git). Le coordinateur transmet le contexte de code public seulement : aucun
secret, support de cours ou donnée d'un compte. Pour une nouvelle mission,
adapter ce manifeste dans une nouvelle branche et conserver les preuves de
l'exécution précédente avant de déplacer son dossier `.agent-runs/`.

Après avoir récupéré chaque réponse depuis son interface, conserver son texte
dans un fichier local puis :

```sh
node tools/agent-pipeline/cli.mjs collect DS-JOB-001 /tmp/deepseek-response.md
```

Une réponse reçue reste une **proposition**. Elle n'est jamais exécutée ni
appliquée automatiquement. Relire son code, demander une correction au modèle
si nécessaire, puis appliquer uniquement les changements revus avec les outils
habituels. Importer la réponse corrigée avant d'enregistrer la revue :

```sh
node tools/agent-pipeline/cli.mjs review DS-JOB-001 "Paire cours/job vérifiée ; rappel tardif ignoré."
```

Répéter pour chaque tâche. Le texte de revue doit décrire les contrôles réellement
faits et les limites, pas ceux que le modèle affirme avoir faits. Une nouvelle
réponse invalide la revue ; une modification de code exige une nouvelle revue.
Les empreintes lient chaque revue à la réponse et aux fichiers locaux.

Committer le code relu, puis :

```sh
node tools/agent-pipeline/cli.mjs verify
```

Les tests du pipeline et du contrôle lint, le typecheck, le build, le budget lint
et la suite applicative doivent tous réussir. Une modification hors du périmètre
déclaré bloque le cycle. Les journaux et l'empreinte du commit testé sont conservés
localement. Les cas PostgreSQL/Linux ignorés en local restent à vérifier par CI.
Ajouter les résultats des essais navigateur dans les notes de revue **avant**
`verify`. Une modification après validation impose de revoir et retester.

```sh
node tools/agent-pipeline/cli.mjs publish NOM_DE_LA_BRANCHE_DE_BASE
```

La base explicite doit désigner le commit de départ des tâches. Cette commande
pousse uniquement la branche courante et crée une PR brouillon. Elle ne fusionne
et ne déploie rien. En cas de panne après création, elle retrouve une PR existante
sur la même branche, même base et même commit, uniquement si elle est toujours
brouillon. Le coordinateur attache ensuite l'URL à la conversation Codex.

Les métadonnées locales supposent un coordinateur de confiance : elles évitent
les erreurs de procédure, mais ne remplacent pas la revue GitHub ni la CI. Un
modèle qui déclare « tests passés » ne constitue jamais une preuve.

## Tests du coordinateur

```sh
node --test tools/agent-pipeline/core.test.mjs
```

Ils couvrent les réponses modifiées, revues périmées, fichiers hors tâche,
contrôles incomplets et reprise de revue. La CI les rejoue sans accès aux chats.

## Essais navigateur reproductibles

```sh
node tools/agent-pipeline/browser-check.mjs
```

Ouvrir `http://127.0.0.1:8769/`. Ce banc monte les vrais composants React avec
des cours et questions synthétiques. Les requêtes sont remplacées en mémoire et
les connexions réseau sont bloquées par CSP. Il ne sert ni fichier du dépôt ni
donnée utilisateur. Arrêter le serveur après vérification.

1. Choisir A dans le QCM, saisir une réponse ouverte avec retours à la ligne,
   corriger : l'erreur réseau simulée conserve le texte. « Rétablir la correction »
   puis corriger : texte identique, en lecture seule, corrigé affiché. « Changer
   d'examen » réinitialise la saisie. Le payload de correction reste `{answers}`.
2. « Préparer rappel tardif A », puis « Cours B » : `B:null` immédiatement.
   Livrer le rappel A ne change rien ; livrer B affiche `B:B`. Couper le job rend
   `B:null`. Le journal des rendus ne doit jamais contenir la paire B/A.
3. Ouvrir la suppression : focus dans le champ. Tester Tab/ShiftTab, Escape et
   retour au déclencheur. Saisir SUPPRIMER et confirmer appelle uniquement le mock
   en mémoire : aucun compte supprimé. Pendant l'attente, Escape ne ferme pas et
   Tab reste dans le dialogue. Terminer la simulation en erreur, puis fermer :
   focus au déclencheur.

Ce banc vérifie les composants et le cycle React, pas l'authentification réelle,
le déploiement ni un lecteur d'écran. Ses styles simplifiés ne valent pas audit
visuel de l'application complète.

### Régression : données lors d’un changement de cours

Le banc navigateur importe le vrai hook `useApi` et remplace seulement le réseau.
Dans « Données du cours », livrer A puis choisir B : le rendu B doit immédiatement
être vide et en chargement. Livrer B, recharger, choisir A, puis livrer la réponse B
en retard : aucun rendu A ne doit contenir les données B. Faire échouer A, couper
puis réactiver les données : l’erreur doit disparaître et le chargement reprendre.
Livrer A termine le chargement. L’historique visible conserve chaque état rendu,
y compris celui précédant les effets React. Aucun service ni cours réel n’est appelé.
Le rechargement explicite masque aussi les données précédentes pendant la requête.
