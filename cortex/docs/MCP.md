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
openWorldHint: false` ; génération = `readOnlyHint: false, destructiveHint: false,
idempotentHint: false, openWorldHint: false`. Aucun outil n'écrit, ne supprime un cours, ni ne
touche au paiement.

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
| `generate_mock_exam` | `course?`, `chapter?` (numéro ou titre du plan), `focus?` (≤ 400), `exercise_count?` (1-12), `confirmation_token?` | `exam` = 2 crédits, +1 par tranche de 4 exercices au-delà de 8 (`costForJob`) ; 1 génération du quota du jour (`DAILY_GEN_QUOTA`) | `job_id` → suivre avec `get_job_status` (10-20 min) |
| `generate_drill` | `course?`, `concept?` (≤ 500 ; défaut : le point faible le plus grave), `confirmation_token?` | `assist` = 0,1 crédit ; 1 assistance du quota du jour (`DAILY_ASSIST_QUOTA`) | une question type examen, 5 indices progressifs, corrigé |
| `check_answer` | `course?`, `statement` (≤ 8000), `answer` (≤ 8000), `confirmation_token?` | `assist` = 0,1 crédit ; 1 assistance du quota du jour | verdict, barème critère par critère, score, retour, solution |

Les coûts viennent des mêmes fonctions que l'app (`creditCost`, `costForJob`, `CREDITS_COST_JSON`) :
changer un tarif change le devis MCP. Un examen déjà en cours est réutilisé sans devis ni débit, comme
dans l'app. Les pré-checks propres à l'examen (corpus ingéré, moteur LaTeX, place disque) s'exécutent à la
confirmation, dans `startGenerationJob` : un refus à ce stade ne débite rien.

### Confirmation d'un coût

Toute action qui coûte des crédits ou une unité de quota **annonce d'abord le coût exact** (crédits,
solde avant/après, quota du jour utilisé/plafond) et attend une confirmation explicite. Avant même le
devis, les gardes lecture seule de l'app (`generationGate` : rafale + quota du jour ; `creditsGate` :
solde ; moteur disponible) refusent ce qui serait refusé de toute façon — on ne fait pas confirmer
une dépense impossible.

1. **Client qui gère l'élicitation (ère 2026-07-28, ex. Claude Code)** : l'outil répond
   `input_required` avec un formulaire « Confirmer — N crédits ». Le client le montre à la personne et
   relance l'appel avec la réponse. Un `requestState` signé HMAC (10 min) lie la confirmation au compte,
   à l'outil, aux arguments et au coût annoncé : un état falsifié, expiré ou porté sur d'autres arguments
   est refusé. Si la personne refuse (`decline`) ou si la confirmation est fermée ou ne peut pas être
   affichée (`cancel` — c'est ce que répond Claude Code en mode non interactif `-p`, vérifié avec la
   2.1.283), l'outil rend `status: "declined"` avec le coût annoncé et **aucun jeton de repli** : une
   confirmation ratée ne devient jamais un devis que le modèle pourrait confirmer seul. Conséquence
   assumée : une session sans humain ne peut rien dépenser.
2. **Sinon (ère 2025, ex. claude.ai)** : un serveur sans état ne peut pas pousser de requête au client.
   Premier appel = **devis** sans aucun effet, avec un `confirmation_token` (usage unique, 10 min, haché
   en base, lié au compte, à l'autorisation OAuth, à l'outil, aux arguments et au coût). Second appel avec
   ce jeton = exécution. Les descriptions d'outils imposent au modèle de montrer le devis et d'obtenir
   l'accord de la personne avant le second appel.

Dans les deux cas la dépense passe ensuite par la **réservation atomique** de l'app
(`reserveGeneration` : rafale par minute, quota du jour, places en cours, solde, plafond global
`SPEND_CAP_USD` au niveau `lib/llm`) : un devis confirmé n'est pas un passe-droit, il peut encore être
refusé (402 solde, 429 quota) et rien n'est alors débité.

## 4. Flux OAuth

```
Client MCP                         Cortex (AS + ressource)                    Personne
──────────                         ───────────────────────                    ────────
POST /mcp (sans jeton) ──────────► 401  WWW-Authenticate: Bearer
                                   resource_metadata=".../.well-known/oauth-protected-resource/mcp",
                                   scope="cortex.read cortex.generate"
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
- **Codes** : 60 s, usage unique, consommés avant vérification ; un code rejoué révoque l'autorisation
  qu'il avait ouverte.
- **Refresh tournant** : chaque usage émet un nouveau couple ; présenter un refresh déjà tourné = vol
  présumé → toute l'autorisation est révoquée. Une portée demandée au refresh ne peut que restreindre.
