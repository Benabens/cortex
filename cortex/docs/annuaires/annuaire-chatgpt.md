# Dossier : ChatGPT (plugins)

Rédigé le 16/11/2026. Chez OpenAI, les « apps » s'appellent désormais **plugins**. Sources :

- ajout par un utilisateur : https://developers.openai.com/apps-sdk/deploy/connect-chatgpt
- soumission à l'annuaire : https://developers.openai.com/apps-sdk/deploy/submission
- règles de revue : https://developers.openai.com/plugins/plugin-guidelines
- format du paquet : https://developers.openai.com/plugins/build/plugins

Deux usages distincts : **n'importe qui peut déjà brancher Cortex** comme serveur MCP personnalisé (rien à
soumettre), et **la publication dans l'annuaire** demande une soumission relue.

---

## 1. Brancher Cortex sans soumission (dès que MCP_ENABLED=1 en prod)

chatgpt.com → **Plugins** → **+** → **Add custom MCP server** → nom « Cortex » → **Connection** : URL
`https://app.cortexexam.com/mcp`, authentification OAuth → « I understand and want to continue » → **Create as
a plugin**. ChatGPT ouvre l'écran de consentement de Cortex, qui affiche « ChatGPT · chatgpt.com » (client
reconnu). Selon l'offre et l'espace de travail, l'ajout de serveurs personnalisés peut être réservé (mode
développeur, administrateur d'un espace Business/Enterprise) : c'est écrit sur la page Assistants.

## 2. Écarts ChatGPT trouvés et corrigés dans cette PR

