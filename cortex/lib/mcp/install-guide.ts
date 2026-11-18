import { MCP_SERVER_NAME } from "./identity";
import { translator } from "@/lib/i18n/translate";
import type { Locale } from "@/lib/i18n/locale";

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
export function assistantPrompt(mcpUrl: string, locale: Locale = "fr"): string {
  const t = translator(locale);
  return [
    t("mcpInstall.prompt1"),
    t("mcpInstall.prompt2", { url: mcpUrl }),
    t("mcpInstall.prompt3", { name: MCP_SERVER_NAME }),
    t("mcpInstall.prompt4"),
    t("mcpInstall.prompt5"),
  ].join("\n");
}

export function clientGuides(mcpUrl: string, locale: Locale = "fr"): ClientGuide[] {
  const t = translator(locale);
  const mcpServers = json({ mcpServers: { [MCP_SERVER_NAME]: { url: mcpUrl } } });
  return [
    {
      id: "claude",
      name: "Claude",
      where: t("mcpInstall.claudeWhere"),
      steps: [
        { text: t("mcpInstall.claude1"), link: { href: "https://claude.ai/settings/connectors", label: t("mcpInstall.claudeLink") } },
        { text: t("mcpInstall.serverUrl"), code: mcpUrl },
        { text: t("mcpInstall.claude3") },
        { text: t("mcpInstall.claude4") },
      ],
      note: t("mcpInstall.claudeNote"),
    },
    {
      id: "chatgpt",
      name: "ChatGPT",
      where: t("mcpInstall.chatgptWhere"),
      steps: [
        { text: t("mcpInstall.chatgpt1"), link: { href: "https://chatgpt.com/plugins", label: t("mcpInstall.chatgptLink") } },
        { text: t("mcpInstall.chatgpt2"), code: mcpUrl },
        { text: t("mcpInstall.chatgpt3") },
        { text: t("mcpInstall.chatgpt4") },
      ],
      note: t("mcpInstall.chatgptNote"),
    },
    {
      id: "claude-code",
      name: "Claude Code",
      where: t("mcpInstall.terminal"),
      steps: [
        { text: t("mcpInstall.inTerminal"), code: `claude mcp add --transport http ${MCP_SERVER_NAME} ${mcpUrl}` },
        { text: t("mcpInstall.claudeCode2") },
      ],
    },
    {
      id: "cursor",
      name: "Cursor",
      where: t("mcpInstall.codeEditor"),
      steps: [
        { text: t("mcpInstall.cursor1"), link: { href: cursorInstallLink(mcpUrl), label: t("mcpInstall.addCursor") } },
        { text: t("mcpInstall.cursor2"), code: mcpServers },
        { text: t("mcpInstall.cursor3") },
      ],
    },
    {
      id: "vscode",
      name: "VS Code",
      where: t("mcpInstall.vscodeWhere"),
      steps: [
        { text: t("mcpInstall.oneClick"), link: { href: vscodeInstallLink(mcpUrl), label: t("mcpInstall.addVscode") } },
        { text: t("mcpInstall.vscode2"), code: `code --add-mcp '${json({ name: MCP_SERVER_NAME, type: "http", url: mcpUrl })}'` },
        { text: t("mcpInstall.vscode3") },
      ],
    },
    {
      id: "codex",
      name: "Codex CLI",
      where: t("mcpInstall.terminal"),
      steps: [
        { text: t("mcpInstall.inTerminal"), code: `codex mcp add ${MCP_SERVER_NAME} --url ${mcpUrl}` },
        { text: t("mcpInstall.thenLogin"), code: `codex mcp login ${MCP_SERVER_NAME}` },
      ],
    },
    {
      id: "gemini-cli",
      name: "Gemini CLI",
      where: t("mcpInstall.terminal"),
      steps: [
        { text: t("mcpInstall.inTerminal"), code: `gemini mcp add --transport http ${MCP_SERVER_NAME} ${mcpUrl}` },
        { text: t("mcpInstall.gemini2"), code: `/mcp auth ${MCP_SERVER_NAME}` },
      ],
      note: t("mcpInstall.geminiNote"),
    },
    {
      id: "other",
      name: t("mcpInstall.otherName"),
      where: "Windsurf, Zed, LM Studio…",
      steps: [
        { text: t("mcpInstall.other1"), code: mcpUrl },
        { text: t("mcpInstall.other2") },
        { text: t("mcpInstall.other3"), code: mcpServers },
      ],
      note: t("mcpInstall.otherNote"),
    },
  ];
}
