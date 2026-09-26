# DEPLOY.md — Mettre Cortex en ligne (Railway), clic par clic

> Durée : ~45-60 min la première fois. Coût fixe : ~5 $/mois
> (Railway Hobby) + le coût API Anthropic (plafonné par `SPEND_CAP_USD`).
> **Tout Stripe se fait d'abord en MODE TEST** (cartes factices) — la bascule
> live ne demande que le remplacement de 3 valeurs d'env.

## Ce qu'on déploie

UN conteneur (Dockerfile à la racine) = l'app Next.js **et** le worker de
génération (pompe de jobs au boot + process enfants), avec tectonic (LaTeX→PDF),
python3+matplotlib (figures), sqlite3 et poppler embarqués. À côté : un
Postgres managé (les données) et un volume persistant (PDFs, uploads, annales).
Au premier démarrage, `prod-boot` initialise le volume et migre les tenants.
Aucun contenu de cours n'est embarqué : chaque utilisateur crée ses cours et
importe ses propres documents.

**Garde-fous actifs en prod** : modèle **Sonnet** par défaut
(Opus refusé sans `LLM_ALLOW_OPUS=1`), coût de chaque appel loggé (table
`llm_usage`), **plafond global `SPEND_CAP_USD`** (kill-switch), génération
**derrière login** + **quota/jour** + **crédits payants**, invite-only.

---

## 0. Prérequis (comptes à créer, tous gratuits au départ)

