/**
 * IDENTITÉ PUBLIQUE DU CONNECTEUR MCP — une seule source pour ce que les clients et
 * les annuaires affichent de Cortex : `serverInfo` (Implementation, spec 2026-07-28),
 * la carte du serveur (SEP-2127) et `server.json` (registre officiel, vérifié par
 * tests/mcp-identity.test.ts). Importé par proxy.ts : aucune dépendance lourde ici.
 *
 * `MCP_SERVER_NAME` ne change jamais : des clients s'en servent comme clé (préfixe
 * des outils, permissions mémorisées). Le nom du registre, lui, est un espace de
 * noms prouvé par le domaine (cortexexam.com).
 */

export const MCP_SERVER_NAME = "cortex";
export const MCP_REGISTRY_NAME = "com.cortexexam/cortex";
export const MCP_TITLE = "Cortex";
/** Version de l'interface publique du connecteur (outils, identité) ; suivie par server.json. */
export const MCP_SERVER_VERSION = "1.1.0";
/** ≤ 100 caractères : plafond du registre officiel et de la carte du serveur. */
export const MCP_DESCRIPTION = "Mock exams, practice questions and weak points from your own course materials in Cortex.";
/** Page publique (landing) : à quoi sert le connecteur, comment le brancher. */
export const MCP_WEBSITE_URL = "https://cortexexam.com/mcp";
export const MCP_PRIVACY_URL = "https://cortexexam.com/privacy-en";
export const MCP_TERMS_URL = "https://cortexexam.com/terms-en";
export const MCP_REPOSITORY = { url: "https://github.com/Benabens/cortex", source: "github", subfolder: "cortex" } as const;
/** Origine de production : celle que portent server.json et les dossiers d'annuaires. */
export const MCP_PROD_ORIGIN = "https://app.cortexexam.com";

/**
 * Versions du protocole servies par /mcp : l'ère 2026-07-28 (enveloppe par requête)
 * et l'ère `initialize` depuis le premier Streamable HTTP. Tenue à jour avec le SDK
 * par le test d'identité.
 */
export const MCP_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"] as const;

/** Fichiers statiques de public/ (tuile sombre, lisible sur fond clair comme sombre). */
export const MCP_ICON_PATHS = ["/mcp-icon.svg", "/mcp-icon-512.png", "/mcp-icon-128.png", "/mcp-icon-64.png"] as const;
/**
 * Carte du serveur : `<url MCP>/server-card` est l'emplacement recommandé par
 * SEP-2127 ; `/.well-known/mcp/server-card.json` est le chemin que cherchent les
 * outils de découverte antérieurs au SEP. Même document aux deux adresses.
 */
export const MCP_CARD_PATHS = ["/mcp/server-card", "/.well-known/mcp/server-card.json"] as const;

export type McpIcon = { src: string; mimeType: string; sizes: string[] };

/** PNG d'abord : tout client qui affiche des icônes doit lire le PNG, le SVG est facultatif. */
export function mcpIcons(origin: string): McpIcon[] {
  return [
    { src: `${origin}/mcp-icon-512.png`, mimeType: "image/png", sizes: ["512x512"] },
    { src: `${origin}/mcp-icon-128.png`, mimeType: "image/png", sizes: ["128x128"] },
    { src: `${origin}/mcp-icon-64.png`, mimeType: "image/png", sizes: ["64x64"] },
    { src: `${origin}/mcp-icon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
  ];
}

export function mcpUrl(origin: string): string {
  return `${origin}/mcp`;
}

/** `serverInfo` rendu à l'initialisation (ère 2025) et à server/discover (ère 2026-07-28). */
export function serverInfo(origin: string) {
  return {
    name: MCP_SERVER_NAME,
    title: MCP_TITLE,
    version: MCP_SERVER_VERSION,
    description: MCP_DESCRIPTION,
    websiteUrl: MCP_WEBSITE_URL,
    // Sans origine connue (cas théorique : requête sans émetteur), pas d'icône plutôt qu'une URL relative.
    ...(origin ? { icons: mcpIcons(origin) } : {}),
  };
}

/** Clé `_meta` de la carte : ce qu'il faut savoir avant de se connecter, hors champs du SEP. */
export const CARD_META_KEY = "com.cortexexam/connection";

/**
 * Carte du serveur (SEP-2127, schéma v1). Elle ne liste PAS les outils : le SEP
 * les exclut à dessein (ils se lisent par `tools/list`, après connexion). Les
 * informations de connexion propres à Cortex vont dans `_meta`.
 */
export function serverCard(origin: string) {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    name: MCP_REGISTRY_NAME,
    version: MCP_SERVER_VERSION,
    title: MCP_TITLE,
    description: MCP_DESCRIPTION,
    websiteUrl: MCP_WEBSITE_URL,
    repository: { ...MCP_REPOSITORY },
    icons: mcpIcons(origin),
    remotes: [{ type: "streamable-http" as const, url: mcpUrl(origin), supportedProtocolVersions: [...MCP_PROTOCOL_VERSIONS] }],
    _meta: {
      [CARD_META_KEY]: {
        authorization: "oauth2",
        authorization_server: origin,
        protected_resource_metadata: `${origin}/.well-known/oauth-protected-resource/mcp`,
        client_registration: ["client_id_metadata_document", "dynamic_client_registration"],
        api_key: false,
        documentation: MCP_WEBSITE_URL,
        privacy_policy: MCP_PRIVACY_URL,
        terms_of_service: MCP_TERMS_URL,
        tools_listing: "tools/list after sign-in; free read tools, paid tools quote their cost in credits and wait for the user's confirmation",
      },
    },
  };
}

/** `server.json` du registre officiel MCP, tel qu'il doit figurer à la racine de cortex/. */
export function registryServerJson() {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    name: MCP_REGISTRY_NAME,
    title: MCP_TITLE,
    description: MCP_DESCRIPTION,
    version: MCP_SERVER_VERSION,
    websiteUrl: MCP_WEBSITE_URL,
    repository: { ...MCP_REPOSITORY },
    icons: mcpIcons(MCP_PROD_ORIGIN),
    remotes: [{ type: "streamable-http", url: mcpUrl(MCP_PROD_ORIGIN) }],
  };
}
