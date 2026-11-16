/**
 * CLIENTS MCP RECONNUS — une seule table pour le libellé affiché au consentement
 * et pour les origines de navigateur admises (lib/oauth/cors). Rien ici ne donne
 * un droit de plus : la reconnaissance ne remplace ni l'égalité exacte de l'URL de
 * retour, ni PKCE, ni le consentement. Elle sert à nommer l'application d'après ce
 * qui est VÉRIFIABLE, jamais d'après le nom qu'elle déclare :
 *
 *  - son client_id CIMD (le document est servi par le domaine du client) ;
 *  - ou son URL de retour https, égale à une adresse connue : le code n'est
 *    remis qu'à cette adresse, donc à ce client.
 *
 * Une URL de retour locale (localhost, 127.0.0.1) ne prouve rien : n'importe quel
 * programme du poste peut écouter ce port. Elle n'est jamais une preuve ici.
 *
 * Sources (16/11/2026) : documents CIMD publiés par Claude et ChatGPT ;
 * developers.openai.com/apps-sdk/build/auth (redirections de ChatGPT) ;
 * claude.com/docs/connectors (rappel https://claude.ai/api/mcp/auth_callback).
 */

export type KnownClient = {
  /** Nom montré à la personne. */
  label: string;
  /** Domaine qui le prouve (affiché à côté du nom). */
  domain: string;
  /** client_id CIMD publiés par l'éditeur. */
  cimd: RegExp[];
  /** URL de retour https qui n'appartiennent qu'à lui (égalité de la chaîne entière). */
  redirects: RegExp[];
  /** Origines de navigateur depuis lesquelles il peut appeler /mcp ou les points OAuth. */
  browserHosts: string[];
};

// Identifiant de rappel de ChatGPT : un segment de chemin, sans point ni barre.
const CALLBACK_ID = "[A-Za-z0-9_-]{1,128}";

export const KNOWN_CLIENTS: readonly KnownClient[] = [
  {
    label: "Claude",
    domain: "claude.ai",
    cimd: [/^https:\/\/claude\.ai\/oauth\/mcp-oauth-client-metadata$/],
    redirects: [/^https:\/\/claude\.(?:ai|com)\/api\/mcp\/auth_callback$/],
    browserHosts: ["claude.ai", "claude.com"],
  },
  {
    label: "Claude Code",
    domain: "claude.ai",
    cimd: [/^https:\/\/claude\.ai\/oauth\/claude-code-client-metadata$/],
    redirects: [],
    browserHosts: [],
  },
  {
    label: "ChatGPT",
    domain: "chatgpt.com",
    cimd: [/^https:\/\/chatgpt\.com\/oauth\/client\.json$/, new RegExp(`^https://chatgpt\\.com/oauth/${CALLBACK_ID}/client\\.json$`)],
    redirects: [/^https:\/\/chatgpt\.com\/connector_platform_oauth_redirect$/, new RegExp(`^https://chatgpt\\.com/connector/oauth/${CALLBACK_ID}$`)],
    browserHosts: ["chatgpt.com"],
  },
  {
    label: "VS Code",
    domain: "vscode.dev",
    cimd: [],
    redirects: [/^https:\/\/(?:insiders\.)?vscode\.dev\/redirect$/],
    browserHosts: ["vscode.dev", "insiders.vscode.dev"],
  },
];

/** Hôtes de navigateur des clients reconnus (pour la liste d'origines admises). */
export function knownBrowserHosts(): string[] {
  return KNOWN_CLIENTS.flatMap((c) => c.browserHosts);
}

/**
 * Client reconnu par son identité vérifiable, ou null. `clientId` n'est probant que
 * pour un client CIMD (`viaCimd`) : un client DCR choisit librement son nom, pas
 * son identifiant ni l'adresse où le code arrive.
 */
export function recognizeClient(opts: { clientId: string; viaCimd: boolean; redirectUri: string }): KnownClient | null {
  for (const c of KNOWN_CLIENTS) {
    if (opts.viaCimd && c.cimd.some((re) => re.test(opts.clientId))) return c;
    if (c.redirects.some((re) => re.test(opts.redirectUri))) return c;
  }
  return null;
}

/**
 * Nom déclaré qui imite un client connu (« ChatGPT », « Claude Desktop »…) sans en
 * avoir l'identité : le consentement le signale au lieu de l'afficher tel quel.
 */
export function impersonatedClient(declaredName: string | null): KnownClient | null {
  if (!declaredName) return null;
  const n = declaredName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!n) return null;
  const brands: [string, string][] = [["chatgpt", "ChatGPT"], ["openai", "ChatGPT"], ["claude", "Claude"], ["anthropic", "Claude"]];
  const hit = brands.find(([b]) => n.includes(b));
  return hit ? KNOWN_CLIENTS.find((c) => c.label === hit[1]) ?? null : null;
}
