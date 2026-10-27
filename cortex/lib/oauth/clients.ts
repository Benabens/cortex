import dns from "node:dns";
import https from "node:https";
import net from "node:net";
import { authGet, authRun } from "@/db/auth-store";
import { nowStr } from "@/db/q";
import { newId } from "./secrets";

/**
 * CLIENTS OAUTH du connecteur MCP. Deux façons d'en être un :
 *
 *  - CIMD (Client ID Metadata Document) : le client_id EST une URL https ; ses
 *    métadonnées sont lues à cette adresse. Voie recommandée par la spec MCP :
 *    l'identité du client est son domaine, rien à enregistrer.
 *  - DCR (RFC 7591) : POST /oauth/register, le client reçoit un client_id
 *    aléatoire. Voie de compatibilité (clients qui ne font pas de CIMD).
 *
 * Dans les deux cas, AUCUNE confiance n'est accordée au nom déclaré : l'écran de
 * consentement affiche l'hôte de l'URL de retour, et l'URL de retour d'une
 * demande doit correspondre EXACTEMENT à une URL enregistrée (seule exception :
 * le port d'une adresse de bouclage, RFC 8252 §7.3).
 */

/**
 * Client OAuth PUBLIC (PKCE) — les seuls servis : Claude, comme tous les clients
 * MCP connus, n'a pas de secret (spec MCP : DCR et CIMD = clients publics). Ne
 * pas émettre de secret, c'est une surface d'attaque en moins.
 */
export type OAuthClient = {
  clientId: string;
  kind: "dcr" | "cimd";
  name: string | null;
  uri: string | null;
  redirectUris: string[];
};

export class ClientRegistrationError extends Error {
  constructor(readonly code: "invalid_redirect_uri" | "invalid_client_metadata", message: string) {
    super(message);
    this.name = "ClientRegistrationError";
  }
}

const MAX_REDIRECT_URIS = 10;
const MAX_URI_LENGTH = 2000;
const MAX_NAME_LENGTH = 100;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Une URL de retour acceptable : https, ou http sur une adresse de bouclage
 * (clients natifs, RFC 8252). Jamais de fragment ni d'identifiants dans l'URL.
 * Renvoie un message d'erreur, ou null si l'URL est acceptable.
 */
export function redirectUriProblem(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.length > MAX_URI_LENGTH) return "URL de retour absente ou trop longue";
  let u: URL;
  try { u = new URL(raw); } catch { return "URL de retour invalide"; }
  if (u.hash) return "fragment interdit dans une URL de retour";
  if (u.username || u.password) return "identifiants interdits dans une URL de retour";
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname)) return null;
  return "seules les URL https (ou http sur localhost) sont acceptées";
}

/**
 * Correspondance d'une URL de retour demandée avec celles du client : égalité
 * exacte, sauf le PORT d'une adresse de bouclage (le client natif l'ouvre au
 * moment de la connexion — RFC 8252 §7.3).
 */
export function redirectUriMatches(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let req: URL;
  try { req = new URL(requested); } catch { return false; }
  if (req.protocol !== "http:" || !LOOPBACK_HOSTS.has(req.hostname)) return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return u.protocol === "http:" && u.hostname === req.hostname && u.pathname === req.pathname && u.search === req.search;
    } catch { return false; }
  });
}

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

/** URL https facultative (client_uri) : ignorée si invalide plutôt que refusée. */
function httpsUrl(v: unknown): string | null {
  const s = str(v, MAX_URI_LENGTH);
  if (!s) return null;
  try { return new URL(s).protocol === "https:" ? s : null; } catch { return null; }
}

function parseRedirectUris(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new ClientRegistrationError("invalid_redirect_uri", "redirect_uris : au moins une URL de retour est requise.");
  }
  if (v.length > MAX_REDIRECT_URIS) {
    throw new ClientRegistrationError("invalid_redirect_uri", `redirect_uris : ${MAX_REDIRECT_URIS} URL au maximum.`);
  }
  return v.map((u) => {
    const problem = redirectUriProblem(u);
    if (problem) throw new ClientRegistrationError("invalid_redirect_uri", `redirect_uris : ${problem}.`);
    return u as string;
  });
}

/** Les deux seuls flux servis : code d'autorisation (+ refresh). */
function assertGrantAndResponseTypes(meta: Record<string, unknown>): void {
  const grants = meta.grant_types ?? ["authorization_code"];
  if (!Array.isArray(grants) || !grants.includes("authorization_code") || grants.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
    throw new ClientRegistrationError("invalid_client_metadata", "grant_types : seuls authorization_code et refresh_token sont servis.");
  }
  const responses = meta.response_types ?? ["code"];
  if (!Array.isArray(responses) || responses.some((r) => r !== "code")) {
    throw new ClientRegistrationError("invalid_client_metadata", "response_types : seul « code » est servi.");
  }
}

