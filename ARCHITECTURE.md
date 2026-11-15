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
   PostgreSQL       Volume ou seau S3      Fournisseur LLM
   (1 schéma par     (PDF générés, imports  (Anthropic / OpenAI-
    user × cours)     via lib/storage)       compatible / CLI)
```

Le worker **n'est pas** un service séparé. `instrumentation.ts` démarre avec `next start`, réconcilie les jobs interrompus et consomme la file ; chaque génération est un process enfant. Conséquence assumée : **un seul replica**. La file est locale au conteneur (PID + heartbeat) — scaler horizontalement la casserait.

---

## Le pipeline de génération

Générer un examen crédible demande plus qu'un appel à un modèle. Le chemin :

1. **Ingestion** (`scripts/ingest.ts`) — parse les documents importés, découpe en items, construit l'index plein texte et un vocabulaire pour la tolérance aux fautes.
2. **ADN d'examen** (`lib/exam-dna.ts`) — déduit des annales le format réel du cours : moules d'exercices, genres de figures, répartition du barème. Rien n'est codé en dur par matière.
   **Format d'examen** (`lib/exam-format.ts`) — ce qu'on sait de la forme de l'épreuve et d'où on le sait : annales (format détecté) > format **déclaré** par l'étudiant (fiche du cours, `set_exam_format`) > questions d'exemple officielles > consignes d'examen ou indices du corpus (preuves citées, vérifiées mot pour mot, `lib/format.ts`) > **inconnu**. Un format inconnu n'est jamais inventé : la génération est refusée avec ce qu'il faut déclarer. Ce format n'est qu'un **défaut** : un type demandé pour UN examen (« QCM seulement », questions composées…) l'emporte, annales comprises. La langue de l'examen est celle du cours, sauf annales écrites dans une autre langue. Un QCM a un **mode de réponse** (unique, multiple ou mixte) : celui des annales (types de QCM comptés), sinon le mode déclaré, sinon celui que disent les sources, sinon la réponse unique ; le générateur le suit strictement.
   **Aiguillage unique** (`planMockExam`, `lib/mock-exam.ts`) — tout examen blanc (app, connecteur, programme) passe par lui : QCM et mixte → architecte QCM (`lib/qcm.ts` : distracteurs typés, faits précis du cours, juge du pouvoir discriminant, régénération des items faibles ; le correcteur voit les passages où se trouve le fait testé, et une question qu'il juge hors cours n'est rejetée qu'après une recherche dans tout le cours, `lib/qcm-evidence.ts`) ; questions composées (un scénario ou un extrait de code suivi de sous-questions mêlant choix unique, lecture de code et réponse courte — annale modèle avec QCM, ou format déclaré) → générateur de blocs (`lib/blocks.ts` : une question par section, sortie du code fixée par son exécution, juge à l'aveugle, barème des réponses courtes figé à la génération) ; exercices, essai, oral → générateur d'exercices. Le focus n'est qu'un accent thématique.
3. **Profil de cours** (`lib/course-profile.ts`) — assemble les directives de génération. Un profil curaté peut exister pour un cours donné (`lib/profiles/`) ; sinon `lib/profiles/generic.ts` dérive tout de l'ADN et du format : langue de l'examen, archétypes selon la discipline (STEM : artefact concret creusé ; SHS : conditions d'une notion, résultat d'étude, critique de texte, argumentation avec grille ; essai ; oral), plusieurs sujets sur des notions distinctes. **Le chemin générique est le chemin par défaut**, pas un repli dégradé.
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

## Isolation de l'exécution : décision

Le moteur privilégie un bac à sable noyau (Seatbelt sur macOS, espaces de noms `unshare -rn` sur Linux). Sur Railway, l'hôte refuse `unshare` : par défaut toute exécution reste **désactivée** et ces voies répondent `not_applicable`, jamais un faux « prouvé ».

La vérification de programmes Python peut être activée explicitement avec `CORTEX_PYTHON_WASM=1`. Elle exécute Pyodide dans un worker WebAssembly jetable : aucun accès au réseau ni au système de fichiers hôte, pont JavaScript et capacités Python réseau/fichiers refusés avant exécution, worker tué au timeout et sortie tronquée. Elle sert les deux voies d'exécution Python (`runPython`, `lib/sandbox-exec.ts`) : les programmes « écris une fonction » (`verifyCode`) et les extraits des questions de lecture de code (`lib/blocks.ts`).

- **Délais séparés** : le démarrage (worker, runtime, import de pandas) a son propre délai (60 s) ; les 10 s d'exécution courent à partir du runtime prêt. Compté dans ces 10 s, le démarrage pandas (2,5 s seul, 11 s à 32 en parallèle) faisait passer un extrait correct pour une boucle infinie.
- **Mémoire** : le tas JavaScript est plafonné par `resourceLimits`, et la mémoire linéaire WebAssembly par un refus de croissance au-delà du tas du runtime + 256 Mo (le programme reçoit un `MemoryError`). `tracemalloc` reste en garde complémentaire, mais il ne voit une allocation C unique qu'après coup.
- **Borne globale** : au plus `CORTEX_PYTHON_WASM_CONCURRENCY` vérifications (défaut 4) tous processus confondus, par fichiers-créneaux dans `/tmp` (chaque job est un processus) ; le créneau d'un processus mort est repris.
- **Paquets** : les wheels pandas sont préchargés dans l'image (`scripts/pyodide-prefetch.ts`) ; la CI exécute pandas réseau coupé sur l'image construite.

Mesures et méthode : `npm run pyodide:load` (scripts/pyodide-load.ts). Cette voie ne réactive ni C, ni SymPy, ni les figures. `/api/health` distingue `verification.mode: "python-wasm"` de l'isolation noyau.

## Coût et facturation

Tous les appels au modèle passent par `lib/llm/index.ts` — **point d'entrée unique**, sans chemin de contournement. Il impose :

- un **plafond de dépense global par mois calendaire** (UTC, remis à zéro le 1er) qui coupe les appels payants quand il est atteint, avec un e-mail d'alerte au propriétaire à 80 % puis à 100 % : `SPEND_CAP_USD` est le fusible ultime ; la dépense que les paiements ne couvrent pas (crédits offerts) est en outre bornée, au lancement, par le **revenu encaissé** (`SPEND_CAP_BASE_USD` + marge × revenu net du mois, hors propriétaire) ;
- l'**enregistrement du coût réel** de chaque appel (`llm_usage`) ;
- des **quotas quotidiens** par utilisateur, appliqués en amont des générations.

La facturation est un modèle de **crédits prépayés**. Vocabulaire, tel qu'il est employé dans le code :

- **Ledger** (`credit_transactions`) : journal ajout-seul ; le **solde** d'un compte est la somme de ses deltas, il n'existe aucune table de solde à désynchroniser. L'unité du ledger est le **centième de crédit** (1 crédit = 100) : l'assistance se facture en fraction de crédit. Une base antérieure est convertie une fois, atomiquement, au premier accès.
- **Écriture idempotente** : chaque ligne porte une **référence** unique (`signup:<compte>`, `job:<compte>:<cours>:<id>`, `assist:<compte>:<uuid>`, `stripe:cs:<session>`, `refund:<réf>`…). Rejouer une opération ne crée jamais de doublon.
- **Réservation** : décision unique et atomique, prise **avant** tout travail, qui vérifie dans une même transaction du store global le débit par minute, le quota du jour, le nombre de générations en cours, le solde et le **budget IA** du compte, puis enregistre le tout. Une réservation refusée signifie que le job n'existe pas pour le moteur (jamais démarré) ; une réservation acceptée est un **débit** définitif.
- **Achat** : crédit provenant d'un paiement Stripe confirmé, identifié par la session de paiement (pack de 10, permanent).
- **Abonnement** (Pro) : seconde poche de crédits, jamais reportée. Le mensuel n'est crédité que par une facture payée, pour sa période de facturation (idempotent par facture) ; l'annuel reçoit le montant du plan par **fenêtres** mensuelles ancrées sur le début de sa période (et non sur le mois civil), sans nouvelle facture, une seule fois par fenêtre et jamais après la fin de période. Seule une ligne annuelle écrite avant les fenêtres garde son ancre au 1er du mois, tant que le début de sa période n'est pas connu. Une facture remboursée ou contestée suspend l'abonnement jusqu'à la prochaine facture payée. Un débit consomme l'abonnement avant les crédits achetés, dans la même réservation ; un remboursement rend chaque part dans sa poche, la part d'abonnement seulement si la fenêtre du débit est encore ouverte.
- **Remboursement** : ligne positive qui rend ce qu'un débit avait prélevé (pas le tarif courant), une seule fois par débit. Un job **échoué** (rien livré) est rendu en entier, même après des appels payants : l'échec est le nôtre ; un job **annulé** par l'utilisateur ne l'est que s'il n'a rien coûté au fournisseur (`llm_usage` rattaché au job à zéro), sinon annuler puis relancer offrirait des générations illimitées. Un examen **incomplet** est rendu au prorata des questions manquantes, arrondi en faveur de l'utilisateur ; une question **signalée** dont l'erreur est confirmée l'est à sa part. Un même débit peut ainsi être rendu en plusieurs fois, jamais au-delà de lui : chaque remboursement inscrit sa part (`share_milli`) et la somme est plafonnée.
- **Reprise** (reversal) : ligne négative qui retire les crédits d'un achat remboursé ou contesté chez Stripe ; le solde peut devenir négatif, ce qui bloque toute génération jusqu'au prochain achat.
- **Revenu encaissé** (`stripe_payments`, `stripe_payment_losses`) : ce que chaque paiement Stripe a réellement rapporté, net de taxe, de frais (réels, ou estimés si Stripe n'a pas répondu), de remboursements et de litiges. Écrit par le webhook ; l'historique antérieur se reprend avec `npm run billing:backfill`.
- **Budget IA** : règle de Ben, Cortex reste toujours en bénéfice. Ce qu'un compte a coûté en IA sur 12 mois glissants (jobs échoués et remboursés compris) reste sous `AI_BUDGET_MARGIN` (0,6) × son revenu net sur la même fenêtre ; au-delà, refus 402 au lancement. Exception : les crédits **achetés** restent toujours utilisables (obligation contractuelle) ; c'est donc le prix en crédits, et non le budget, qui garantit la marge sur un compte payant. Le propriétaire est exempt. Le plafond du jour d'un compte suit son budget (plancher qui laisse finir un job payé, fusible `SPEND_CAP_PER_USER_USD`).
- **Limites d'usage** (`lib/billing/limits`) : une seule fonction juge un lancement (`launchVerdict`) d'après l'état lu du compte : débit par minute, quota du jour, générations simultanées, crédits, capacité gratuite, calcul du jour par compte (fusible + budget), capacité du mois, stockage. La même sert à l'affichage (`getUsageLimits` : page « Mon usage », indicateur à côté des boutons, `get_account_status`), aux pré-contrôles de l'app et du MCP, et à la réservation atomique (`reserveGeneration`, sous le verrou du compte, et du verrou global quand le fournisseur est payant) ; le coût attendu des jobs en cours est réservé dans `active_jobs.expected_usd`, de sorte que deux lancements simultanés ne passent pas tous deux sous la limite et qu'un job lancé n'échoue pas en route pour une limite connue au lancement.
- **Stockage** : quota par compte lié au revenu (base gratuite, croît avec les paiements, borné par le volume quand les fichiers y vivent) ; les images de pages rendues vivent dans un cache purgeable hors quota et hors sauvegarde (`lib/page-cache`).
- **Fichiers de cours** (`lib/storage`, interface `CourseFiles`) : tout accès aux annales, uploads et examens d'une requête passe par elle. Sans variable, le disque (`LocalFsStore`) ; avec `STORAGE_S3_*`, un seau S3-compatible (`S3Store`) qui fait foi, sous la même arborescence, le disque n'étant plus qu'un cache. Le moteur (tectonic, pdftoppm, vision) reste sur disque : le worker tourne dans `withLocalDir`, qui rapatrie les dossiers du cours puis renvoie ses sorties.
- **Assistance** : appel au modèle sans job (drill, correction, analyses) ; facturé une fraction de crédit, rendu seulement si nos gardes l'ont arrêté avant envoi ou si la réponse est restée inutilisable (illisible malgré les réessais) ; une panne du fournisseur reste débitée.

## Connecteur MCP

`/mcp` expose le compte de la personne connectée à Claude (claude.ai, Desktop, Claude Code) — lecture et générations confirmées — dans le **même conteneur**, opt-in par `MCP_ENABLED=1`. Cortex y est **son propre serveur OAuth 2.1** (`lib/oauth/` : métadonnées RFC 9728/8414, clients CIMD et DCR, consentement derrière la session Auth.js, code + PKCE S256, jetons opaques hachés liés à la ressource, refresh tournant, révocation). Le serveur MCP (`lib/mcp/`, SDK officiel v2, sans état) sert les ères 2026-07-28 et 2025 ; chaque outil s'exécute sous `runWithUser(compte du jeton)` et appelle les fonctions de `lib/` que les routes appellent déjà — mêmes contrôles d'accès, quotas, réservation et plafond. Tout coût est annoncé puis confirmé (élicitation ou devis à usage unique). Détail et modèle de menace : `cortex/docs/MCP.md`.

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
