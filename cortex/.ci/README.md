# Budget ESLint

Depuis le dossier cortex :

```sh
node --test .ci/check-lint.test.mjs
node .ci/check-lint.mjs
```

Le budget reste défini dans lint-budget. Les diagnostics ordinaires sont admis dans ce budget ; une erreur d’exécution, un rapport invalide ou une erreur fatale bloque le contrôle. Les tests utilisent des résultats simulés, sans réseau ni dépendance ESLint réelle ; le deuxième appel vérifie le vrai projet.

# Images de base

`pull-official.sh <image:tag>` tire une image officielle Docker depuis la première source qui répond (miroir AWS, miroir Google, Docker Hub), avec trois essais par source, et la nomme comme sur Docker Hub. Le job `ci` s'en sert pour le Postgres des tests. Le job `docker` ne s'en sert pas : le Dockerfile nomme sa base (miroir AWS, épinglée par son condensé, voir `DEPLOY.md` § 1) et la CI construit exactement ce que l'hébergeur construira.

`node-image-digest.sh` lit le condensé du tag `node:22-slim` sur Docker Hub et sur le miroir AWS, sans Docker, et écrit la ligne `ARG NODE_IMAGE` à recopier dans le Dockerfile quand on monte la base.
