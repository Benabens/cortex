# Dossier : annuaire des connecteurs Claude

Prêt à copier dans le portail de soumission. Rédigé le 16/11/2026 d'après :

- critères de revue : https://claude.com/docs/connectors/building/review-criteria
- construction et authentification : https://claude.com/docs/connectors/building
- portail de soumission : https://claude.ai/directory/manage (10 étapes, décrites ci-dessous)

Les champs de l'annuaire sont en anglais (public international) ; les consignes sont en français.

---

## 0. Avant de soumettre (bloquant)

| Prérequis | État | Qui |
|---|---|---|
| `MCP_ENABLED=1` en production, PR « mcp-distribution » déployée | à faire après fusion | Cowork |
| Page publique https://cortexexam.com/mcp en ligne (documentation exigée à la date de publication) | en cours, autre chantier (dépôt landing) | autre agent |
| Sonde verte contre la prod : `npx tsx scripts/oauth-probe.ts --base https://app.cortexexam.com --preset claude,claude-code` | à lancer | Cowork |
| Compte de test pour le relecteur (section 4) | connexion relecteur prête (PR « connexion-relecteur ») ; variables à poser et script à lancer après fusion | Cowork |
| Adresse de support publique | **`support@cortexexam.com`** (décision de l'éditeur, 16/11) ; envoyer un message de test avant de soumettre | l'éditeur |

---

## 1. Champs du formulaire

**Name** (≤ 100) :
```
Cortex
```

**One-liner** (≤ 200) :
```
Turn your own course materials into mock exams in your real exam's format, practice questions and a revision plan, from your Cortex account.
```

**Description** (≤ 2000) :
```
Cortex prepares students for their exams from their own course materials: slides, exercise sets and, above all, past exams. This connector lets Claude work on the student's Cortex account.

What Claude can do:
- Read the student's courses, exam dates, study plan, weak points, results and uploaded materials (full-text search), and their credit balance and daily limits.
- Generate, on request, a mock exam in the course's real exam format (multiple choice, exercises, mixed, essay or oral), a single practice question with progressive hints, or a graded review of an answer, criterion by criterion.
- Create a course, add materials (public URL or pasted text), declare the exam format and prepare the course.
- Report a faulty generated question.

Paid actions spend Cortex credits the student already has in their account. Every paid tool first returns its exact cost without spending anything; Claude asks the student and only then confirms. The connector never sells credits and never handles payments.

Access is per account and per permission: the student signs in to Cortex and chooses, on the consent screen, whether Claude may only read, also generate, and also add courses. Access can be revoked at any time from the Cortex account page. Text from course documents is treated as data, never as instructions.
```

**Categories** (1 à 5, dans la liste du portail) : Education ; Productivity.

**Documentation URL** : `https://cortexexam.com/mcp`

**Privacy policy URL** : `https://cortexexam.com/privacy-en`

**Terms URL** (si demandée) : `https://cortexexam.com/terms-en`

**Support** : `support@cortexexam.com`.

**Icon** : `https://app.cortexexam.com/mcp-icon-512.png` (PNG 512 × 512, tuile sombre, lisible sur fond clair et
sombre ; SVG : `https://app.cortexexam.com/mcp-icon.svg`).

**Server URL** : `https://app.cortexexam.com/mcp` (Streamable HTTP).

**Use cases / example prompts** :
```
What are my weak points before the COMP 201 exam?
Where am I in my study plan, and what should I revise next?
Generate a mock exam for my probability course, focused on chapter 3.
Give me one practice question on conditional expectation, with hints.
Grade my answer to this exercise: <question> / <my answer>
```

**Company** : raison sociale de l'éditeur et pays (à remplir par l'éditeur, comme sur les mentions légales).

**Authentication** :
```
OAuth 2.1 (authorization code + PKCE S256), Cortex is its own authorization server.
Discovery: 401 + WWW-Authenticate (resource_metadata) → RFC 9728 → RFC 8414.
Client registration: Client ID Metadata Documents (Claude's https://claude.ai/oauth/mcp-oauth-client-metadata and Claude Code's https://claude.ai/oauth/claude-code-client-metadata are accepted) and Dynamic Client Registration. No client ID or secret to enter.
Redirect: https://claude.ai/api/mcp/auth_callback (and loopback redirects for Claude Code).
Scopes: cortex.read (always), cortex.generate (paid generations), cortex.write (add courses); the user can untick generate and write on the consent screen.
Tokens: opaque, 1 h access + rotating 30-day refresh, revocable (RFC 7009) and from the Cortex account page.
```