// ───────────────────────────── DCR (RFC 7591) ─────────────────────────────

export type RegisteredClient = { client: OAuthClient; issuedAt: number };

/**
 * Enregistrement dynamique, toujours en client PUBLIC : une demande de secret
 * (client_secret_post/basic) est ramenée à « none » — RFC 7591 §3.2.1 laisse le
 * serveur remplacer une valeur de métadonnée, et le client suit ce qu'on lui
 * renvoie. PKCE fait le travail qu'aurait fait le secret.
 */
export async function registerClient(meta: unknown): Promise<RegisteredClient> {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new ClientRegistrationError("invalid_client_metadata", "Corps JSON attendu.");
  }
  const m = meta as Record<string, unknown>;
  const redirectUris = parseRedirectUris(m.redirect_uris);
  assertGrantAndResponseTypes(m);
  const client: OAuthClient = {
    clientId: newId("cx_client"),
    kind: "dcr",
    name: str(m.client_name, MAX_NAME_LENGTH),
    uri: httpsUrl(m.client_uri),
    redirectUris,
  };
  await purgeUnusedDcrClients();
  await authRun(
    `INSERT INTO oauth_clients (client_id, kind, client_name, client_uri, redirect_uris, created_at, refresh_after) VALUES (?,?,?,?,?,?,NULL)`,
    client.clientId, "dcr", client.name, client.uri, JSON.stringify(redirectUris), nowStr(),
  );
  return { client, issuedAt: Math.floor(Date.now() / 1000) };
}

/**
 * Un client DCR jamais autorisé au bout de 7 jours est supprimé : l'enregistrement
 * est ouvert à tous, il ne doit pas laisser grossir la table indéfiniment.
 */
async function purgeUnusedDcrClients(): Promise<void> {
  await authRun(
    `DELETE FROM oauth_clients WHERE kind = 'dcr' AND created_at < ?
       AND client_id NOT IN (SELECT client_id FROM oauth_grants)`,
    nowStr(-7 * 86400_000),
  );
}

// ───────────────────────────── CIMD ─────────────────────────────

/** Un client_id CIMD : URL https avec un chemin (draft-ietf-oauth-client-id-metadata-document). */
export function isCimdClientId(clientId: string): boolean {
  try {
    const u = new URL(clientId);
    return u.protocol === "https:" && u.pathname !== "/" && !u.hash && !u.username && !u.password;
  } catch { return false; }
}

/** Récupère le document de métadonnées d'un client CIMD (port injectable pour les tests). */
export type MetadataFetcher = (url: string) => Promise<{ body: string; maxAgeS: number | null }>;

const CIMD_MAX_BYTES = 5 * 1024;
const CIMD_TIMEOUT_MS = 5000;
const CIMD_MIN_CACHE_S = 300;
const CIMD_MAX_CACHE_S = 86400;

/**
 * Adresse joignable depuis Internet ? Refuse bouclage, privé (RFC 1918, ULA),
 * lien local, CGNAT, multicast, non spécifié et adresses de documentation : un
 * client_id CIMD ne doit pas faire lire au serveur son propre réseau interne (SSRF).
 */
export function isPublicAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 169 && b === 254) return false; // lien local (dont métadonnées cloud)
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false; // 192.0.0.0/24 et 192.0.2.0/24
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
    if (a === 203 && b === 0) return false;
    return true;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    if (low === "::" || low === "::1") return false;
    if (/^f[cd]/.test(low)) return false; // ULA fc00::/7
    if (/^fe[89ab]/.test(low)) return false; // lien local fe80::/10
    if (low.startsWith("ff")) return false; // multicast
    if (low.startsWith("2001:db8")) return false; // documentation
    return true;
  }
  return false;
}

/**
 * Lecture HTTPS durcie : résolution DNS vérifiée AU MOMENT de la connexion (le
 * `lookup` de la requête — pas de fenêtre de « DNS rebinding » entre contrôle et
 * connexion), aucune redirection suivie, 5 s et 5 Ko au maximum.
 */
