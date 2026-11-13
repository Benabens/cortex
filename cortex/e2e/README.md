# E2E Cortex

`npm run e2e` construit et démarre Cortex avec SQLite/WAL neuf en local (Postgres 16 en CI), un LLM HTTP hermétique et une auth persona locale. Il couvre onboarding/PDF/préparation/drill/correction/examen, magic-link local, quotas/propriétaire, suppression, MCP OAuth et Chrome desktop/iPhone. Stripe et Google sont sautés avec une raison si leurs secrets test manquent ; une clé `sk_live_` est toujours refusée.

Une fois : `npm_config_include=dev npm install && bash scripts/qa-setup.sh` (vrai Google sur app.cortexexam.com ; Stripe test déjà configuré), puis `set -a; source .env.e2e.local; set +a`. Lance `npm run e2e` ou `npm run e2e:google`. Pour la charge, démarre l’app avec les variables du workflow puis `npm run e2e:charge`; le rapport distingue resets du générateur et échecs applicatifs. Playwright arrête ses serveurs automatiquement.

**Smoke de la prod** (lecture seule, aucune écriture en base) : `npm run e2e:smoke` vise https://app.cortexexam.com (`E2E_SMOKE_BASE_URL` pour une autre adresse, `E2E_EXPECTED_SHA` pour exiger un commit). La workflow post-deploy le lance après chaque déploiement et rétablit le déploiement précédent s'il casse.

**Contre un serveur déjà en ligne** : `E2E_BASE_URL=https://… npx playwright test --project=desktop` ne démarre aucun serveur local (preview de PR, ou `localhost` lancé à la main) ; le magic-link est sauté, faute de capture locale des e-mails.
