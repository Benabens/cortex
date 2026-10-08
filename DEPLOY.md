# DEPLOY.md — Mettre Cortex en ligne (Railway), clic par clic

> Durée : ~45-60 min la première fois. Coût fixe : ~5 $/mois
> (Railway Hobby) + le coût API Anthropic (plafonné chaque mois par `SPEND_CAP_USD`).
> **Tout Stripe se fait d'abord en MODE TEST** (cartes factices) — la bascule
> live ne demande que le remplacement de 2 valeurs d'env
> ([docs/STRIPE-LIVE.md](docs/STRIPE-LIVE.md)).

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
`llm_usage`), **plafond global mensuel `SPEND_CAP_USD`** (kill-switch, e-mail
d'alerte à 80 % et à 100 %), génération
**derrière login** + **quota/jour** + **crédits payants**. Les inscriptions sont
ouvertes à tous, sauf lancement fermé (`INVITE_ONLY=1`, § 12).

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
# Plafond global du MOIS calendaire (UTC), remis à zéro le 1er.
SPEND_CAP_USD=25
DAILY_GEN_QUOTA=3
DAILY_ASSIST_QUOTA=20
RATE_LIMIT_PER_MIN=120
TRUST_PROXY=1

# — lancement FERMÉ (optionnel ; sans ces lignes, tout compte Google s'inscrit : § 12) —
# INVITE_ONLY=1
# INVITE_EMAILS=toi@exemple.com
# Ne PAS poser PUBLIC_DEMO en production : un visiteur anonyme y lirait les
# données du compte propriétaire.

# — crédits Stripe (mode TEST, étape 7) —
BILLING_ENABLED=1
SIGNUP_FREE_CREDITS=2
STRIPE_SECRET_KEY=⟨sk_test_…⟩
STRIPE_WEBHOOK_SECRET=⟨whsec_…⟩
# Prix référencés par lookup_key dans Stripe (étape 7) — rien d'autre à poser.
SUBSCRIPTION_MONTHLY_CREDITS=20

# — pages légales (OBLIGATOIRES pour vendre : sans elles, l'achat est désactivé) —
# Déclarer la vitrine lie ses quatre pages françaises (/terms, /privacy,
# /remboursement, /mentions-legales) et leur version anglaise (/terms-en).
# Un LEGAL_TERMS_URL / _PRIVACY_ / _REFUND_ / _NOTICE_URL explicite prime.
LANDING_URL=https://⟨landing⟩
# Version des CGV tracée à l'acceptation (change-la à chaque révision des CGV).
LEGAL_TERMS_VERSION=2026-10
# Adresse de contact affichée dans l'app (défaut : celle de l'éditeur).
# CONTACT_EMAIL=support@⟨ton-domaine⟩
# Adresse qui reçoit les demandes de rétractation (et les alertes de dépense,
# à défaut de CORTEX_OWNER_EMAIL).
PUBLISHER_EMAIL=⟨ton adresse⟩

# — stockage : quota par compte (Mo) sur le volume, + refus sous 10 % d'espace libre —
STORAGE_QUOTA_MB=200

# — sauvegardes quotidiennes hors site (S3-compatible : R2, B2, MinIO…) —
BACKUP_S3_ENDPOINT=https://⟨account⟩.r2.cloudflarestorage.com
BACKUP_S3_BUCKET=cortex-backups
BACKUP_S3_ACCESS_KEY_ID=⟨…⟩
BACKUP_S3_SECRET_ACCESS_KEY=⟨…⟩
# BACKUP_S3_REGION=auto        # défaut auto (R2) ; eu-central-003 (B2), etc.
# BACKUP_S3_PREFIX=cortex      # dossier racine dans le bucket
# BACKUP_KEEP_DAYS=14          # rétention ; le dernier complet est toujours gardé
# BACKUP_HOUR_UTC=3            # heure (UTC) à partir de laquelle le jour est sauvegardé

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
Pour un nom de domaine à toi : § 13.

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

Resend sert aussi, sans `AUTH_EMAIL_ENABLED`, aux e-mails que l'app envoie
d'elle-même (accusé de rétractation). Pour l'instance `cortexexam.com`, le
vrai domaine se pose en une commande guidée, où il ne reste qu'à coller des
clés :

```bash
bash scripts/resend-ben.sh            # tout le parcours, étape par étape
bash scripts/resend-ben.sh --dry-run  # essai à blanc : n'ouvre rien, ne demande aucune clé, n'écrit rien
bash scripts/resend-ben.sh --etape=4  # reprendre à la vérification du domaine
```

Elle crée (ou réutilise) le domaine chez Resend en `eu-west-1`, ajoute ses
enregistrements à la zone chez Spaceship par l'API sans toucher aux
enregistrements existants (à défaut : un par un, presse-papiers), attend la
vérification, crée une clé « Sending access » limitée au domaine, la pose sur
Railway comme `RESEND_API_KEY` avec
`AUTH_EMAIL_FROM=Cortex <noreply@cortexexam.com>`, redéploie une fois et envoie
un e-mail de test. Aucune clé n'est affichée, écrite sur disque ni passée en
argument. Banc d'essai, sans rien de réel : `bash scripts/resend-ben.test.sh`.

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
     paiement différés), **`invoice.paid`** (ouvre la période payée et remet le
     mois à 20 crédits, idempotent par facture),
     **`customer.subscription.updated`** (statut seulement : en règle, retard
     de paiement, résiliation programmée — la période qu'il annonce n'est pas
     reprise, seule une facture payée en ouvre une),
     **`customer.subscription.deleted`** (fin : crédits du mois à 0),
     **`charge.refunded`** et **`charge.dispute.created`** (reprennent les
     crédits d'un pack ou d'une facture remboursés ou contestés — ce qui a déjà
     été consommé passe en dette : solde négatif, toute génération bloquée)
   - Copie le **secret de signature** `whsec_…` dans `STRIPE_WEBHOOK_SECRET`.
   - **Version d'API** : le SDK est épinglé (`lib/billing/stripe-client.ts`,
     `STRIPE_API_VERSION`, celle que `stripe@22` type) pour les appels sortants ;
     les événements ENTRANTS arrivent au format de la version choisie à la
     création de l'endpoint (ou de la version par défaut du compte) — le
     webhook lit les deux familles (ancien format et « basil » 2025+ où
     `invoice.subscription`, `invoice.payment_intent`, `line.price` et
     `charge.invoice` n'existent plus). Une montée du SDK doit mettre à jour la
     constante ; un test le vérifie.
   - Garanties : crédit du pack et enregistrement de l'achat dans **une**
     transaction (échec → 500, Stripe rejoue, rien de crédité à moitié) ; une
     session **gratuite** (`no_payment_required`, montant 0) ne crédite jamais ;
     un remboursement dont l'achat est **inconnu** en base remonte à la session
     Checkout via l'API Stripe, puis aux métadonnées de la charge, puis au
     client/e-mail avec le montant converti en crédits (`CREDIT_PRICE_CENTS`,
     défaut 90) ; sinon il est **mémorisé** (`stripe_orphan_reversals`), journalisé
     en `error` (`stripe.reversal_unresolved`) et appliqué dès que l'achat
     arrive. Surveille ce journal : c'est le seul cas à contrôler à la main.
5. Test de paiement : carte `4242 4242 4242 4242`, n'importe quelle date
   future/CVC. Le webhook crédite le solde (idempotent — un retry Stripe ne
   crédite jamais deux fois, c'est testé).
6. **Bascule LIVE plus tard** : [docs/STRIPE-LIVE.md](docs/STRIPE-LIVE.md)
   (produits et prix exacts, webhook, portail, pied de facture, variables,
   nettoyage des données de test, test réel avec remboursement). **Aucun
   changement de code**, deux variables à remplacer. Tant que la clé est une
   clé de test et que l'instance est ouverte au public, la vente reste fermée.

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
  -- dépense globale du mois en cours, UTC (celle que compare SPEND_CAP_USD)
  SELECT round(sum(cost_usd)::numeric, 2) FROM llm_usage
  WHERE substr(created_at, 1, 7) = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
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
   - [ ] `/` en navigation privée → redirection vers `/login` ;
   - [ ] **Se connecter** avec ton compte Google → session ;
   - [ ] en lancement fermé (`INVITE_ONLY=1`) seulement : un compte NON invité
         → « accès refusé » ;
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
         de dépense global du mois atteint » → remets la vraie valeur. (Le kill-switch
         d'urgence, c'est `SPEND_CAP_USD=0`.)

## 9. Surveiller / réagir

- **Dépense** : requêtes SQL ci-dessus, à regarder les premiers jours ;
  `SPEND_CAP_USD` est le filet ultime (les hits de cache LLM restent servis
  même plafond atteint ; le reste du site marche toujours). Il porte sur le
  **mois calendaire en cours (UTC)** : atteint, il coupe la génération jusqu'au
  1er du mois suivant, ou jusqu'à ce qu'on le relève.
- **Alertes de dépense** : un e-mail part à `CORTEX_OWNER_EMAIL` (à défaut
  `PUBLISHER_EMAIL`) quand la dépense du mois franchit **80 %** du plafond,
  puis un second à **100 %** (franchis d'un coup : seul celui du plafond
  atteint part). Une seule fois par seuil et par mois, même avec plusieurs
  instances (marqueur `spend_alert:…` dans `app_meta`) ; relever le plafond en
  cours de mois réarme les deux seuils sur la nouvelle valeur.
  L'envoi passe par Resend : sans `RESEND_API_KEY` (ou sans destinataire),
  rien ne part. Le serveur l'écrit à son démarrage (`spend_alert.disabled`),
  puis à chaque seuil franchi (`spend_alert.not_sent`, au plus une fois par
  heure et par process ; la sortie des workers de jobs n'est pas conservée,
  seuls les avertissements du serveur web se lisent dans Railway). Pas
  d'alerte sans plafond (`unlimited`) ni sur le kill-switch `0`.
- **Kill-switch immédiat** : Variables → `SPEND_CAP_USD=0` → Redeploy
  (~1 min). Toute génération payante est coupée avec un message propre.
- **Métriques** : `curl -H 'Authorization: Bearer ⟨METRICS_TOKEN⟩' https://⟨domaine⟩/api/metrics` (le jeton n'est plus accepté en `?token=`)
  (Prometheus/JSON). Logs : onglet **Observability** de Railway.
- **Quota trop lâche/serré** : ajuste `DAILY_GEN_QUOTA` (et les prix Stripe).

### Suivi d'erreurs (optionnel, recommandé avant l'ouverture)

Les journaux Railway sont purgés au bout de 7 jours et le healthcheck redémarre
le conteneur sans prévenir personne : un plantage de nuit passe inaperçu. Pose
`SENTRY_DSN` (offre gratuite suffisante) et les erreurs du serveur **et des
workers** remontent, avec alerte. Sans la variable, **rien ne change** : le SDK
n'est même pas chargé.

Ce qui part : type et message d'erreur, pile, service (`web` / `worker`), URL
**sans paramètres**. Ce qui ne part **jamais** : e-mail, identifiant de compte,
en-têtes, cookies, corps de requête, prompt, énoncé — l'événement est nettoyé
avant envoi (`cortex/lib/observability.ts`, testé). Le SDK est `@sentry/node`,
pas celui de Next : aucun rapport depuis le navigateur, donc aucune session
d'étudiant instrumentée.

```env
SENTRY_DSN=https://…@oNNN.ingest.sentry.io/NNN
SENTRY_ENVIRONMENT=production
```

Complément indispensable : un **moniteur externe** (Better Stack, UptimeRobot…)
sur `/api/health` — Sentry voit les erreurs, pas un conteneur qui ne répond plus.

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
  ou `postgresql://…` (forme fournie par Railway) — avec `DB_DRIVER=postgres`,
  une sauvegarde sans dump est **refusée** (aucun manifeste)
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

### Sauvegarde quotidienne hors site (automatique)

Railway ne snapshotte **pas** les volumes et ses snapshots Postgres restent
chez Railway. Dès que les quatre variables `BACKUP_S3_ENDPOINT`,
`BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`
sont posées, **le serveur lui-même** lance chaque jour (à partir de
`BACKUP_HOUR_UTC`, défaut 3 h UTC) `npm run backup -- --push --prune --no-local` :
dump `pg_dump` + archive du volume → bucket S3-compatible (Cloudflare R2 :
10 Go gratuits, sans frais de sortie ; Backblaze B2 ; MinIO…), puis rétention
`BACKUP_KEEP_DAYS` (défaut 14 ; **le dernier dossier complet n'est jamais
supprimé**). Un marqueur en base (`app_meta.backup:daily`) garantit **une seule
exécution par jour** même avec deux instances pendant un redéploiement ; un
échec rend le marqueur et le tick suivant (30 min) réessaie. Une configuration
partielle est refusée au boot avec la liste des variables manquantes
(sauvegardes désactivées, l'app démarre). L'image embarque le client PostgreSQL
**18** (dépôt PGDG, `ARG PG_CLIENT_MAJOR=18` dans le Dockerfile) : `pg_dump`
**refuse** un serveur plus récent que lui (« server version mismatch »), donc
la version majeure du client doit être **≥ celle du Postgres managé** (Railway :
18 aujourd'hui). Si Railway passe en 19 : `--build-arg PG_CLIENT_MAJOR=19` ou
change le défaut. Le serveur le vérifie **au démarrage** et journalise un
`[backup] AVERTISSEMENT — pg_dump N est plus ancien que le serveur M` : à lire
après chaque déploiement, avant d'attendre la sauvegarde de 3 h.

Disposition distante : `<BACKUP_S3_PREFIX>/cortex-backup-<horodatage>/{data.tar.gz,
postgres.dump,manifest.json}` — `manifest.json` est envoyé **en dernier** : un
dossier sans manifeste est incomplet (envoi coupé) et sera purgé.

```bash
npm run backup -- --push                  # envoi manuel (depuis un poste avec pg_dump)
npm run backup:verify -- --list           # ce que contient le bucket
npm run backup:verify -- --latest         # rapatrie la dernière et la vérifie
```

### Vérifier une sauvegarde

```bash
npm run backup:verify -- ./backups/cortex-backup-<horodatage>
npm run backup:verify -- --latest                 # la plus récente du bucket
npm run backup:verify -- --remote=<dossier>       # une sauvegarde distante précise
```

Contrôles : empreintes SHA-256, listage de `data.tar.gz`, et `pg_restore -l`
sur `postgres.dump` (la table des matières doit se lire et contenir au moins
une table — un dump tronqué échoue **ici**, pas le jour de la restauration).
Rien n'est restauré. Code de sortie ≠ 0 = sauvegarde inutilisable.

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
- Railway est connecté à `main` avec **auto-deploy**. **« Wait for CI » doit
  être activé** (service → Settings → Source) : un déploiement attend alors la
  fin des workflows GitHub Actions du commit, et un workflow en échec le fait
  sauter. Sans ce réglage, tout push sur `main` part en production pendant que
  la CI tourne encore. À vérifier après chaque reconnexion du dépôt : un
  déploiement en attente s'affiche `WAITING` tant que la CI n'a pas fini.
- La CI (`.github/workflows/ci.yml`) joue sur chaque pull request et sur
  `main` : typecheck, build, lint, tests (avec un vrai Postgres), puis build de
  l'image, garde de démarrage, test de fumée et compilation LaTeX réelle.

---

## 12. Ouvrir les inscriptions au public

Le lancement fermé tient à une variable. Pour ouvrir :

| Variable Railway | Avant | Après |
|---|---|---|
| `INVITE_ONLY` | `1` | **supprimée** (ou `0`) |
| `INVITE_EMAILS` | la liste des invités | sans effet, peut rester |

Tout compte Google peut alors s'inscrire : il reçoit `SIGNUP_FREE_CREDITS`
crédits (2), de quoi préparer son premier cours, et il est soumis aux quotas
quotidiens (`DAILY_GEN_QUOTA`, `DAILY_ASSIST_QUOTA`).

À vérifier **avant** de retirer la variable :

- [ ] `TRUST_PROXY=1` : sans elle, la limite de requêtes est commune à tous
      les visiteurs et quelques sessions suffisent à mettre tout le monde en 429.
- [ ] `PUBLIC_DEMO` absente.
- [ ] `SPEND_CAP_USD` au-dessus de la dépense déjà faite ce mois-ci. Ce plafond
      porte sur le **mois calendaire en cours (UTC)** et repart de zéro le 1er :
      atteint, il coupe la génération pour tout le monde jusqu'au mois suivant,
      ou jusqu'à ce qu'on le relève. Dépense du mois : requête du § 7.
      (`SPEND_CAP_PER_USER_USD`, lui, est par compte et par jour.)
- [ ] `RESEND_API_KEY` posée, et `CORTEX_OWNER_EMAIL` ou `PUBLISHER_EMAIL` :
      sans elles, les alertes de dépense à 80 % et 100 % ne partent pas.
- [ ] Un plafond de dépense dur côté Anthropic.
- [ ] Console Google Cloud → écran de consentement OAuth : état **« En
      production »**. En « Test », seuls les comptes de test passent, et un
      inconnu voit « accès bloqué » chez Google, avant même d'arriver sur l'app.
- [ ] `LANDING_URL` (ou les quatre `LEGAL_*_URL`) posée : les liens légaux
      apparaissent en pied de page et sur l'écran de connexion.

**Paiements.** Avec une clé Stripe de **test**, une instance ouverte au public
ferme la vente d'elle-même (une carte de test donnerait de vrais crédits) : la
page « Abonnement & crédits » affiche « Les achats ouvrent bientôt ». Laisse
`BILLING_ENABLED=1` : c'est lui qui fait payer les générations en crédits. La
vente ouvre en collant la clé live ([docs/STRIPE-LIVE.md](docs/STRIPE-LIVE.md)).

À vérifier **après** : un compte Google jamais vu se connecte, arrive sur
l'écran de premier lancement, crée un cours, et « Mon compte » affiche un solde
de 2 crédits.

## 13. Nom de domaine

Tout ce qui dépend de l'adresse publique se lit dans `AUTH_URL` : redirections
OAuth, retours de paiement, portail Stripe, image de partage. La politique de
sécurité (CSP) et les cookies de session ne nomment aucun domaine. Changer de
domaine, c'est donc : des enregistrements DNS, une variable indispensable
(`AUTH_URL`), deux de confort (`LANDING_URL` si la vitrine déménage aussi,
`REDIRECT_FROM_HOSTS` pour renvoyer l'ancienne adresse), et trois réglages chez
des tiers.

Répartition conseillée pour `cortexexam.com` :

| Hôte | Sert | Hébergeur |
|---|---|---|
| `cortexexam.com` et `www.cortexexam.com` | la vitrine | Vercel |
| `app.cortexexam.com` | l'app | Railway |

L'app sur un sous-domaine évite la question du CNAME à la racine, que tous les
DNS n'acceptent pas. (L'app à la racine reste possible si le DNS propose un
enregistrement ALIAS ou l'aplatissement de CNAME.)

### Enregistrements DNS

Les valeurs exactes sont **affichées par chaque service** quand tu y ajoutes le
domaine : copie-les telles quelles. Dans le champ « hôte », saisis seulement la
partie avant `cortexexam.com`.

**App (Railway)** : service `cortex-app` → Settings → Networking → **+ Custom
Domain** → `app.cortexexam.com`. Railway donne **deux** enregistrements, tous
deux obligatoires (sans le TXT, le domaine répond 404) :

| Type | Hôte | Valeur |
|---|---|---|
| CNAME | `app` | celle affichée par Railway (`….up.railway.app`) |
| TXT | celui affiché par Railway | la valeur de vérification affichée par Railway |

Le certificat TLS est émis automatiquement, en général dans l'heure.

**Vitrine (Vercel)** : projet `cortex-landing` → Settings → Domains → ajouter
`cortexexam.com` et `www.cortexexam.com`. Vercel affiche :

| Type | Hôte | Valeur |
|---|---|---|
| A | `@` | l'adresse IP affichée par Vercel |
| CNAME | `www` | la cible affichée par Vercel |

**E-mail (Resend)**, seulement si l'app envoie du courrier (accusés de
rétractation, lien magique) : Resend → Domains → Add Domain. Un sous-domaine
d'envoi est conseillé, par exemple `mail.cortexexam.com` ; les hôtes ci-dessous
s'écrivent alors `send.mail`, `resend._domainkey.mail` et `_dmarc.mail`.

| Type | Hôte | Valeur | Priorité |
|---|---|---|---|
| MX | `send` | `feedback-smtp.⟨région⟩.amazonses.com` (affichée par Resend) | 10 |
| TXT | `send` | `v=spf1 include:amazonses.com ~all` | |
| TXT | `resend._domainkey` | la clé DKIM affichée par Resend (`p=…`) | |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:⟨ton adresse⟩;` | |

Une fois le domaine vérifié chez Resend : `AUTH_EMAIL_FROM=Cortex <no-reply@mail.cortexexam.com>`.
Recevoir du courrier sur `support@cortexexam.com` demande un service de
messagerie ou de redirection en plus : tant qu'il n'existe pas, garde l'adresse
de contact actuelle.

### Bascule, dans l'ordre

`bash scripts/golive-ben.sh` déroule ces étapes en guidant (pages ouvertes,
valeurs dans le presse-papiers, variables Railway posées et vérifiées). Ce
qu'il fait, et dans quel ordre :

1. **DNS** : crée les enregistrements, attends que Railway et Vercel affichent
   le domaine comme vérifié. `https://app.cortexexam.com/api/health` doit
   répondre `ok` — l'ancienne adresse marche toujours, rien n'est cassé.
2. **Google Cloud** → Identifiants → client OAuth de l'app : **ajoute** sans
   retirer l'ancien
   - Origine JavaScript autorisée : `https://app.cortexexam.com`
   - URI de redirection autorisée : `https://app.cortexexam.com/api/auth/callback/google`

   Puis écran de consentement : domaine autorisé `cortexexam.com`, page
   d'accueil `https://cortexexam.com`, confidentialité
   `https://cortexexam.com/privacy`, conditions `https://cortexexam.com/terms`.
3. **Railway**, les trois variables ensemble :

   | Variable | Valeur |
   |---|---|
   | `AUTH_URL` | `https://app.cortexexam.com` |
   | `LANDING_URL` | `https://cortexexam.com` |
   | `REDIRECT_FROM_HOSTS` | l'ancien hôte, par ex. `cortex-app-production-6a65.up.railway.app` |

   `REDIRECT_FROM_HOSTS` renvoie l'ancienne adresse vers la nouvelle. Sans
   elle, une connexion commencée sur l'ancienne adresse échoue : ses cookies
   d'état OAuth n'appartiennent pas au domaine que Google rappelle. Le
   healthcheck et le webhook Stripe ne sont jamais redirigés.
4. **Stripe** → Développeurs → Webhooks → l'endpoint → modifier l'URL :
   `https://app.cortexexam.com/api/billing/webhook` (le secret de signature ne
   change pas). Informations publiques : site `https://cortexexam.com`.
5. **Vitrine** : ses liens « ouvrir l'app » pointent sur l'ancienne adresse ;
   remplace-les par `https://app.cortexexam.com` et redéploie (dépôt
   `cortex-landing`). En attendant, l'étape 3 les redirige.
6. **Vérifier** : `https://app.cortexexam.com/login` répond 200 ; l'ancienne
   adresse renvoie vers la nouvelle ; une connexion Google aboutit ; « Gérer
   mon abonnement » et un retour de paiement reviennent sur le nouveau domaine.

Les sessions ouvertes sur l'ancienne adresse ne suivent pas : chacun se
reconnecte une fois. Garde l'ancienne URI de redirection Google et le domaine
Railway quelques semaines, puis retire-les.