- **Consentement** : affiché à chaque connexion (aucune approbation automatique), avec le domaine
  vérifié pour un client CIMD (hôte du `client_id`) ou l'hôte de l'URL de retour pour un client DCR
  (nom déclaré, non vérifié). Case « Générer (coûte des crédits) » décochable : le jeton ne porte alors
  que `cortex.read`, et un outil de génération répond `403 insufficient_scope` (le client relance une
  connexion pour la portée manquante).
- **Autorisations** : une par (compte, client), listées dans *Mon compte → Applications connectées* ;
  « Révoquer » coupe immédiatement tous ses jetons.
- **CIMD** : document lu en HTTPS uniquement, résolution DNS vérifiée au moment de la connexion
  (IP privées, bouclage, lien local, CGNAT, ULA refusées), aucune redirection suivie, 5 s, 5 Ko, cache
  5 min-24 h ; le document doit se désigner lui-même (`client_id` = son URL), déclarer `client_name` et
  des `redirect_uris` valides, et être un client public (`none`).
- **DCR** : ouvert (spec), client public par défaut ; secret seulement si demandé (empreinte seule
  gardée). Un client jamais autorisé au bout de 7 jours est supprimé.

## 5. Modèle de menace

| Menace | Parade |
|---|---|
| Accès aux données d'un autre compte | Le compte vient **du jeton** (jamais d'un argument) ; chaque appel s'exécute sous `runWithUser(compte)` ; le cours passe par `ownsCourse` (cours d'un autre = « introuvable », comme les routes) avant toute requête au tenant ; schéma Postgres par (compte, cours). Testé : `tests/mcp-tools.test.ts`. |
| Jeton volé | Accès 1 h ; refresh tournant avec détection de réutilisation ; révocation depuis le compte ou RFC 7009 ; empreintes seules en base ; jamais journalisés (préfixes `cx_at_`/`cx_rt_` reconnaissables). |
| Phishing de consentement (client DCR qui se fait appeler « Claude ») | Domaine affiché (vérifié pour CIMD, URL de retour pour DCR), mention « nom déclaré par l'application » ; URL de retour exacte ; consentement à chaque connexion. |
| CSRF sur la décision | Cookie de session SameSite=Lax, `Origin` = l'app, ticket opaque lié au compte, usage unique. |
| Code d'autorisation intercepté | PKCE S256 obligatoire ; code 60 s, usage unique, lié au client et à l'URL de retour. |
| SSRF via un `client_id` CIMD | HTTPS seulement, IP vérifiées à la connexion (pas de fenêtre de rebinding), pas de redirection, taille et délai bornés. |
| Dépense non voulue (crédits) | Portée `cortex.generate` séparée et décochable ; coût exact annoncé ; confirmation par élicitation (humain) ou devis à jeton unique lié aux arguments ; puis réservation atomique de l'app (solde, quota, rafale, places, plafond mensuel global). |
| Injection de prompt par le contenu des cours | Sorties encadrées comme **données** (`<cortex_data>…</cortex_data>`, `<` échappé en `<` dans le JSON pour qu'aucun contenu ne ferme le bloc) ; consigne serveur (`instructions`) ; aucun outil d'écriture, de suppression ou de paiement, donc un contenu piégé ne peut au pire que faire **demander** une génération, qui reste soumise à confirmation. |
| Flood / boucle d'agent | Limite par IP du proxy (clé = jeton pour `/mcp`, pour ne pas mettre tous les comptes claude.ai dans le même seau) ; limite par compte au point MCP ; quotas et rafale de la réservation ; corps ≤ 256 Kio. |
| Sorties géantes | Listes bornées par outil, textes tronqués, plafond global ~40 000 caractères par résultat (sous les limites de claude.ai et de Claude Code). |
| Fuite par les journaux | Journal : outil, empreinte tronquée du compte, durée, code d'erreur. Jamais d'argument, de contenu de cours, de jeton ni d'e-mail. Les erreurs inattendues donnent un message générique au client. |
| DNS rebinding / origine | `Origin` présente et hors liste (`AUTH_URL`, claude.ai, claude.com, bouclage, `MCP_ALLOWED_ORIGINS`) → 403 ; requêtes sans `Origin` (serveur à serveur) acceptées. |
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
- Vérification réelle : inspecteur MCP (`npx @modelcontextprotocol/inspector`) contre le serveur local
  et `claude mcp add --transport http` dans un Claude Code de test (compte rendu dans la PR).

## 7. Mise en service (ce que Ben fait)

Voir DEPLOY.md, section « Connecteur MCP ». En bref : `MCP_ENABLED=1` sur Railway (avec `AUTH_URL`
déjà posée), redéployer, puis dans claude.ai → Paramètres → Connecteurs → Ajouter un connecteur
personnalisé → `https://app.cortexexam.com/mcp`. Rien à changer côté Google : la connexion réutilise
le login existant de l'app.
