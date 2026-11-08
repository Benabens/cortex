# E2E Cortex

`npm run e2e` construit et démarre Cortex avec SQLite/WAL neuf en local (Postgres 16 en CI), un LLM HTTP hermétique et une auth persona locale. Il couvre onboarding/PDF/préparation/drill/correction/examen, magic-link local, quotas/propriétaire, suppression, MCP OAuth et Chrome desktop/iPhone. Stripe et Google sont sautés avec une raison si leurs secrets test manquent ; une clé `sk_live_` est toujours refusée.

Une fois : `npm_config_include=dev npm install && bash scripts/qa-setup.sh`, puis `set -a; source .env.e2e.local; set +a`. Lance `npm run e2e` ou `npm run e2e:google`. Pour la charge, démarre l’app avec les variables du workflow puis `npm run e2e:charge`; le rapport distingue resets du générateur et échecs applicatifs. Playwright arrête ses serveurs automatiquement.