export const fetchClientMetadata: MetadataFetcher = (url) =>
  new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { accept: "application/json", "user-agent": "Cortex-OAuth/1.0" },
      timeout: CIMD_TIMEOUT_MS,
      lookup: (host, opts, cb) => {
        dns.lookup(host, { all: true }, (err, addrs) => {
          if (err) return cb(err, "", 4);
          const list = addrs as dns.LookupAddress[];
          if (!list.length || list.some((a) => !isPublicAddress(a.address))) {
            return cb(new Error("adresse non publique refusée"), "", 4);
          }
          const all = (opts as { all?: boolean }).all;
          if (all) return (cb as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
          cb(null, list[0].address, list[0].family);
        });
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let size = 0;
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > CIMD_MAX_BYTES) { req.destroy(new Error("document trop volumineux")); return; }
        chunks.push(c);
      });
      res.on("end", () => {
        const cc = String(res.headers["cache-control"] ?? "");
        const m = cc.match(/max-age=(\d+)/);
        resolve({ body: Buffer.concat(chunks).toString("utf8"), maxAgeS: m && !/no-store/.test(cc) ? Number(m[1]) : null });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("délai dépassé")));
    req.on("error", reject);
  });

/** Valide un document CIMD : il doit se désigner lui-même et déclarer des URL de retour valides. */
export function parseCimdDocument(clientId: string, body: string): OAuthClient {
  let m: Record<string, unknown>;
  try { m = JSON.parse(body); } catch { throw new ClientRegistrationError("invalid_client_metadata", "document de métadonnées illisible"); }
  if (!m || typeof m !== "object" || Array.isArray(m)) throw new ClientRegistrationError("invalid_client_metadata", "document de métadonnées illisible");
  if (m.client_id !== clientId) throw new ClientRegistrationError("invalid_client_metadata", "client_id du document différent de son adresse");
  if (!str(m.client_name, MAX_NAME_LENGTH)) throw new ClientRegistrationError("invalid_client_metadata", "client_name manquant dans le document");
  const redirectUris = parseRedirectUris(m.redirect_uris);
  assertGrantAndResponseTypes(m);
  const method = m.token_endpoint_auth_method ?? "none";
  // Un document public ne peut pas porter de secret partagé ; private_key_jwt n'est pas servi.
  if (method !== "none") throw new ClientRegistrationError("invalid_client_metadata", "seuls les clients publics (token_endpoint_auth_method « none ») sont acceptés en CIMD");
  return { clientId, kind: "cimd", name: str(m.client_name, MAX_NAME_LENGTH), uri: httpsUrl(m.client_uri), redirectUris };
}

type ClientRow = {
  client_id: string; kind: string; client_name: string | null; client_uri: string | null; redirect_uris: string; refresh_after: string | null;
};

function rowToClient(r: ClientRow): OAuthClient {
  return {
    clientId: r.client_id, kind: r.kind === "cimd" ? "cimd" : "dcr", name: r.client_name, uri: r.client_uri,
    redirectUris: JSON.parse(r.redirect_uris) as string[],
  };
}

/**
 * Client connu par son client_id, ou null. Un client CIMD est relu à son adresse
 * quand son cache expire (borné entre 5 min et 24 h) ; si la relecture échoue,
 * le client est refusé — jamais servi depuis un cache périmé.
 */
export async function findClient(clientId: string, fetcher: MetadataFetcher = fetchClientMetadata): Promise<OAuthClient | null> {
  if (!clientId || clientId.length > MAX_URI_LENGTH) return null;
  const row = await authGet<ClientRow>(`SELECT * FROM oauth_clients WHERE client_id = ?`, clientId);
  if (row && (row.kind !== "cimd" || (row.refresh_after && row.refresh_after > nowStr()))) return rowToClient(row);
  if (!isCimdClientId(clientId)) return row ? rowToClient(row) : null;
  let fetched: { body: string; maxAgeS: number | null };
  try { fetched = await fetcher(clientId); } catch { return null; }
  let client: OAuthClient;
  try { client = parseCimdDocument(clientId, fetched.body); } catch { return null; }
  const ttl = Math.min(CIMD_MAX_CACHE_S, Math.max(CIMD_MIN_CACHE_S, fetched.maxAgeS ?? 3600));
  const refreshAfter = nowStr(ttl * 1000);
  const uris = JSON.stringify(client.redirectUris);
  if (row) {
    await authRun(
      `UPDATE oauth_clients SET client_name = ?, client_uri = ?, redirect_uris = ?, refresh_after = ? WHERE client_id = ?`,
      client.name, client.uri, uris, refreshAfter, clientId,
    );
  } else {
    await authRun(
      `INSERT INTO oauth_clients (client_id, kind, client_name, client_uri, redirect_uris, created_at, refresh_after)
       VALUES (?,?,?,?,?,?,?) ON CONFLICT (client_id) DO NOTHING`,
      clientId, "cimd", client.name, client.uri, uris, nowStr(), refreshAfter,
    );
  }
  return client;
}
