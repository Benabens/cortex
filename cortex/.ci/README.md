# Budget ESLint

Depuis le dossier cortex :

```sh
node --test .ci/check-lint.test.mjs
node .ci/check-lint.mjs
```

Le budget reste défini dans lint-budget. Les diagnostics ordinaires sont admis dans ce budget ; une erreur d’exécution, un rapport invalide ou une erreur fatale bloque le contrôle. Les tests utilisent des résultats simulés, sans réseau ni dépendance ESLint réelle ; le deuxième appel vérifie le vrai projet.

# Images de base

`pull-official.sh <image:tag>` tire une image officielle Docker depuis la première source qui répond (miroir AWS, miroir Google, Docker Hub), avec trois essais par source, et la nomme comme sur Docker Hub. Les deux jobs de la CI s'en servent : `postgres:18` pour la base des tests, `node:22-slim` avant le build de l'image. Le Dockerfile ne change pas.
