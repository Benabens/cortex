import { MCP_SERVER_NAME } from "./identity";

/**
 * MARCHE À SUIVRE PAR CLIENT — page « Connecter ton assistant » (/compte/assistants).
 * Données pures (testées : tests/mcp-install-guide.test.ts) ; la page ne fait que
 * les afficher. Vérifié dans la documentation de chaque éditeur le 16/11/2026 :
 *
 *  - Claude : support.claude.com (connecteurs personnalisés distants) ;
 *  - ChatGPT : developers.openai.com/apps-sdk/deploy/connect-chatgpt ;
 *  - Claude Code : claude mcp add --transport http (docs Claude Code) ;
 *  - Cursor : cursor.com/docs/mcp/install-links (config en base64, { url }) ;
 *  - VS Code : lien https://insiders.vscode.dev/redirect/mcp/install (celui que publie
 *    github/github-mcp-server), « MCP: Add Server », code --add-mcp ;
 *  - Codex : developers.openai.com/codex/mcp (codex mcp add --url, codex mcp login) ;
 *  - Gemini CLI : gemini mcp add --transport http, /mcp auth.
 *
 * Rien de propre à un client dans le serveur : chacun suit la même découverte OAuth.
 */

export type GuideStep = { text: string; code?: string; link?: { href: string; label: string } };
export type ClientGuide = {
  id: string;
  name: string;
  where: string;
  steps: GuideStep[];
  note?: string;
};

const json = (v: unknown) => JSON.stringify(v);

export function cursorInstallLink(mcpUrl: string): string {
  const config = Buffer.from(json({ url: mcpUrl }), "utf8").toString("base64");
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${MCP_SERVER_NAME}&config=${encodeURIComponent(config)}`;
}

export function vscodeInstallLink(mcpUrl: string): string {
  return `https://insiders.vscode.dev/redirect/mcp/install?name=${MCP_SERVER_NAME}&config=${encodeURIComponent(json({ type: "http", url: mcpUrl }))}`;
}

/** Consigne à coller dans n'importe quel assistant : tout ce qu'il faut pour se brancher seul. */
export function assistantPrompt(mcpUrl: string): string {
  return [
    "Connecte-toi à mon compte Cortex (mon application de révision d’examens).",
    `C’est un serveur MCP distant : adresse ${mcpUrl}, transport Streamable HTTP, connexion OAuth 2.1 (je me connecterai à Cortex dans le navigateur et j’autoriserai l’accès ; il n’y a aucune clé d’API à saisir).`,
    `Si tu peux ajouter un serveur MCP toi-même, ajoute-le sous le nom « ${MCP_SERVER_NAME} ». Sinon, dis-moi précisément où l’ajouter dans ton application.`,
    "Une fois connecté, appelle l’outil list_courses pour vérifier que tu vois mes cours.",
    "Avant tout outil payant (examen blanc, question d’entraînement, correction, préparation d’un cours), annonce-moi son coût en crédits et attends mon accord.",
  ].join("\n");
}