| Compte | Sert à | URL |
|---|---|---|
| Railway | héberger le conteneur + Postgres + volume | railway.com |
| Anthropic Console | la clé API LLM (payante à l'usage) | console.anthropic.com |
| Resend | envoyer les magic-links de connexion | resend.com |
| Stripe | vendre les packs de crédits (mode test) | stripe.com |

---

## 1. Railway — le service

1. railway.com → **Login with GitHub**.
2. **New Project** → **Deploy from GitHub repo** → autorise Railway sur le
   dépôt → branche `main`.
3. Railway lit `railway.json` à la racine → builder **DOCKERFILE**,
   healthcheck `/api/health`, **1 replica** (⚠ ne JAMAIS augmenter : la file
   de jobs est mono-conteneur par design — PID + heartbeat locaux).
4. Settings du service → **Region** : la plus proche de tes utilisateurs.
5. Le premier build part tout seul (~5-8 min : image + warm-up tectonic).
   ⚠ **Ne laisse pas le service tourner sans les variables de l'étape 4** : il
   démarre très bien, mais SANS auth, SANS quota et SANS plafond de dépense —
   c'est-à-dire ouvert à tous. Enchaîne directement sur les étapes 2-4 avant de
   partager l'URL.

## 2. Railway — Postgres

1. Dans le projet : **+ New** → **Database** → **Add PostgreSQL**.
2. Rien d'autre à faire : on référencera son URL par variable (étape 4).

## 3. Railway — volume persistant

1. Clique le service **cortex-app** → **Settings** → **Volumes** →
   **Add Volume** → Mount path : **`/data`** → taille 5 GB (extensible).
2. C'est là que vivront PDFs générés, uploads, annales ajoutées — ils
   survivent aux redéploiements (le code le prouve : marqueur
   `.cortex-volume-initialise` + copie non-destructive au 1er boot).

## 4. Railway — variables d'environnement

Service **cortex-app** → **Variables** → **Raw Editor** → colle ce bloc, puis
remplace chaque `⟨…⟩` :

```env
# — base —
DB_DRIVER=postgres
DATABASE_URL=${{Postgres.DATABASE_URL}}
CORTEX_DATA_DIR=/data

# — moteur LLM (PAYANT → éco par défaut) —
LLM_PROVIDER=anthropic
LLM_API_KEY=⟨sk-ant-… (étape 5)⟩
LLM_MAX_CONCURRENCY=2

# — auth (génération DERRIÈRE login) —
AUTH_ENABLED=1
AUTH_SECRET=⟨sortie de : openssl rand -base64 32⟩
AUTH_URL=https://⟨ton-domaine-railway⟩
GOOGLE_CLIENT_ID=⟨… (console Google Cloud)⟩
GOOGLE_CLIENT_SECRET=⟨…⟩
# Lien magique par e-mail : OPTIONNEL, désactivé par défaut (étape 6 si voulu)
# AUTH_EMAIL_ENABLED=1
# RESEND_API_KEY=⟨re_… (étape 6)⟩
# AUTH_EMAIL_FROM=Cortex <onboarding@resend.dev>

# — garde-fous de coût (OBLIGATOIRES) —
SPEND_CAP_USD=25
DAILY_GEN_QUOTA=3
DAILY_ASSIST_QUOTA=20
RATE_LIMIT_PER_MIN=120
TRUST_PROXY=1

# — lancement fermé + vitrine publique —
INVITE_ONLY=1
INVITE_EMAILS=toi@exemple.com
PUBLIC_DEMO=1

# — crédits Stripe (mode TEST, étape 7) —
BILLING_ENABLED=1
SIGNUP_FREE_CREDITS=2
STRIPE_SECRET_KEY=⟨sk_test_…⟩
STRIPE_WEBHOOK_SECRET=⟨whsec_…⟩
# Prix référencés par lookup_key dans Stripe (étape 7) — rien d'autre à poser.
SUBSCRIPTION_MONTHLY_CREDITS=20

# — pages légales (OBLIGATOIRES pour vendre : sans les 4, l'achat est désactivé) —
LEGAL_TERMS_URL=https://⟨landing⟩/cgv
LEGAL_PRIVACY_URL=https://⟨landing⟩/confidentialite
LEGAL_REFUND_URL=https://⟨landing⟩/remboursement
LEGAL_NOTICE_URL=https://⟨landing⟩/mentions-legales
# Version des CGV tracée à l'acceptation (change-la à chaque révision des CGV).
LEGAL_TERMS_VERSION=2026-09

# — stockage : quota par compte (Mo) sur le volume, + refus sous 10 % d'espace libre —
STORAGE_QUOTA_MB=200

# — observabilité —
METRICS_TOKEN=⟨openssl rand -hex 16⟩
LOG_LEVEL=info
```

> Variables **implicites** : Railway pose `RAILWAY_ENVIRONMENT`/`RAILWAY_PROJECT_ID`,
> ce qui active la garde « hébergé ⇒ `AUTH_ENABLED=1` obligatoire » au boot
> (`CORTEX_HOSTED=1` force la même garde ailleurs). `PG_AUTH_POOL_MAX` (défaut 4)
> = connexions dédiées aux réservations de crédits ; monte-le si tu passes à
> plusieurs replicas ou si `MAX_ACTIVE_JOBS` grandit.

Le domaine : Settings → **Networking** → **Generate Domain** (type
`cortex-app-production.up.railway.app`) → reporte-le dans `AUTH_URL`.
(Domaine custom plus tard : même écran, ajoute un CNAME.)

## 5. Anthropic — la clé API

1. console.anthropic.com → **API Keys** → **Create Key** → copie `sk-ant-…`
   dans `LLM_API_KEY`.
2. **Billing** : mets un budget/alerte côté Anthropic aussi (ceinture ET
   bretelles — le kill-switch `SPEND_CAP_USD` est côté app).
3. Modèles utilisés : **Sonnet par défaut** (l'alias interne « opus » est
   résolu vers Sonnet tant que `LLM_ALLOW_OPUS≠1`) ; Haiku pour ce qui le
   demande. N'active `LLM_ALLOW_OPUS=1` qu'en connaissance de cause (~2×
   l'entrée, ~1,7× la sortie de Sonnet).

## 6. Resend — l'e-mail de connexion (optionnel)

Le lien magique est **désactivé par défaut** (Google seul) : c'est une seconde
voie d'inscription et n'importe qui peut déclencher des envois. Pour l'activer,
pose `AUTH_EMAIL_ENABLED=1` puis :

1. resend.com → **API Keys** → **Create** → copie `re_…` dans
   `RESEND_API_KEY`.
2. Pour démarrer, `AUTH_EMAIL_FROM=Cortex <onboarding@resend.dev>` marche tel
   quel (domaine de test Resend). Pour un vrai domaine : **Domains** → Add →
   pose les 2-3 enregistrements DNS affichés → puis
   `AUTH_EMAIL_FROM=Cortex <cortex@ton-domaine.ch>`.

## 7. Stripe — packs de crédits (MODE TEST)

1. stripe.com → crée le compte → reste en **mode Test** (interrupteur en haut
   à droite).
2. **Développeurs → Clés API** → copie la **clé secrète** `sk_test_…` dans
   `STRIPE_SECRET_KEY`.
3. **Catalogue de produits → + Ajouter un produit**, 3 prix avec leur
   **lookup_key** (Prix → « Clé de recherche ») — c'est la clé, pas l'id, que
   l'app référence :
   | Produit / prix | Suggestion | lookup_key |
   |---|---|---|
   | Cortex Pro — mensuel (récurrent) | 14,90 €/mois | `cortex_pro_monthly` |
   | Cortex Pro — annuel (récurrent) | 119 €/an | `cortex_pro_yearly` |
   | Pack de 10 crédits (paiement unique) | 9 € | `cortex_credits_10` |
   Pro = 20 crédits par mois, non reportables (`SUBSCRIPTION_MONTHLY_CREDITS`),
   consommés avant les crédits achetés ; le pack est permanent. Active aussi le
   **portail client** (Paramètres → Facturation → Portail client) pour la
   résiliation en fin de période.
4. **Développeurs → Webhooks → Ajouter une destination** :
   - URL : `https://⟨ton-domaine⟩/api/billing/webhook`
   - Événements : **`checkout.session.completed`**,
     **`checkout.session.async_payment_succeeded`** (confirme les moyens de
     paiement différés), **`invoice.paid`** (attribue les 20 crédits du mois,
     idempotent par facture), **`customer.subscription.updated`**,
     **`customer.subscription.deleted`** (fin : crédits du mois à 0),
     **`charge.refunded`** et **`charge.dispute.created`** (reprennent les
     crédits d'un pack ou d'une facture remboursés ou contestés — ce qui a déjà
     été consommé passe en dette : solde négatif, toute génération bloquée)
   - Copie le **secret de signature** `whsec_…` dans `STRIPE_WEBHOOK_SECRET`.
5. Test de paiement : carte `4242 4242 4242 4242`, n'importe quelle date
   future/CVC. Le webhook crédite le solde (idempotent — un retry Stripe ne
   crédite jamais deux fois, c'est testé).
6. **Bascule LIVE plus tard** : interrupteur Live → recrée les 3 produits et
   le webhook en mode live → remplace `sk_test_→sk_live_`, les 3 `price_…` et
   le `whsec_…`. **Aucun changement de code.**

### Tarification — le prix d'un crédit doit couvrir le coût API

- Coûts par génération (crédits) : **examen = 2**, préparation de cours = 2,
  QCM/exercice/labs/format = 1, **assistance = 0,1** (drill, correction,
  analyses — débitée avant chaque appel, jamais remboursée). Le prix suit la
  taille : mock QCM standard (20 + 3 ouvertes) = 1 unité, +1 par tranche ;
  examen : 8 exercices inclus puis +1 crédit par 4. (Surcharge :
  `CREDITS_COST_JSON`, décimales acceptées.)
- **Mesure avant de fixer les prix** : `npm run cost:report` (dans le
  conteneur ou avec `DATABASE_URL`) sort le coût réel moyen/max par type de
  job et par appel d'assistance depuis `llm_usage`, face au prix en crédits
  (`CREDIT_PRICE_CHF`, `CHF_PER_USD`).
- Garde-fous : une génération n'existe qu'après une **réservation atomique**
  (solde, quota du jour, rafale, `MAX_ACTIVE_JOBS` = 2 générations
  simultanées par compte) ; un job échoué n'est remboursé que s'il n'a rien
  coûté au fournisseur ; un achat remboursé ou contesté est repris (solde
  négatif → tout est bloqué).
- Estimation Sonnet (tarifs 07/2026 : 3 $/MTok entrée, 15 $/MTok sortie) : un
  examen complet multi-passes ≈ 200-400k tokens entrée + 60-120k sortie ≈
  **1,2 à 3,0 $** → un examen (2 crédits) vendu 6 CHF au pack le plus petit
  couvre large ; le gros pack (25 CHF / 12 crédits ≈ 2,08 CHF/crédit) reste
  au-dessus du coût moyen attendu (~0,6-1,5 $/crédit). Marge ~×1,5-3.
- **Recalibre avec le RÉEL** après quelques générations (dans Railway :
  Postgres → **Data** → Query) :
  ```sql
  -- coût moyen par type de génération (7 derniers jours)
  SELECT model, count(*) appels, round(sum(cost_usd)::numeric, 2) total_usd
  FROM llm_usage WHERE created_at > to_char(now() - interval '7 days', 'YYYY-MM-DD')
  GROUP BY model ORDER BY total_usd DESC;
  -- dépense globale (celle que compare SPEND_CAP_USD)
  SELECT round(sum(cost_usd)::numeric, 2) FROM llm_usage;
  -- dépense par user
  SELECT user_id, round(sum(cost_usd)::numeric, 2) usd FROM llm_usage GROUP BY user_id ORDER BY usd DESC;
  ```
  Si le coût moyen d'un examen dépasse ~2 $ : monte les prix des packs ou le
  coût en crédits (`CREDITS_COST_JSON={"exam":3}`) — jamais d'illimité.

## 8. Déployer et vérifier

1. **Deployments → Redeploy** (pour prendre les variables). Suis les logs :
   `[prod-boot] volume initialisé` → `migrations` → `next start` (2-3 min la
   première fois).
2. Checklist post-déploiement, depuis l'URL publique :
   - [ ] `/api/health` → `{"status":"ok"…}` — et regarde `checks.sandbox` :
         s'il est `false`, les figures matplotlib et la vérification de code
         seront désactivées (les examens restent produits, sans figures
         générées) ;
   - [ ] `/` en navigation privée → la vitrine s'affiche (PUBLIC_DEMO) ;
   - [ ] **Se connecter** avec TON e-mail (invité) → magic-link reçu → session ;
   - [ ] un e-mail NON invité → « accès refusé » (invite-only) ;
   - [ ] premier lancement → écran vide → **créer un cours** → importer une
         annale → la préparation s'exécute ;
   - [ ] Examens → **Générer** → le job tourne (10-20 min) → PDF
         téléchargeable ; recharge la page → le PDF est toujours là ;
   - [ ] `/api/billing` → solde 2 (palier gratuit), coût débité après la
         génération ;
   - [ ] achat d'un pack avec la carte `4242…` → solde crédité ;
   - [ ] requête SQL `llm_usage` → l'appel de la génération est loggé avec son
         coût ;
   - [ ] pose `SPEND_CAP_USD=0.01` → Redeploy → générer → refus 503 « Plafond
         de dépense atteint » → remets la vraie valeur. (Le kill-switch
         d'urgence, c'est `SPEND_CAP_USD=0`.)

## 9. Surveiller / réagir

- **Dépense** : requêtes SQL ci-dessus, à regarder les premiers jours ;
  `SPEND_CAP_USD` est le filet ultime (les hits de cache LLM restent servis
  même plafond atteint ; le reste du site marche toujours).
- **Kill-switch immédiat** : Variables → `SPEND_CAP_USD=0` → Redeploy
  (~1 min). Toute génération payante est coupée avec un message propre.
- **Métriques** : `curl -H 'Authorization: Bearer ⟨METRICS_TOKEN⟩' https://⟨domaine⟩/api/metrics` (le jeton n'est plus accepté en `?token=`)
  (Prometheus/JSON). Logs : onglet **Observability** de Railway.
- **Quota trop lâche/serré** : ajuste `DAILY_GEN_QUOTA` (et les prix Stripe).

## 10. Sauvegardes et restauration

Deux choses à sauvegarder, **indépendantes** : la **base** (comptes, crédits
**déjà payés**, faiblesses, planning, examens, banque de questions) et le
**volume** `CORTEX_DATA_DIR` (PDF d'annales, uploads, bases SQLite en dev).
Perdre l'un ou l'autre = perte irréversible.

### Lancer une sauvegarde

```bash
cd cortex
npm run backup                       # → ./backups/cortex-backup-<horodatage>/
BACKUP_DIR=/mnt/backups npm run backup
npm run backup -- --label=avant-migration
```

Chaque exécution crée un dossier horodaté distinct (jamais d'écrasement)
contenant :
- `data.tar.gz` — archive complète du volume `CORTEX_DATA_DIR` (WAL SQLite
  **inclus** : on capture l'état exact, contrairement à git) ;
- `postgres.dump` — dump `pg_dump -Fc` de **tous** les schémas tenant
  (`t_<user>_<cours>`) + `public`, **uniquement** si `DATABASE_URL=postgres://…`
  (nécessite `pg_dump` sur l'hôte — présent sur une image avec `libpq`) ;
- `manifest.json` — horodatage, driver, empreintes SHA-256, versions d'outils.
  **Aucun secret** n'y figure (jamais `DATABASE_URL`).

En dev (SQLite, aucune `DATABASE_URL`), la base vit **dans** le volume : elle
est déjà capturée par `data.tar.gz`.

### Restaurer

```bash
npm run restore -- ./backups/cortex-backup-<horodatage> --yes
npm run restore -- <dossier> --yes --force   # écrase une cible NON vide
```

Garde-fous (opération destructrice) : refus **sans `--yes`** ; refus si le
volume **ou** la base Postgres cible n'est **pas vide** (sauf `--force`) ;
vérification des empreintes SHA-256 avant toute écriture. La restauration
Postgres utilise `pg_restore --clean --if-exists`.

> **Preuve** : le cycle dump → wipe → restore est vérifié automatiquement par
> `tests/backup-restore.test.ts` (round-trip des fichiers **et** d'un jeu de
> données d'un vrai moteur Postgres via PGlite, + les garde-fous). Le chemin
> `pg_dump`/`pg_restore` réseau (Postgres managé) n'est pas exerçable hors d'un
> hôte doté de `libpq` — à valider une fois sur Railway (voir ci-dessous).

### Où et à quelle fréquence

- **Automatique** : la sauvegarde quotidienne ci-dessus, dès qu'il y a des
  paiements. Active en plus les **snapshots** du service Postgres dans Railway
  (bretelles).
- **Manuel** : avant chaque migration de schéma et avant tout `restore --force`
  (`npm run backup -- --push --label=avant-migration`).
- **Tester une restauration** de temps en temps sur une base jetable
  (`npm run backup:verify -- --latest` chaque semaine ne remplace pas un vrai
  `restore`) — une sauvegarde jamais restaurée n'est pas une sauvegarde.
- `tests/backup-s3.test.ts` prouve envoi/rétention/planification sur un faux
  magasin S3 et, avec `CORTEX_TEST_PG_URL` + `pg_dump`, le cycle réel
  `pg_dump` → `pg_restore -l`.

## Limites connues

- **`AUTH_ENABLED=1` exige `DB_DRIVER=postgres`** : en SQLite il n'y a qu'une
  base par cours, donc aucune isolation entre comptes. Le démarrage refuse
  désormais cette combinaison — c'est voulu.
- **Solde légèrement négatif possible** sous rafale : le contrôle du solde et
  le débit ne sont pas dans la même transaction. Plusieurs générations lancées
  à la même seconde peuvent toutes passer. Le plafond `SPEND_CAP_USD` reste le
  filet ; à durcir (verrou par utilisateur) si l'usage le justifie.
- **Coût forfaitaire par type** : un QCM de 40 questions coûte le même crédit
  qu'un QCM de 4. Si tu ouvres largement, plafonne les tailles demandées ou
  indexe le coût sur le volume.
- **Annulation** : les crédits ne sont rendus que si la génération n'avait pas
  réellement démarré (au-delà, le fournisseur a déjà été payé). Un échec, lui,
  est toujours remboursé.

- **1 replica obligatoire** (file de jobs PID-based mono-conteneur).
- **Bibliothèque d'annales partagée par cours** : les PDF déposés dans
  Sources (`data/<cours>/refs/`) sont visibles par tous les utilisateurs de ce
  cours — c'est voulu (le matériel d'un cours est commun), mais ne dépose pas
  là un document que tu ne veux pas partager. Les examens générés et les
  screenshots, eux, sont isolés par utilisateur (`data/u/<user>/…`).
- **Isolation (décision)** : le runtime Railway refuse `unshare`, donc aucun
  bac à sable noyau n'est disponible → **toute exécution de code est
  désactivée** en production (vérification de programmes, sympy, figures
  matplotlib) et ces voies répondent `not_applicable` ; les items à figures
  sont écartés proprement (jamais de PDF cassé). `/api/health` l'affiche
  (`checks.sandbox: false`, `verification.mode: "disabled"`). Rouvrir
  l'exécution demande un exécuteur séparé (conteneur dédié, gVisor, e2b).
- Génération d'un examen complet : **10-20 min** (multi-passes + vérification)
  — c'est le prix de la qualité ; l'UI suit le job en direct.
- Magic-link (`AUTH_EMAIL_ENABLED=1`) sans `RESEND_API_KEY` : en production la
  demande de lien **échoue** plutôt que d'écrire un jeton de session dans les
  logs ; hors production le lien est loggé en console (dev).
- Le conteneur **refuse de démarrer** si `AUTH_ENABLED≠1` alors que
  `NODE_ENV=production` (posé par l'image) ou `BILLING_ENABLED=1` : impossible
  d'ouvrir une instance où chaque visiteur serait « owner ».

## Dev local : rien ne change

Sans variable posée, l'app tourne en mode développement : SQLite dans `data/`,
moteur = CLI `claude` locale (`claude -p`), sans authentification —
`cd cortex && npm install && npm run dev`.

---

## 11. Workflow Git et production

- `main` est la seule branche permanente, et la seule qui déploie.
- Les branches de travail partent de `main`, sont fusionnées par pull request
  avec CI verte, puis supprimées.
- Railway est connecté à `main` avec **auto-deploy** et **« Wait for CI »** : un
  commit n'est déployé que si la CI GitHub est verte.
