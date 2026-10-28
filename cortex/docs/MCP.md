# Serveur MCP de Cortex

Le connecteur qui permet à n'importe quel compte Cortex de brancher Claude (claude.ai « Connecteurs
personnalisés », Claude Desktop, Claude Code) sur ses propres données, avec l'URL
`https://app.cortexexam.com/mcp`. On se connecte avec son compte Cortex habituel (Google via Auth.js),
on accepte un écran de consentement, et c'est tout : aucune clé à copier.

Rédigé le 26/10/2026. Spec lue ce jour-là sur modelcontextprotocol.io.

---

## 1. Ce qui est servi, et pourquoi ces choix

| Sujet | Choix | Raison |
|---|---|---|
| Spec MCP | **2026-07-28** (en vigueur) + **2025-11-25 / 06-18 / 03-26** via `initialize` | claude.ai et Desktop parlent encore l'ère 2025 (`initialize`) ; Claude Code (runtime v2) négocie 2026-07-28. Les deux ères sont servies sur le même point. |
| SDK | **`@modelcontextprotocol/server` 2.4.0** (SDK officiel, ligne stable v2) | `@modelcontextprotocol/sdk` 1.x est la ligne de maintenance, plafonnée à 2025-11-25 et sans 2026-07-28 prévu. La v2 sert les deux ères **sans état** depuis un handler `Request → Response`, ce qui colle à une route Next. |
| Transport | Streamable HTTP, `POST /mcp`, **sans état** (`createMcpHandler`) | Aucune session en mémoire : rien ne se perd à un redéploiement, rien ne grossit. `GET`/`DELETE` → `405` (spec). |
| Hébergement | **dans l'app Next.js** (même conteneur Railway, même Postgres) | Réutilise sans copie les contrôles d'accès, quotas, crédits et le contexte de tenant de `lib/`. Un service séparé aurait dû dupliquer la logique métier ou l'appeler par HTTP. |
| Autorisation | Cortex est **son propre serveur OAuth 2.1** | Spec MCP « Authorization » 2026-07-28 : RFC 9728 (ressource protégée), RFC 8414 (métadonnées AS), PKCE S256 obligatoire, RFC 8707 (`resource` lié au jeton), CIMD recommandé + DCR (déprécié, gardé en compatibilité), refresh tournant, révocation RFC 7009, `iss` RFC 9207. |
| Jetons | **opaques** (`cx_at_…`, `cx_rt_…`), stockés **hachés** (SHA-256) en base | Révocables instantanément (une ligne), aucun secret de signature à gérer ; le conteneur est unique, la recherche par index suffit. |
| Activation | **`MCP_ENABLED=1`** (opt-in) | Invariant n° 6 : une fonctionnalité s'active par configuration. Sans la variable, `/mcp`, `/.well-known/oauth-*` et `/oauth/*` répondent 404. |

### Écart signalé par rapport au brief

- Le brief nomme `@modelcontextprotocol/sdk` « dernière version stable ». Le SDK officiel stable est
  désormais publié sous `@modelcontextprotocol/server` (v2) ; `@modelcontextprotocol/sdk` 1.32.2 est la
  ligne de maintenance. J'ai suivi l'intention (SDK officiel, dernière version stable), donc la v2.