**Data handling** :
```
The connector only reads and acts on the signed-in student's own account. It stores no conversation content. Tokens are stored hashed. Server logs record tool names, timings and error codes, never course content, prompts or tokens. Generated content is produced by AI model providers listed in the privacy policy. Students can export or delete their data from their account at any time.
```

**Test & launch** : compte de test (§ 4). Le trafic de Claude sort de `160.79.104.0/21` : Cortex ne filtre pas
par IP (limite de débit par IP et par compte seulement, largement au-dessus d'une revue).

**Engagements de conformité** (7 cases du portail) : les lire une à une. Points à surveiller chez nous : aucun
transfert d'argent (§ 3), aucune génération d'image, de vidéo ou d'audio, documentation publique en ligne.

---

## 2. Critères de revue : où en est Cortex

| Critère (review-criteria) | État | Où c'est vérifié |
|---|---|---|
| Chaque outil a un `title` et les indications applicables | ✓ les 4 indications, explicites, sur les 15 outils | `tests/mcp-identity.test.ts` |
| `readOnlyHint: true` pour la lecture | ✓ 7 outils de lecture | idem |
| `destructiveHint: true` pour ce qui modifie ou supprime | ✓ voir ci-dessous | idem |
| Noms d'outils ≤ 64 caractères, sans injection dans les descriptions | ✓ | idem |
| Erreurs exploitables (pas de message générique) | ✓ codes `_meta["com.cortexexam/error"]` + message précis (solde, quota, cours introuvable, format manquant) ; générique seulement pour une panne interne | `tests/mcp-tools.test.ts` |
| Authentification standard, sans secret à saisir | ✓ CIMD + DCR | `tests/mcp-oauth*.test.ts`, sonde |
| Documentation publique à la date de publication | en cours (landing `/mcp`) | § 0 |

**`destructiveHint`, décision expliquée.** La règle de Claude dit « true pour les outils qui modifient ou
suppriment des données ». Sont à `true` : les quatre outils payants (une dépense de crédits ne se défait pas),
`set_exam_format` (remplace ou efface le format déclaré) et `report_question` (retire la question des
révisions). Restent à `false` : `create_course` et `add_course_source`, des ajouts purs qui ne modifient ni ne
suppriment rien d'existant (un code de cours déjà pris est refusé, un fichier homonyme reçoit un suffixe). C'est
aussi la règle de ChatGPT (« false only for additive writes »), donc une seule politique pour les deux annuaires.

---

## 3. Point à faire valider : « Transfer money, cryptocurrency, or other financial assets »

Les outils payants dépensent des **crédits Cortex prépayés**, achetés dans l'app (Stripe), jamais dans
Claude. Ce n'est pas un transfert d'actif financier : pas de paiement, pas de virement, pas de solde
retirable. Le serveur ne vend rien (instructions : « this server never sells credits nor handles
payments ») et, depuis cette PR, un refus pour solde insuffisant ne contient plus de lien d'achat. Si le
relecteur hésite, l'écrire dans le champ libre de la soumission ; en cas de doute avant de soumettre,
demander à mcp-review@anthropic.com.

---

## 4. Compte de test pour le relecteur (voie retenue : mot de passe réservé à la revue)

Le relecteur Claude demande un compte de test par e-mail (escalade automatique vers « Verified », voir § 5).
**Même compte pour ChatGPT** (`annuaire-chatgpt.md`, § 5), qui exige un identifiant et un mot de passe : ni lien
magique, ni code par e-mail, ni double authentification, ni inscription.

**Voie retenue (décision de l'éditeur, 16/11) : connexion par mot de passe réservée à la revue** (`lib/review-login`).
Un compte Google dédié a été écarté : Google défie souvent une connexion depuis un appareil inconnu, ce qui ferait
échouer la revue. La connexion relecteur :

- n'existe que si `REVIEW_LOGIN_EMAIL` et `REVIEW_LOGIN_PASSWORD_HASH` sont posées (sinon : aucun fournisseur, aucun
  champ, aucune route) ; sur `/login`, un lien discret « Accès relecteur » ouvre un formulaire e-mail + mot de passe ;
- ouvre ce **seul** compte : une autre adresse est refusée même avec le bon mot de passe, et ce chemin ne crée aucun
  autre compte ; jamais propriétaire (une adresse ou un compte `CORTEX_OWNER_*` est refusé) ;
- est limitée à 5 essais par IP et 30 au total sur 15 minutes, journalisés sans mot de passe ni adresse saisie
  (`auth.review_login_refused`, `auth.review_login_ok`) ;
- se coupe toute seule à `REVIEW_LOGIN_UNTIL`, et sa coupure ferme aussi les sessions ouvertes par elle ;
- passe le parcours du connecteur : `/oauth/authorize` → `/login` → « Accès relecteur » → retour au consentement
  (`e2e/review-login.spec.ts`).

**Activer (Cowork, après fusion)** :

1. Mot de passe tiré au hasard (≥ 20 caractères), rangé dans « Comptes & accès (sensible) », jamais dans le dépôt.
2. Hash, saisi au clavier (jamais en argument) : `cd cortex && npx tsx scripts/review-password-hash.ts`.
3. Variables du service Railway : `REVIEW_LOGIN_EMAIL` (adresse du compte démo, une boîte de l'éditeur, pas la
   sienne), `REVIEW_LOGIN_PASSWORD_HASH` (la ligne affichée), `REVIEW_LOGIN_UNTIL` (fin de revue, ex.
   `2027-01-31T23:59:59Z`). Vérifier que `TRUST_PROXY=1` est posée : sans elle, la limite par IP devient globale.
4. Compte, crédits et cours, dans le conteneur de l'app :
   `cd /app/cortex && node_modules/.bin/tsx scripts/review-account.ts` (idempotent ; `--dry-run` pour voir).
   Il crée le compte, ajoute **20 crédits** par une ligne `review_grant` (une fois par lot, `--lot` pour un second
   lot), et le cours **DEMO-101 « Probabilités (démo) »**, examen dans 30 jours, avec un polycopié, une annale
   corrigée et une fiche d'examen **écrits pour la démo** (`scripts/review-demo/`, en anglais pour les relecteurs).
   Il ne lance pas la préparation.
5. Depuis le connecteur, connecté au compte démo : `prepare_course` sur DEMO-101 (devis puis confirmation), puis un
   examen blanc une fois, pour que `get_results` et `get_job_status` aient des données.

**Crédits.** Le compte démo n'est pas propriétaire : il paie en crédits, pour que le relecteur voie le devis puis la
confirmation. Les 20 crédits `review_grant` ne sont **pas** un revenu (le budget lié au revenu ne lit que les
paiements Stripe, vérifié par `tests/review-login.test.ts`) ; ils sont servis comme des crédits achetés, sinon un
compte sans paiement aurait un budget nul et la revue échouerait au premier devis. Coût réel borné par ces 20
crédits.

**Identifiants à donner au relecteur** : dans le champ prévu du formulaire de soumission, jamais dans ce dossier.

**Couper après la revue** :

1. Retirer `REVIEW_LOGIN_PASSWORD_HASH` (ou laisser `REVIEW_LOGIN_UNTIL` passer) : le lien disparaît, la connexion
   est refusée et les sessions ouvertes par elle tombent.
2. Révoquer les applications connectées du compte démo (page « Assistants » du compte, ou `DELETE` sur la route
   Applications connectées) : un jeton MCP déjà émis ne dépend pas de la session web.
3. Retirer `REVIEW_LOGIN_EMAIL`. Le compte et son cours restent ; les supprimer depuis la page du compte si besoin.

---

## 5. Badges : ce qu'ils veulent dire, honnêtement

- **Community** : libellé par défaut d'un connecteur accepté dans l'annuaire. Il dit que le connecteur a
  passé la revue de soumission, pas qu'Anthropic l'a audité en profondeur.
- **Verified** : obtenu par **escalade automatique** décidée côté Anthropic ; un relecteur écrit alors pour
  demander un compte de test. On ne le demande pas, on ne peut pas le garantir, et rien dans ce dossier ne doit
  le promettre (ni sur la landing).
- Aucun libellé ne change ce que voit l'utilisateur au consentement : c'est l'écran de Cortex qui décide.

---

## 6. Ce que l'éditeur doit faire lui-même

1. Choisir la raison sociale à afficher (support : `support@cortexexam.com`, décidé).
2. Choisir le mot de passe du compte démo et l'adresse `REVIEW_LOGIN_EMAIL` (§ 4) ; Cowork active le reste.
3. Soumettre dans https://claude.ai/directory/manage (compte Claude de l'éditeur) et cocher les engagements.
4. Répondre au relecteur si une escalade « Verified » arrive.
