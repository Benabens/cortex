# Dossier : registre MCP officiel et annuaires secondaires

Rédigé le 16/11/2026. Sources : https://github.com/modelcontextprotocol/registry (docs
`modelcontextprotocol-io/authentication.mdx`, `reference/cli/commands.md`).

Le registre officiel (`registry.modelcontextprotocol.io`) est un **catalogue de métadonnées** : il dit où
trouver le serveur, il n'héberge rien et ne relit pas le code. Cortex y est publié sous le nom
**`com.cortexexam/cortex`**, ce qui demande de prouver qu'on contrôle le domaine `cortexexam.com`.

---

## 1. Ce qui est déjà dans le dépôt

- `server.json` à la racine de l'app : nom, titre, description (≤ 100), version, dépôt, site
  (`https://cortexexam.com/mcp`), icônes et `remotes` (Streamable HTTP, `https://app.cortexexam.com/mcp`).
- Il est **généré** depuis `lib/mcp/identity.ts` et vérifié par `tests/mcp-identity.test.ts` (égal au
  générateur, valide contre le schéma du registre 2025-12-11). Après un changement d'identité :
  ```
  npx tsx -e 'import("./lib/mcp/identity").then(m => console.log(JSON.stringify(m.registryServerJson(), null, 2)))' > server.json
  ```
- **Monter la version** (`MCP_SERVER_VERSION`) avant chaque nouvelle publication : le registre refuse de
  republier une version existante.

## 2. Clé et preuve de domaine (Cowork)

La preuve se fait par HTTP, au domaine **apex** : le fichier doit être servi à
`https://cortexexam.com/.well-known/mcp-registry-auth` (site landing, dépôt `cortex-landing`, pas l'app).

Générer la paire de clés, **hors de tout dépôt** (OpenSSL ≥ 3 ; le LibreSSL de macOS ne fait pas d'Ed25519 :
utiliser `$(brew --prefix openssl)/bin/openssl`) :

```
cd "$(mktemp -d)"
openssl genpkey -algorithm Ed25519 -out key.pem
PUBLIC_KEY="$(openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
echo "v=MCPv1; k=ed25519; p=${PUBLIC_KEY}" > mcp-registry-auth
```

- `mcp-registry-auth` (une ligne, clé **publique**) va dans le dépôt landing en
  `public/.well-known/mcp-registry-auth`, servi en `text/plain`, sans redirection. Vérifier :
  `curl -sS https://cortexexam.com/.well-known/mcp-registry-auth`.
- `key.pem` (clé **privée**) ne va dans aucun dépôt : la ranger dans `Comptes & accès (sensible)` ou le
  trousseau, puis effacer le dossier temporaire.

## 3. Publier (Cowork, depuis la racine de l'app sur `main` à jour)

```
brew install mcp-publisher
mcp-publisher validate server.json

MCP_PRIVATE_KEY="$(openssl pkey -in /chemin/vers/key.pem -noout -text | sed -n '/priv:/,/pub:/p' | sed '1d;$d' | tr -d ' :\n')" \
  mcp-publisher login http --domain cortexexam.com

mcp-publisher publish
```

- `MCP_PRIVATE_KEY` attend la clé privée en **hexadécimal** (64 caractères), d'où l'extraction ci-dessus ;
  passer par la variable d'environnement la garde hors de la ligne de commande visible des autres processus.
- `login` écrit un jeton dans `~/.config/mcp-publisher/token.json` ; `mcp-publisher logout` l'efface.
- Vérifier la fiche :
  `curl -sS "https://registry.modelcontextprotocol.io/v0/servers?search=com.cortexexam/cortex"`.
- Retirer une version : `mcp-publisher status --status deprecated com.cortexexam/cortex <version>`.

Prérequis : `MCP_ENABLED=1` en production, sinon la fiche pointe vers un serveur qui répond 404.

## 4. Annuaires secondaires

| Annuaire | Comment y figurer | Ce que veut dire son badge |
|---|---|---|
| **PulseMCP** | soumissions **suspendues** (pulsemcp.com/submit, 16/11) ; la page renvoie vers le registre officiel et reprendra ses fiches automatiquement | sans objet tant que c'est suspendu |
| **Glama** | **ingère le registre officiel** : rien à soumettre. Pour revendiquer la fiche (modifier le texte, voir les rapports) : se connecter avec GitHub, ou ajouter `glama.json` à la racine du dépôt : `{"$schema":"https://glama.ai/mcp/schemas/server.json","maintainers":["Benabens"]}` | « revendiqué » = on contrôle le dépôt, **pas** une revue de sécurité ; son score (TDQS) est une analyse automatique de Glama |
| **Smithery** | ajout d'un serveur distant par son URL sur smithery.ai/new ; exige un **401** (pas 403) sans jeton et la découverte RFC 9728 / RFC 8414, ce que Cortex fait. Docs de publication en 404 le 16/11 : vérifier le parcours au moment d'y aller | « Verified » = sous-ensemble relu par Smithery ; critères non documentés publiquement (non confirmé) |
| **mcp.so** | formulaire mcp.so/submit, catégorie « remote MCP server » (URL de l'adresse MCP) ; gratuit = relu avant publication | « verified » = **option payante** (39 $) qui publie sans relecture : ce n'est en rien une garantie de sécurité |

`glama.json` n'est pas ajouté dans cette PR : utile seulement si l'éditeur veut revendiquer la fiche, et le dépôt
contient l'app entière, pas seulement le serveur.

## 5. « Verified », honnêtement

- **Registre officiel** : aucun badge. Être publié sous `com.cortexexam/…` prouve **seulement** que l'éditeur
  contrôle `cortexexam.com` (c'est le sens du préfixe de domaine). Ni revue de code, ni audit de sécurité.
- **Annuaires secondaires** : voir le tableau. Aucun ne vaut audit ; on ne l'écrit nulle part (landing, page
  `/mcp`, soumissions).
- Les seules revues réelles sont celles de **l'annuaire Claude** et de **l'annuaire ChatGPT**
  (`annuaire-claude.md`, `annuaire-chatgpt.md`), et même là, le libellé dit qu'une revue a eu lieu, pas que
  Cortex est sans faille.