- « Migration drizzle » : les tables globales de Cortex (utilisateurs, crédits, abonnements…) ne passent
  pas par drizzle mais par la DDL idempotente de `db/auth-store.ts`, appliquée au démarrage sur SQLite
  comme sur Postgres (drizzle ne décrit que le schéma SQLite d'un tenant). Les tables OAuth suivent le
  mécanisme réel du dépôt ; une migration drizzle aurait été un second mécanisme jamais appliqué en prod.

## 2. Architecture

```
claude.ai / Desktop / Claude Code
        │  POST /mcp  (Authorization: Bearer cx_at_…)
        ▼
proxy.ts ── /mcp, /.well-known/oauth-*, /oauth/{register,token,revoke} : publics (pas de cookie)
        │   /oauth/authorize (+ /decision) : derrière la session Auth.js (sinon → /login)
        ▼
app/mcp/route.ts ──► lib/mcp/http.ts  handleMcp(req)
                        1. MCP activé ? Origin autorisée ?
                        2. jeton → lib/oauth verifyAccessToken (audience = /mcp) → 401 + WWW-Authenticate
                        3. limite de débit par compte (en mémoire, conteneur unique)
                        4. createMcpHandler(factory) — une instance McpServer par requête
                              └─ lib/mcp/server.ts  buildServer({ era })
                                    pour chaque outil de lib/mcp/tools/* :
                                    portée (403 insufficient_scope) → Zod(entrée) → compte + cours
                                    (runWithUser / runWithCourse) → confirmation si coût
                                    → run() → Zod(sortie) → plafond de taille → rendu « données »
                                    → journal (sans contenu ni jeton)
                                         │
                                         ▼
                             lib/ (inchangé) : courses, program, weaknesses, search, exam,
                             jobs, generation, drill, check-solution, billing/reserve…
```

Modules, en profondeur (interface étroite, beaucoup derrière) :

| Module | Interface | Ce qu'il cache |
|---|---|---|
| `lib/oauth/server.ts` | `validateAuthorizeRequest`, `createConsentTicket`, `decideConsent`, `exchangeToken`, `revokeToken`, `verifyAccessToken`, `listConnectedApps`, `revokeConnectedApp` | PKCE, usage unique des codes/tickets/refresh (transactions), rotation et détection de vol, audience, empreintes |
| `lib/oauth/clients.ts` | `registerClient`, `findClient` (+ `redirectUriMatches`, `isPublicAddress`) | DCR, lecture CIMD durcie (SSRF), cache, règles d'URL de retour |
| `lib/oauth/routes.ts` | un handler `Request → Response` par point OAuth + `prepareConsent` | formats RFC (erreurs, CORS, no-store), lecture bornée des corps |
| `lib/mcp/http.ts` | `handleMcp(req)` | activation, Origin, bearer, débit, ères MCP |
| `lib/mcp/server.ts` | `buildServer(ctx)` | enregistrement des outils, validation, erreurs typées, rendu, journal |
| `lib/mcp/tool.ts` | `defineTool({...})` | contrat « une capacité = un fichier » |
| `lib/mcp/confirm.ts` | `confirmCost(...)` | élicitation MRTR **ou** devis à jeton unique, selon le client |
| `lib/generation.ts` | `startGenerationJob(type, target)` | séquence job actif → pré-checks → réservation → worker, partagée avec `POST /api/exams/generate` |

Aucune logique métier n'est copiée : les outils appellent les fonctions de `lib/` que les routes de
l'app appellent déjà. La seule extraction (`lib/generation.ts`) remplace le corps de
`app/api/exams/generate/route.ts`, dont la réponse HTTP est inchangée.

## 3. Outils exposés

Noms et descriptions en anglais (lus par le modèle) ; les réponses gardent la langue des contenus.
Tous les outils prennent un `course` facultatif : identifiant, code (« CS-233 ») ou nom du cours ;
absent, le seul cours du compte est pris, sinon l'outil liste les cours et demande lequel.

Annotations : lecture = `readOnlyHint: true, destructiveHint: false, idempotentHint: true,
openWorldHint: false` ; génération et ajout = `readOnlyHint: false, destructiveHint: false,
idempotentHint: false`, `openWorldHint: true` pour le seul `add_course_source` (il lit une URL fournie),
`false` ailleurs. Seuls les outils d'ajout écrivent (créer un cours, y ranger un fichier, lancer sa
préparation) ; aucun outil ne supprime un cours ou un document, ni ne touche au paiement.

Schémas de sortie : chaque `outputSchema` est publié **tolérant aux champs en plus** (pas de
`additionalProperties: false`), et la sortie est validée strictement côté serveur avant l'envoi.
claude.ai garde la liste d'outils en cache et rejetait une réponse portant un champ ajouté depuis
(« data must NOT have additional properties », 28/10/2026, `format` et `note` de `generate_mock_exam`).
Testé contre le validateur des clients MCP : `tests/mcp-output-schema.test.ts`.

### Lecture (portée `cortex.read`, gratuites)

