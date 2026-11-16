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
| Compte de test pour le relecteur (section 4) | à préparer, **pas créé** | l'éditeur |
| Adresse de support publique (idéalement `@cortexexam.com`, pas une adresse personnelle) | à décider | l'éditeur |

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

**Support** : adresse de contact publique de Cortex (voir § 0).

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

## 4. Compte de test pour le relecteur (proposition, **non créé**)

Le relecteur Claude demande un compte de test par e-mail (escalade automatique vers « Verified », voir § 5).
Même compte pour ChatGPT (`annuaire-chatgpt.md`), qui pose des conditions plus strictes.

**Connexion.** Cortex se connecte par Google (lien e-mail en option). Deux voies :

1. **Compte Google dédié**, sans double authentification, récupération sur un téléphone de l'éditeur. Suffisant pour
   Claude en général ; risque : Google peut demander « est-ce bien vous ? » sur l'appareil du relecteur.
2. **Connexion par mot de passe réservée à la revue** (recommandée, obligatoire pour ChatGPT qui refuse lien
   magique et code par e-mail) : petite PR dédiée, fournisseur Auth.js « Credentials » actif seulement si
   `REVIEW_LOGIN_EMAIL` et `REVIEW_LOGIN_PASSWORD_HASH` sont posées, lié à ce seul compte, limité en débit, coupé
   après la revue. Non fait ici : un changement d'authentification mérite sa propre PR et l'audit `prelaunch`.

**Cours d'exemple, non identifiant.** Aucun contenu de cours réel (droits d'auteur, et le dépôt est public) :

- cours « DEMO-101 : Probabilités (démo) », examen fictif dans 30 jours ;
- 1 polycopié de 2 pages **écrit pour la démo** (variables aléatoires discrètes, espérance) ;
- 1 « annale » **écrite pour la démo** : 5 exercices corrigés, format « écrit, 2 h, sans documents » ;
- 1 fiche `exam_info` : « Written exam, 2 hours, no documents allowed ».

Création depuis l'app, ou depuis Claude Code avec le connecteur : `create_course`, `add_course_source`
(texte collé), `prepare_course`, puis un examen blanc généré une fois pour que `get_results` et
`get_job_status` aient des données.

**Crédits.** 20 crédits, pour que le relecteur voie le devis puis la confirmation (un compte propriétaire ne
paie rien et ne verrait pas ce parcours : ne **pas** utiliser `CORTEX_OWNER_*`). Soit l'éditeur achète le plus petit
pack sur ce compte, soit une ligne de grand livre ajoutée en production, depuis le conteneur de l'app
(idempotente grâce à la référence) :

```
npx tsx -e 'import("./lib/billing/credits").then(m => m.addTransaction("<id du compte démo>", 2000, "review_grant", "review-grant:2026-11"))'
```

(2000 = 20 crédits en centièmes. À vérifier avant : que le budget lié au revenu ne compte pas `review_grant`
comme un revenu.)

**Après la revue** : révoquer les applications connectées du compte, couper la connexion par mot de passe.

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

1. Choisir l'adresse de support publique et la raison sociale à afficher.
2. Trancher la connexion du relecteur (§ 4, voie 1 ou 2) et créer le compte démo.
3. Soumettre dans https://claude.ai/directory/manage (compte Claude de l'éditeur) et cocher les engagements.
4. Répondre au relecteur si une escalade « Verified » arrive.
