# Config Railway en code

`railway.ts` décrit le projet Railway de Cortex (Infrastructure as Code). Il
n'est lu que par la CLI, jamais pendant un déploiement. Mode d'emploi, règle
des variables et risques : `DEPLOY.md`, § 1 bis.

```bash
npm ci                    # ici, dans .railway/ : SDK railway épinglé
railway config plan       # aperçu sans effet
railway config apply      # applique, après lecture du plan (aucune ligne « Delete »)
```