| Outil | Entrée | Sortie |
|---|---|---|
| `list_courses` | — | cours du compte : id, code, nom, établissement, langue, date d'examen, jours restants, lien vers l'app |
| `get_study_plan` | `course?` | maîtrise et couverture pondérées, notions à revoir, répétition espacée, chapitres du plan, notion prioritaire + 3 suivantes, notions (40 max, par priorité), compte à rebours |
| `get_weak_points` | `course?`, `limit?` (≤ 50) | points faibles par gravité (sujet, thème, description bornée), regroupement par thème, concepts dus en répétition espacée |
| `get_results` | `course?`, `limit?` (≤ 30) | examens blancs générés (date, statut, nb de questions, vérification), scores de maîtrise par notion, retours notés |
| `search_course_materials` | `course?`, `query` (2-200 car.), `limit?` (≤ 30) | passages des sources du cours (titre, type, extrait borné) |
| `get_account_status` | — | solde (achetés + abonnement), coûts, quotas du jour utilisés / plafonds |
| `get_job_status` | `course?`, `job_id?` | état d'une génération (statut, avancement, étape, erreur) ; terminée : énoncés de l'examen (+ corrigés si `include_solutions`) et liens vers l'app ; sans `job_id` : job en cours + récents |

### Génération (portée `cortex.generate`, coût annoncé puis confirmé)

| Outil | Entrée | Coût | Sortie |
|---|---|---|---|
| `generate_mock_exam` | `course?`, `chapter?` (numéro ou titre du plan), `focus?` (≤ 400), `format?` (`written` / `mcq`), `exercise_count?` (écrit 1-12, QCM 1-40), `confirmation_token?` | `exam` = 2 crédits, +1 par tranche de 4 exercices au-delà de 8 ; QCM au tarif de `qcm` (`costForJob`) ; 1 génération du quota du jour (`DAILY_GEN_QUOTA`) | `job_id` → suivre avec `get_job_status` (10-20 min ; un QCM terminé y rend ses questions et options). Avec des annales, leur format fait la règle (une demande de QCM n'est pas appliquée, `note` le dit). **Sans annales** : la demande est suivie, avec QCM si `format` vaut `mcq` ou si la demande libre en réclame (négations et titres de chapitre ignorés, nombre lu dans le texte) ; défauts 6 exercices ou 20 QCM ; `note` le dit (`lib/generation.ts` `planMockExam`) |
| `generate_drill` | `course?`, `concept?` (≤ 500 ; défaut : le point faible le plus grave), `confirmation_token?` | `assist` = 0,1 crédit ; 1 assistance du quota du jour (`DAILY_ASSIST_QUOTA`) | une question type examen, 5 indices progressifs, corrigé |
| `check_answer` | `course?`, `statement` (≤ 8000), `answer` (≤ 8000), `confirmation_token?` | `assist` = 0,1 crédit ; 1 assistance du quota du jour | verdict, barème critère par critère, score, retour, solution |

Les coûts viennent des mêmes fonctions que l'app (`creditCost`, `costForJob`, `CREDITS_COST_JSON`) :
changer un tarif change le devis MCP. Un examen déjà en cours est réutilisé sans devis ni débit, comme
dans l'app. Les pré-checks propres à l'examen (corpus ingéré, moteur LaTeX, place disque) s'exécutent à la
confirmation, dans `startGenerationJob` : un refus à ce stade ne débite rien.

**Compte du propriétaire** (`CORTEX_OWNER_EMAIL`, ou `CORTEX_OWNER_USER_ID`) : rien n'est débité ni compté
contre lui, dans l'app comme ici (`lib/billing/owner.ts`, un seul point de décision consulté par la
réservation et les pré-contrôles ; `dailyLimit` pour l'affichage). Son devis annonce donc 0 crédit et
aucun quota, et la confirmation reste demandée. Restent actifs pour lui : les plafonds de **dépense**
réelle (`SPEND_CAP_USD` du mois, `SPEND_CAP_PER_USER_USD` du jour — sans ce dernier, une boucle d'agent
ou un jeton volé sur son compte épuiserait le plafond global et couperait la génération de tous), la
limite par compte du point MCP, l'enregistrement des coûts dans `llm_usage` et le quota de stockage.
Sans variable de propriétaire, personne n'est exempté.

### Ajout de cours et de supports (portée `cortex.write`, tous les comptes)

Proposée à **tout** compte à l'écran de consentement (case « Ajouter des cours et des supports », cochée
par défaut et décochable comme « Générer »). Sans elle, ces outils répondent `403 insufficient_scope`.
Mêmes règles que l'app : créer un cours et ranger un support sont gratuits, mais comptent dans le quota de
stockage (200 Mo par défaut). L'app n'a ni limite de nombre de cours ni paywall sur ces deux gestes. La
préparation coûte ses crédits habituels (`prepare` = 2) et une génération du quota du jour, annoncés puis
confirmés comme `generate_mock_exam` ; elle exige donc aussi `cortex.generate`. Le compte du propriétaire
garde son seul privilège : rien ne lui est débité ni compté (devis à 0 crédit). Pas d'outil de suppression.

