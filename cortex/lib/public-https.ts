import dns from "node:dns";
import https from "node:https";
import net from "node:net";

/**
 * LECTURE HTTPS D'UNE ADRESSE PUBLIQUE — la seule porte par laquelle le serveur
 * va chercher une URL fournie de l'extérieur (document CIMD d'un client OAuth,
 * support de cours ajouté par le connecteur MCP). Contre la SSRF :
 *  - https uniquement, sans identifiants dans l'URL ;
 *  - hôte écrit en IP littérale : vérifiée ici (Node ne passe pas par `lookup`
 *    pour une IP, le contrôle DNS ci-dessous ne la verrait pas) ;
 *  - nom d'hôte : TOUTES ses adresses vérifiées au moment même de la connexion
 *    (le `lookup` de la requête), donc pas de fenêtre de « DNS rebinding » ;
 *  - aucune redirection suivie (la cible d'une redirection n'est pas vérifiée) :
 *    elle est rapportée, à l'appelant de redemander l'adresse finale ;
 *  - taille et durée TOTALE bornées.
 */

/** Les 8 groupes de 16 bits d'une IPv6 (« :: » développé, IPv4 finale pointée convertie), ou null. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0];
  const dotted = s.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number);
    s = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail] : head;
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/** IPv4 portée par deux groupes de 16 bits. */
const v4of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * Adresse joignable depuis Internet ? Refuse bouclage, privé (RFC 1918, ULA),
 * lien local, CGNAT, multicast, non spécifié et adresses de documentation. Une
 * IPv4 portée par une IPv6 (mappée ::ffff:, compatible ::, NAT64 64:ff9b::,
 * 6to4 2002::) est jugée sur l'IPv4 qu'elle porte — le parseur d'URL écrit
 * `[::ffff:127.0.0.1]` en hexadécimal, `[::ffff:7f00:1]`.
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
  if (!net.isIPv6(ip)) return false;
  const g = ipv6Groups(ip);
  if (!g) return false;
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && (g[5] === 0xffff || g[5] === 0)) {
    if (g[5] === 0 && g[6] === 0) return false; // :: et ::1 (et le reste de ::/112)
    return isPublicAddress(v4of(g[6], g[7])); // mappée ou compatible
  }
  if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) return isPublicAddress(v4of(g[6], g[7])); // traduite ::ffff:0:0/96
  if (g[0] === 0x64 && g[1] === 0xff9b) return zeros(2, 6) && isPublicAddress(v4of(g[6], g[7])); // NAT64 (64:ff9b:1::/48 local : refusé)
  if (g[0] === 0x2002) return isPublicAddress(v4of(g[1], g[2])); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return false; // ULA fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return false; // lien local, site local
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x2001 && (g[1] === 0x0db8 || g[1] === 0)) return false; // documentation, Teredo
  if (g[0] === 0x0100 && zeros(1, 4)) return false; // 100::/64, à jeter
  return true;
}

export type PublicFetchFailure = "invalid_url" | "blocked" | "redirect" | "status" | "too_large" | "timeout" | "network";

export class PublicFetchError extends Error {
  constructor(readonly reason: PublicFetchFailure, message: string, readonly location: string | null = null) {
    super(message);
    this.name = "PublicFetchError";
  }
}

export type PublicResponse = { body: Buffer; contentType: string | null; cacheControl: string };
export type PublicFetchOptions = { maxBytes: number; timeoutMs: number; accept: string; userAgent: string };
export type PublicFetcher = (url: string, opts: PublicFetchOptions) => Promise<PublicResponse>;

export const readPublicHttps: PublicFetcher = (raw, opts) =>
  new Promise((resolve, reject) => {
    let u: URL;
    try { u = new URL(raw); } catch { return reject(new PublicFetchError("invalid_url", "adresse invalide")); }
    if (u.protocol !== "https:") return reject(new PublicFetchError("invalid_url", "seules les adresses https sont acceptées"));
    if (u.username || u.password) return reject(new PublicFetchError("invalid_url", "identifiants interdits dans l'adresse"));
    const literal = u.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(literal) && !isPublicAddress(literal)) return reject(new PublicFetchError("blocked", "adresse non publique refusée"));

    const req = https.get(u, {
      headers: { accept: opts.accept, "user-agent": opts.userAgent },
      timeout: opts.timeoutMs,
      lookup: (host, lookupOpts, cb) => {
        dns.lookup(host, { all: true }, (err, addrs) => {
          if (err) return cb(err, "", 4);
          const list = addrs as dns.LookupAddress[];
          if (!list.length || list.some((a) => !isPublicAddress(a.address))) {
            return cb(new PublicFetchError("blocked", "adresse non publique refusée"), "", 4);
          }
          const all = (lookupOpts as { all?: boolean }).all;
          if (all) return (cb as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
          cb(null, list[0].address, list[0].family);
        });
      },
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status !== 200) {
        res.resume();
        const location = typeof res.headers.location === "string" ? res.headers.location : null;
        return reject(status >= 300 && status < 400
          ? new PublicFetchError("redirect", `redirection (HTTP ${status})`, location)
          : new PublicFetchError("status", `HTTP ${status}`));
      }
      const declared = Number(res.headers["content-length"] ?? 0);
      if (declared > opts.maxBytes) { req.destroy(new PublicFetchError("too_large", "document trop volumineux")); return; }
      let size = 0;
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > opts.maxBytes) { req.destroy(new PublicFetchError("too_large", "document trop volumineux")); return; }
        chunks.push(c);
      });
      res.on("end", () => resolve({
        body: Buffer.concat(chunks),
        contentType: typeof res.headers["content-type"] === "string" ? res.headers["content-type"] : null,
        cacheControl: String(res.headers["cache-control"] ?? ""),
      }));
      res.on("error", reject);
    });
    // `timeout` ci-dessus n'est qu'un délai d'INACTIVITÉ : un serveur qui envoie un octet de temps en
    // temps tiendrait la requête indéfiniment. Ce minuteur borne la durée TOTALE.
    const deadline = setTimeout(() => req.destroy(new PublicFetchError("timeout", "délai dépassé")), opts.timeoutMs);
    req.on("close", () => clearTimeout(deadline));
    req.on("timeout", () => req.destroy(new PublicFetchError("timeout", "délai dépassé")));
    req.on("error", (e) => reject(e instanceof PublicFetchError ? e : new PublicFetchError("network", e.message.slice(0, 120))));
  });