| Écart | Effet avant | Correctif |
|---|---|---|
| Le document CIMD de ChatGPT (`https://chatgpt.com/oauth/client.json`) déclare `token_endpoint_auth_method: private_key_jwt` | client refusé, connexion impossible en CIMD | accepté quand `none` figure dans `token_endpoint_auth_methods_supported` (c'est le cas) ; Cortex reste un serveur à clients publics, PKCE obligatoire |
| ChatGPT s'identifie au point de jeton par `client_assertion` seule, sans `client_id` | `invalid_client` | identifiant lu dans l'assertion (`sub`, sinon `iss`) ; la sécurité repose sur PKCE et le retour enregistré, comme pour tout client public |
| Retours `https://chatgpt.com/connector/oauth/<id>` | refusés à l'enregistrement | acceptés et reconnus |
| Origine `https://chatgpt.com` absente du CORS | appels depuis le navigateur bloqués | ajoutée (avec claude.ai, claude.com, vscode.dev) |
| Consentement : « Claude Code » écrit en dur, rien pour reconnaître ChatGPT ni repérer une imitation | | « ChatGPT · chatgpt.com » quand le retour ou le CIMD le prouvent ; une application qui se nomme « ChatGPT » sans venir de chatgpt.com est signalée |
| Refus « solde insuffisant » : « Acheter : https://app.cortexexam.com/compte#credits » renvoyé à l'assistant | lien vers un paiement, interdit par les règles | le lien est retiré de tout message d'erreur d'outil ; l'app web le garde |
| Métadonnées OAuth sans documentation, politique ni conditions | | `service_documentation`, `op_policy_uri`, `op_tos_uri`, `resource_documentation`… |

Vérifié par `tests/mcp-oauth-clients.test.ts` et la sonde (`--preset chatgpt,chatgpt-cimd`), jamais contre la
prod depuis ce chantier.

## 3. Règles de revue : où en est Cortex

| Règle (plugin-guidelines) | État |
|---|---|
| Les trois indications `readOnlyHint`, `destructiveHint`, `openWorldHint` en booléens explicites, justes | ✓ sur les 15 outils (plus `idempotentHint`) ; test bloquant |
| `destructiveHint: true` pour les effets irréversibles, `false` seulement pour les ajouts purs | ✓ payants, `set_exam_format`, `report_question` à `true` ; `create_course`, `add_course_source` à `false` |
| Descriptions exactes, sans incitation à appeler l'outil ni consigne cachée | ✓ test anti-injection et anti-marketing |
| **Pas de vente de produits numériques** (abonnements, crédits, jetons) | ✓ le plugin ne vend rien et ne contient plus de lien d'achat ; il dépense des crédits déjà achetés dans l'app, après accord dans la conversation |
| Pas de lien direct vers un paiement | ✓ voir § 2 ; reste `get_account_status` qui renvoie un lien vers `/compte#usage` (page d'usage, pas de paiement : à expliquer si le relecteur demande) |
| Politique de confidentialité : catégories, finalités, destinataires, durées | `https://cortexexam.com/privacy-en` : catégories, finalités, sous-traitants (dont Anthropic) et durées présents ; à relire par l'éditeur avant soumission |
| Convenable pour les 13-17 ans | ✓ outil d'étude, aucun contenu sensible |
| Compte de démo complet, **identifiant + mot de passe**, sans inscription, sans 2FA, sans lien magique | ✗ **bloquant** : Cortex se connecte par Google (ou lien e-mail). Voir § 5 |

## 4. Champs de soumission (platform.openai.com/plugins)

Le paquet est prêt dans `docs/annuaires/chatgpt-plugin/` (`plugin.json`, `mcp.json`), d'après le format
documenté ; `plugin.json` et `mcp.json` validés contre les schémas agent-plugins 1.0.0, à l'exception du bloc
`extensions["com.openai"].auth` de `mcp.json` que la doc d'OpenAI place dans le serveur alors que le schéma
générique ne le prévoit pas (la doc d'OpenAI fait foi pour ChatGPT). Restent à remplir les `TODO` (raison
sociale, vidéo).

| Champ | Limite | Valeur |
|---|---|---|
| Display Name | 30 | `Cortex` |
| Short Description | 30 | `Mock exams from your courses` (28) |
| Long Description | 4000 | dans `plugin.json` (≈ 1 200 caractères) |
| Developer Name | 80 | raison sociale de l'éditeur |
| Category | | Education |
| Website / Support | https | `https://cortexexam.com/mcp` (support : page publique avec l'adresse de contact) |
| Privacy / Terms | https | `https://cortexexam.com/privacy-en`, `https://cortexexam.com/terms-en` |
| Logo | carré ≥ 48 px | `public/mcp-icon-512.png` copié en `assets/logo.png` |
| Couleur | | `#2764EC` (accent de l'app) |
| Prompts par défaut | 3 × 128 | dans `plugin.json` |
| Cas de test | 5 positifs, 3 négatifs | dans `plugin.json` (`review.test_cases`) |
| Commerce | | `false`, avec l'explication dans `commerce_description` |
| Pays | | à choisir (la France et la Suisse au minimum) |
| Traductions | | fr-FR possible plus tard : la page et l'app sont en français |

Construire le ZIP (fichiers à la racine de l'archive) :

```
cd docs/annuaires/chatgpt-plugin
mkdir -p assets && cp ../../../public/mcp-icon-512.png assets/logo.png
zip -r ../cortex-chatgpt-plugin.zip plugin.json mcp.json assets
```

Les cas de test supposent le compte démo du § 5 (cours `DEMO-101`). Le cas « generate_drill » montre le devis
(0,1 crédit par défaut) puis la question après un « oui ».

## 5. Compte de démo : l'écart à trancher (l'éditeur)

La revue ChatGPT exige un identifiant et un mot de passe utilisables tels quels : **pas de lien magique, pas de
code par e-mail, pas de 2FA, pas d'inscription**. La connexion Google d'un compte dédié peut passer, mais Google
défie souvent une connexion depuis un appareil inconnu (code sur téléphone), ce qui ferait échouer la revue.

Recommandation : une **connexion par mot de passe réservée à la revue**, dans une PR séparée (changement
d'authentification, audit `prelaunch`) : fournisseur « Credentials » activé seulement si
`REVIEW_LOGIN_EMAIL` et `REVIEW_LOGIN_PASSWORD_HASH` sont posées, valable pour ce seul compte, limité en débit,
retiré après la revue. Cours et crédits du compte : comme pour Claude (`annuaire-claude.md`, § 4), même compte
pour les deux revues. **Non créé dans cette PR**, comme demandé.

## 6. Ce que l'éditeur doit faire lui-même

1. Faire vérifier l'organisation OpenAI (individuelle ou entreprise, au nom de l'éditeur) ; soumettre depuis le
   compte propriétaire ou un membre avec « Apps Management Write ».
2. Trancher la connexion du relecteur (§ 5), puis créer le compte démo (identifiants saisis à part, jamais dans
   le paquet ni dans le dépôt).
3. Enregistrer une **vidéo de démo** (connexion, consentement, liste des cours, devis puis génération) et mettre
   son URL dans `demo_recording_url`.
4. Remplir les `TODO` de `plugin.json` (raison sociale), relire la politique de confidentialité, choisir les
   pays.
5. Construire le ZIP (§ 4), le téléverser sur platform.openai.com/plugins, remplir les identifiants relecteur.
6. Savoir qu'OpenAI rescanne le serveur chaque jour : un outil ajouté ou une description changée se relit.

Non vérifié : la page du format de manifeste citée en premier par OpenAI (`/plugins/build/manifest`) renvoyait
404 le 16/11 ; le format ci-dessus vient de `/plugins/build/plugins`. Vérifier au moment de soumettre.