| Outil | Entrée | Effet |
|---|---|---|
| `create_course` | `name` (2-80), `code?` (≤ 24), `university?`, `language?` (fr, en, de, it, es, pt, nl), `exam_date?` (AAAA-MM-JJ) | crée le cours comme « Nouveau cours » (`buildCourseRow`) ; refuse un second cours au même code (`conflict`) |
| `add_course_source` | `course?`, `url?` **ou** `text?` (≤ 200 000 car.), `title?`, `category?` (`past_exam`, `lecture`, `exercises`, `notes` ; défaut : deviné du nom comme l'import) | range le fichier dans le cours (`lib/course-source.ts`) sans l'ingérer ; URL : https publique seulement, lue par `lib/public-https` (IP littérales et résolues vérifiées, y compris une IPv4 portée par une IPv6 ; aucune redirection suivie, seul l'hôte de destination est rapporté ; 30 s au total, 30 Mo), PDF (signature `%PDF-` exigée), HTML ou texte ; quota de stockage vérifié **avant** de télécharger, au plus `SOURCE_FETCH_PER_HOUR` lectures d'URL par compte et par heure (30 par défaut en déploiement gardé ; c'est le serveur qui télécharge), chemin confiné, jamais d'écrasement (`-2`, `-3`…) |
| `prepare_course` | `course?`, `confirmation_token?` | devis puis confirmation (2 crédits, 1 génération du jour), puis le job `prepare` (ingestion → format → plan), le même que le bouton de l'app (`startPrepareJob`) ; une préparation déjà en cours est réutilisée sans devis ni débit ; suivi avec `get_job_status` |

### Confirmation d'un coût

Toute action qui coûte des crédits ou une unité de quota **annonce d'abord le coût exact** (crédits,
solde avant/après, quota du jour utilisé/plafond) et attend une confirmation explicite. Avant même le
devis, les gardes lecture seule de l'app (`generationGate` : rafale + quota du jour ; `creditsGate` :
solde ; moteur disponible) refusent ce qui serait refusé de toute façon — on ne fait pas confirmer
une dépense impossible.

1. **Compte du propriétaire** : rien ne lui est facturé, rien à confirmer, l'action part directement
   (décision de Ben, 27/10/2026). Une instance sans facturation ne suffit pas : l'action consomme
   quand même du quota, un compte ordinaire confirme.
2. **Par défaut : devis en deux temps.** Premier appel = **devis** sans aucun effet, avec un
   `confirmation_token` (usage unique, 10 min, haché en base, lié au compte, à l'autorisation OAuth, à
   l'outil, aux arguments et au coût). Claude montre le coût dans la conversation, attend l'accord
   explicite, puis rappelle l'outil avec ce jeton = exécution. Les instructions du serveur et les
   descriptions d'outils l'imposent. C'est le flux de claude.ai, Claude Desktop et Cowork : ils
   **annoncent** l'élicitation sans l'afficher, et un dialogue y laissait l'appel pendre jusqu'à
   expirer (230 s, 27/10/2026).
3. **Élicitation, seulement pour les clients qui l'affichent** : ère 2026-07-28, capacité déclarée, et
   nom `clientInfo` dans `MCP_ELICITATION_CLIENTS` (défaut `claude-code` ; vide = personne). L'outil
   répond `input_required` avec un formulaire « Confirmer — N crédits » ; le client le montre et relance
   l'appel avec la réponse. Le `requestState` signé (10 min) porte la **référence** du devis (son
   empreinte, jamais le jeton, car le codec signe sans chiffrer). Un état expiré ou falsifié fait
   redemander, un refus brûle **tous** les devis ouverts de cette action. **Repli** : si une demande pour
   la même action est restée plus de 30 s sans réponse, l'appel suivant reçoit le devis à jeton au lieu
   d'un nouveau dialogue. Le serveur, sans état, ne peut pas interrompre un dialogue déjà envoyé : un
   client qui ne l'affiche pas garde le premier appel en suspens jusqu'à son propre délai, et les
   instructions du serveur disent alors au modèle de rappeler l'outil.
   Si la personne refuse (`decline`) ou ferme la confirmation (`cancel`), l'outil rend
   `status: "declined"` sans jeton de repli.

Dans tous les cas la dépense passe ensuite par la **réservation atomique** de l'app
(`reserveGeneration` : rafale par minute, quota du jour, places en cours, solde, plafond global
`SPEND_CAP_USD` au niveau `lib/llm`) : un devis confirmé n'est pas un passe-droit, il peut encore être
refusé (402 solde, 429 quota) et rien n'est alors débité.

## 4. Flux OAuth

```
Client MCP                         Cortex (AS + ressource)                    Personne
──────────                         ───────────────────────                    ────────
POST /mcp (sans jeton) ──────────► 401  WWW-Authenticate: Bearer
                                   resource_metadata=".../.well-known/oauth-protected-resource/mcp",
                                   scope="cortex.read cortex.generate cortex.write"
GET /.well-known/oauth-protected-resource/mcp ─► { resource: ".../mcp", authorization_servers: [issuer] }
GET /.well-known/oauth-authorization-server ───► endpoints, S256, CIMD supporté, iss RFC 9207
(CIMD : client_id = URL https de ses métadonnées — sinon POST /oauth/register, DCR)
navigateur → GET /oauth/authorize?response_type=code&client_id&redirect_uri
             &code_challenge(S256)&state&resource&scope
                                   session Auth.js absente → /login (Google) → retour ici
                                   demande validée → ticket de consentement (10 min) ─────► écran :
                                                                                          application,
                                                                                          domaine, accès
                                   POST /oauth/authorize/decision (ticket, approve) ◄──── Autoriser
                                   303 → redirect_uri?code&state&iss
POST /oauth/token (code, code_verifier, resource) ─► jeton d'accès 1 h + refresh 30 j
POST /mcp (Bearer) ───────────────► outils, au nom du compte
POST /oauth/token (refresh_token) ─► nouveau couple ; l'ancien refresh est mort
```

Règles :

- **PKCE S256 obligatoire** (`plain` refusé, `code_challenge` de 43 caractères base64url).
- **URL de retour** : égalité exacte avec une URL enregistrée ; seule exception, le port d'une adresse
  de bouclage (`localhost`, `127.0.0.1`, `[::1]`, RFC 8252 §7.3) — Claude Code ouvre un port différent à
  chaque connexion. URL non enregistrée ou client inconnu : erreur **affichée**, jamais de redirection
  (pas de redirecteur ouvert). Les autres erreurs repartent au client avec `state` et `iss`.
- **Ressource** : absente = `/mcp` de l'instance ; toute autre valeur → `invalid_target`. Le jeton est
  lié à la ressource ; `/mcp` refuse un jeton émis pour une autre (pas de « token passthrough »).
- **Codes** : 60 s, usage unique, consommés avant vérification ; un code rejoué révoque les jetons émis
  à partir de **ce** code (sa lignée), pas ceux des autres appareils du même compte.
- **Refresh tournant** : chaque usage émet un nouveau couple. Le même refresh représenté dans les 30 s
  (réessai après coupure réseau, `OAUTH_REFRESH_GRACE_S`) est servi ; au-delà, c'est un vol présumé →
  sa lignée est révoquée. Une portée demandée au refresh ne peut que restreindre.
- **Portées** : celles d'un jeton sont toujours bornées par l'autorisation **en vigueur** — décocher
  « Générer » en reconnectant l'application retire aussi la génération aux jetons déjà émis. La lecture
  est toujours accordée (sans elle aucun outil ne répond).
- **Clients publics seulement** (PKCE) : aucun secret client n'est émis ; une demande DCR de secret est
  enregistrée en client public (`token_endpoint_auth_method: "none"`, RFC 7591 §3.2.1).
- **Consentement** : affiché à chaque connexion (aucune approbation automatique), avec le domaine
  vérifié pour un client CIMD (hôte du `client_id`) ou l'hôte de l'URL de retour pour un client DCR
  (nom déclaré, non vérifié). Case « Générer (coûte des crédits) » décochable : le jeton ne porte alors
  pas `cortex.generate`, et un outil qui dépense des crédits répond `403 insufficient_scope` (le client
  relance une connexion pour la portée manquante). Case « Ajouter des cours et des supports »
  (`cortex.write`), décochable de la même façon : non cochée, les outils d'ajout répondent `403
  insufficient_scope`. `prepare_course` exige les deux (il ajoute et il dépense) ; l'écran le dit.
- **Autorisations** : une par (compte, client), listées dans *Mon compte → Applications connectées* ;
  « Révoquer » coupe immédiatement tous ses jetons.
- **CIMD** : document lu en HTTPS uniquement par la lecture durcie commune (`lib/public-https.ts`) :
  IP littérale vérifiée avant connexion (Node ne passe pas par le `lookup` pour une IP : avant le
  27/10/2026, `https://127.0.0.1/…` échappait au contrôle ; une IPv4 portée par une IPv6 — mappée,
  compatible, traduite, NAT64, 6to4 — est jugée sur l'IPv4), résolution DNS vérifiée au moment de la
  connexion (IP privées, bouclage, lien local, CGNAT, ULA refusées), aucune redirection suivie, 5 s au
  total (et non plus seulement d'inactivité), 5 Ko, cache
  5 min-24 h ; le document doit se désigner lui-même (`client_id` = son URL), déclarer `client_name` et
  des `redirect_uris` valides, et être un client public (`none`).
- **DCR** : ouvert (spec), toujours en client public. Un client jamais autorisé au bout de 7 jours est
  supprimé.

## 5. Modèle de menace

| Menace | Parade |
|---|---|
| Accès aux données d'un autre compte | Le compte vient **du jeton** (jamais d'un argument) ; chaque appel s'exécute sous `runWithUser(compte)` ; le cours passe par `ownsCourse` (cours d'un autre = « introuvable », comme les routes) avant toute requête au tenant ; schéma Postgres par (compte, cours). Testé : `tests/mcp-tools.test.ts`. |
| Jeton volé | Accès 1 h ; refresh tournant avec détection de réutilisation (révocation de la lignée) ; révocation depuis le compte (toute l'application) ou RFC 7009 (la lignée) ; empreintes seules en base ; jamais journalisés (préfixes `cx_at_`/`cx_rt_` reconnaissables). |
| Phishing de consentement (client DCR qui se fait appeler « Claude ») | Domaine affiché (vérifié pour CIMD, URL de retour pour DCR), mention « nom déclaré par l'application » ; URL de retour exacte ; consentement à chaque connexion. |
| CSRF sur la décision | Cookie de session SameSite=Lax, `Origin` = l'app, ticket opaque lié au compte, usage unique. |
| Code d'autorisation intercepté | PKCE S256 obligatoire ; code 60 s, usage unique, lié au client et à l'URL de retour. |
| SSRF via un `client_id` CIMD ou `add_course_source` | Une seule porte, `lib/public-https.ts` : HTTPS seulement, sans identifiants dans l'URL, IP littérale vérifiée avant connexion, IP résolues vérifiées à la connexion (pas de fenêtre de rebinding), pas de redirection, taille et durée totale bornées. Testé : `tests/mcp-write.test.ts`. |
| Serveur utilisé comme relais de téléchargement | `add_course_source` est un GET sortant vers une URL choisie par le modèle, pour tout compte `cortex.write`. Bornes : https public seulement, 30 Mo et 30 s par lecture, `SOURCE_FETCH_PER_HOUR` par compte, quota de stockage vérifié avant la lecture, limite par compte du point MCP. Un contenu piégé pourrait faire porter des données dans l'adresse (exfiltration de ce que le modèle sait) : appels visibles dans le client, portée décochable, révocation dans Mon compte. |
| Dépense non voulue (crédits) | Portée `cortex.generate` séparée et décochable ; coût exact annoncé ; devis à jeton unique lié aux arguments (accord demandé dans la conversation), ou élicitation pour les clients qui l'affichent ; puis réservation atomique de l'app (solde, quota, rafale, places, plafond mensuel global). Coût nul (propriétaire) : lancement direct, borné par les plafonds de dépense. |
| Injection de prompt par le contenu des cours | Sorties encadrées comme **données** (`<cortex_data>…</cortex_data>`, `<` échappé en `<` dans le JSON pour qu'aucun contenu ne ferme le bloc) ; consigne serveur (`instructions`) ; aucun outil de suppression ni de paiement ; les outils d'écriture n'ajoutent que du contenu aux cours **du compte du jeton** (gratuit, borné par le stockage), et tout ce qui coûte (génération, préparation) reste soumis à confirmation. |
| Flood / boucle d'agent | Limite par IP du proxy, `/mcp` compris (un jeton, même inventé, n'ouvre pas de compteur à part : sinon la limite se contournait) ; limite par compte au point MCP, après vérification du jeton ; quotas et rafale de la réservation ; corps ≤ 256 Kio. Derrière claude.ai, tous les comptes partagent les adresses de sortie d'Anthropic : à surveiller si l'usage grandit (DEPLOY.md § 14). |
| Sorties géantes | Listes bornées par outil, textes tronqués, plafond global ~40 000 caractères par résultat (sous les limites de claude.ai et de Claude Code). |
| Fuite par les journaux | Journal : outil, empreinte tronquée du compte, durée, code d'erreur. Jamais d'argument, de contenu de cours, de jeton ni d'e-mail. Les erreurs inattendues donnent un message générique au client. |
| DNS rebinding / origine | `Origin` présente et hors liste (`AUTH_URL`, claude.ai, claude.com, bouclage, `MCP_ALLOWED_ORIGINS`) → 403 ; requêtes sans `Origin` (serveur à serveur) acceptées. La même liste borne le CORS (origine reflétée, jamais `*`) des points OAuth et de `/mcp` (`lib/oauth/cors.ts`). |
| Texte forgé sur le domaine Cortex | L'écran d'erreur du consentement n'affiche que des messages connus, choisis par code ; aucun texte lu dans l'URL. |
| Émetteur falsifié par l'en-tête Host | En déploiement gardé l'émetteur vient d'`AUTH_URL` ; sans elle, MCP indisponible. |

## 6. Tests (coutures convenues)

Les coutures testées sont celles du brief : flux OAuth complet par les points HTTP, isolation entre
comptes, quota, devis/confirmation, jeton révoqué.

- `tests/mcp-oauth.test.ts` — par les handlers OAuth, Postgres réel (PGlite) : découverte, DCR, CIMD
  (document lu, imposteur refusé, SSRF), consentement (ticket d'un autre compte, origine étrangère, refus),
  code + PKCE, code rejoué, refresh tournant et vol, révocation, applications connectées.
- `tests/mcp-tools.test.ts` — par `POST /mcp` avec un vrai client MCP v2 (`@modelcontextprotocol/client`)
  dont le `fetch` appelle la route en mémoire : 401 + `WWW-Authenticate`, outils listés et annotés,
  lecture au nom du compte, cours d'un autre compte introuvable, devis puis confirmation (et jeton
  rejoué, autre argument, autre compte), quota du jour dépassé, solde insuffisant, élicitation (ère
  2026-07-28), portée manquante → 403, jeton révoqué → 401.
- `tests/mcp-write.test.ts` — portée `cortex.write` annoncée (métadonnées, défi 401) et proposée à tout
  compte, décochable, non obtenable au refresh ; sans elle → 403 `insufficient_scope` ; un compte normal
  crée un cours et range des supports gratuitement (texte, SSRF par URL, types, redirection, stockage
  vérifié avant lecture, débit horaire) et paie la préparation (refus sans solde, devis 2 crédits,
  débit à la confirmation, jeton à usage unique) ; le propriétaire ne paie rien.
- `tests/owner-mode.test.ts` — mode propriétaire côté facturation : réservation et pré-contrôles levés
  pour lui seul ; plafonds de dépense (par compte, global) maintenus ; limites affichées dans Mon compte ;
  autres comptes inchangés ; opt-in.
- Vérification réelle : inspecteur MCP (`npx @modelcontextprotocol/inspector`) contre le serveur local
  et `claude mcp add --transport http` dans un Claude Code de test (compte rendu dans la PR).

## 7. Mise en service (ce que Ben fait)

Voir DEPLOY.md, section « Connecteur MCP ». En bref : `MCP_ENABLED=1` sur Railway (avec `AUTH_URL`
déjà posée), redéployer, puis dans claude.ai → Paramètres → Connecteurs → Ajouter un connecteur
personnalisé → `https://app.cortexexam.com/mcp`. Rien à changer côté Google : la connexion réutilise
le login existant de l'app.

**Outils d'ajout (`cortex.write`)** : un connecteur branché avant leur arrivée garde son ancien jeton, et
un jeton ne gagne jamais de portée au refresh. Les outils apparaissent dans la liste, mais un appel
répond `403 insufficient_scope`. Un client qui gère ce 403 relance la connexion de lui-même ; sinon,
dans claude.ai → Paramètres → Connecteurs → Cortex → **Déconnecter**, puis **Connecter**, et laisser
cochée « Ajouter des cours et des supports ». Vaut pour chaque utilisateur déjà connecté. Les outils
apparaissent ensuite dans une nouvelle conversation.
