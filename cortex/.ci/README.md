# Budget ESLint

Depuis le dossier cortex :

```sh
node --test .ci/check-lint.test.mjs
node .ci/check-lint.mjs
```

Le budget reste défini dans lint-budget. Les diagnostics ordinaires sont admis dans ce budget ; une erreur d’exécution, un rapport invalide ou une erreur fatale bloque le contrôle. Les tests utilisent des résultats simulés, sans réseau ni dépendance ESLint réelle ; le deuxième appel vérifie le vrai projet.
