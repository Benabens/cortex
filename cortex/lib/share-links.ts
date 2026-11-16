/**
 * LIENS DE PARTAGE (Google Drive, Docs, Slides, Dropbox) → adresse de téléchargement direct.
 * Le lien « …/view » donnait la page de visionneuse (texte : « Connexion »), rangée comme
 * support ; « uc?export=download » redirige, et la lecture durcie (lib/public-https) refuse les
 * redirections (audit ingestion du 16/11/2026). Module pur : réécriture d'adresse seulement.
 */
export type DirectLink = {
  url: string;
  /** le nom du fichier se lit dans l'adresse réécrite */
  named: boolean;
  /** lien de partage réécrit : sa redirection vers l'hôte de téléchargement du service est suivie */
  shared?: boolean;
};

/** Hôtes où Google et Dropbox servent le fichier d'un lien de partage (cible de leur redirection). */
const DOWNLOAD_HOSTS = /(^|\.)(googleusercontent\.com|drive\.usercontent\.google\.com|dropboxusercontent\.com)$/i;

/**
 * La cible d'une redirection d'un lien de partage réécrit, si c'est l'hôte de téléchargement du
 * service (https) ; null sinon. Chaque saut est relu par lib/public-https (adresse publique).
 */
export function sharedRedirectTarget(link: DirectLink, location: string | null): string | null {
  if (!link.shared || !location) return null;
  try {
    const u = new URL(location, link.url);
    return u.protocol === "https:" && DOWNLOAD_HOSTS.test(u.hostname) ? u.toString() : null;
  } catch { return null; }
}

export function directDownloadUrl(raw: string): DirectLink {
  let u: URL;
  try { u = new URL(raw); } catch { return { url: raw, named: true }; }
  const host = u.hostname.toLowerCase();
  if (host === "drive.google.com") {
    const id = u.pathname.match(/^\/file\/d\/([\w-]+)/)?.[1] ?? (u.pathname === "/open" || u.pathname === "/uc" ? u.searchParams.get("id") : null);
    if (id && /^[\w-]+$/.test(id)) return { url: `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`, named: false, shared: true };
  }
  if (host === "docs.google.com") {
    const m = u.pathname.match(/^\/(document|presentation)\/d\/([\w-]+)/);
    if (m) return { url: m[1] === "document" ? `https://docs.google.com/document/d/${m[2]}/export?format=pdf` : `https://docs.google.com/presentation/d/${m[2]}/export/pdf`, named: false, shared: true };
  }
  if (host === "www.dropbox.com" || host === "dropbox.com") {
    const direct = new URL(`https://dl.dropboxusercontent.com${u.pathname}`);
    for (const [k, v] of u.searchParams) if (k !== "dl" && k !== "raw") direct.searchParams.set(k, v);
    return { url: direct.toString(), named: true, shared: true };
  }
  return { url: raw, named: true };
}