export function clientGuides(mcpUrl: string): ClientGuide[] {
  const mcpServers = json({ mcpServers: { [MCP_SERVER_NAME]: { url: mcpUrl } } });
  return [
    {
      id: "claude",
      name: "Claude",
      where: "claude.ai, application ordinateur et mobile",
      steps: [
        { text: "Dans Claude (web ou application ordinateur), ouvre Paramètres → Connecteurs, puis « Ajouter un connecteur personnalisé ».", link: { href: "https://claude.ai/settings/connectors", label: "Ouvrir les connecteurs de Claude" } },
        { text: "Nom : Cortex. URL du serveur :", code: mcpUrl },
        { text: "Laisse vides les champs d’identifiant OAuth (Client ID, Client Secret) : Claude s’enregistre seul." },
        { text: "Clique sur « Se connecter » : la page Cortex s’ouvre. Choisis ce que Claude peut faire, puis « Autoriser »." },
      ],
      note: "Sur mobile, ajoute d’abord le connecteur depuis le web ou l’ordinateur : il apparaît ensuite dans l’application. Offres Team et Enterprise : un administrateur l’ajoute dans les paramètres de l’organisation.",
    },
    {
      id: "chatgpt",
      name: "ChatGPT",
      where: "chatgpt.com et applications",
      steps: [
        { text: "Ouvre la page des plugins de ChatGPT, bouton +, puis « Add custom MCP server ».", link: { href: "https://chatgpt.com/plugins", label: "Ouvrir chatgpt.com/plugins" } },
        { text: "Nom : Cortex. Dans Connection, colle l’URL du serveur MCP :", code: mcpUrl },
        { text: "Authentification : OAuth. Lis l’avertissement, « I understand and want to continue », puis « Create as a plugin »." },
        { text: "ChatGPT ouvre la page Cortex : choisis ce qu’il peut faire, puis « Autoriser »." },
      ],
      note: "Selon ton offre ChatGPT et les règles de ton espace de travail, l’ajout d’un serveur MCP personnalisé peut ne pas être proposé.",
    },
    {
      id: "claude-code",
      name: "Claude Code",
      where: "terminal",
      steps: [
        { text: "Dans un terminal :", code: `claude mcp add --transport http ${MCP_SERVER_NAME} ${mcpUrl}` },
        { text: "Puis, dans Claude Code, tape /mcp, choisis cortex et « Authenticate » : le navigateur ouvre la page Cortex." },
      ],
    },
    {
      id: "cursor",
      name: "Cursor",
      where: "éditeur de code",
      steps: [
        { text: "Installe en un clic (Cursor doit être installé) :", link: { href: cursorInstallLink(mcpUrl), label: "Ajouter à Cursor" } },
        { text: "Ou ajoute à ~/.cursor/mcp.json :", code: mcpServers },
        { text: "Au premier usage, Cursor ouvre la page Cortex dans ton navigateur : autorise l’accès." },
      ],
    },
    {
      id: "vscode",
      name: "VS Code",
      where: "GitHub Copilot, mode agent",
      steps: [
        { text: "Installe en un clic :", link: { href: vscodeInstallLink(mcpUrl), label: "Ajouter à VS Code" } },
        { text: "Ou, dans la palette de commandes : « MCP: Add Server » → HTTP, puis colle l’adresse. En ligne de commande :", code: `code --add-mcp '${json({ name: MCP_SERVER_NAME, type: "http", url: mcpUrl })}'` },
        { text: "VS Code te demande de te connecter à Cortex au démarrage du serveur : autorise l’accès." },
      ],
    },
    {
      id: "codex",
      name: "Codex CLI",
      where: "terminal",
      steps: [
        { text: "Dans un terminal :", code: `codex mcp add ${MCP_SERVER_NAME} --url ${mcpUrl}` },
        { text: "Puis connecte-toi (le navigateur ouvre la page Cortex) :", code: `codex mcp login ${MCP_SERVER_NAME}` },
      ],
    },
    {
      id: "gemini-cli",
      name: "Gemini CLI",
      where: "terminal",
      steps: [
        { text: "Dans un terminal :", code: `gemini mcp add --transport http ${MCP_SERVER_NAME} ${mcpUrl}` },
        { text: "Puis, dans Gemini CLI, connecte-toi :", code: `/mcp auth ${MCP_SERVER_NAME}` },
      ],
      note: "Google ne documente pas l’ajout d’un serveur MCP personnalisé dans l’application Gemini grand public : passe par Gemini CLI.",
    },
    {
      id: "other",
      name: "Autre client MCP",
      where: "Windsurf, Zed, LM Studio…",
      steps: [
        { text: "Ajoute un serveur distant (HTTP, « Streamable HTTP ») avec l’adresse :", code: mcpUrl },
        { text: "Authentification : OAuth, sans clé ni identifiant à saisir : le client s’enregistre seul auprès de Cortex." },
        { text: "Format de configuration le plus courant (le nom du champ d’adresse varie : url, serverUrl ou httpUrl) :", code: mcpServers },
      ],
      note: "Un client qui ne gère que les serveurs locaux (stdio) ne peut pas se brancher directement sur Cortex.",
    },
  ];
}
