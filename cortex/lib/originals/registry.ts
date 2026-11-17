import { nowStr, q } from "@/db/q";

/**
 * REGISTRE DES ORIGINAUX D'UN COMPTE GRATUIT, par cours (table `local_originals`).
 *
 * Une ligne par fichier dont l'original n'est pas gardé dans le cloud (lib/originals/policy) :
 *  - `transit` : il est encore sur le disque du serveur (jamais dans le seau), le temps de son
 *    indexation ; lib/originals/intake le supprime ensuite ;
 *  - `local`   : il n'est plus que sur l'ordinateur de l'étudiant ; Cortex garde son index.
 * `path` est le chemin dans le cours, celui de `sources.path` (« refs/final-2024.pdf »,
 * « lectures/cours-1.pdf ») ; `name` et `rel` le nom et le chemin d'origine sur l'ordinateur,
 * `sha256` et `size` l'empreinte qui permet de le retrouver (aperçu local, renvoi au cloud).
 * Origine : `upload` (déposé depuis l'app), `url` (lu par le serveur : `url` garde l'adresse
 * publique), `text` (texte collé via l'assistant), `purge` (original retiré du cloud à la fin
 * du Premium, lib/originals/retention).
 */

export type OriginalOrigin = "upload" | "url" | "text" | "purge";
export type OriginalState = "transit" | "local";

export type LocalOriginal = {
  path: string;
  name: string;
  rel: string | null;
  sha256: string;
  size: number;
  origin: OriginalOrigin;
  url: string | null;
  state: OriginalState;
  arrivedAt: string;
  purgedAt: string | null;
};

type Row = { path: string; name: string; rel: string | null; sha256: string; size: number | string; origin: string; url: string | null; state: string; arrived_at: string | null; purged_at: string | null };

const fromRow = (r: Row): LocalOriginal => ({
  path: r.path, name: r.name, rel: r.rel, sha256: r.sha256, size: Number(r.size) || 0,
  origin: r.origin as OriginalOrigin, url: r.url, state: r.state as OriginalState,
  arrivedAt: r.arrived_at ?? "", purgedAt: r.purged_at,
});

export async function ensureOriginalsSchema(): Promise<void> {
  await q.ensureTable("local_originals");
}

/** Un original vient d'arriver en transit (ou revient : renvoyé depuis l'ordinateur). */
export async function recordTransit(o: { path: string; name: string; rel?: string | null; sha256: string; size: number; origin: OriginalOrigin; url?: string | null }): Promise<void> {
  await ensureOriginalsSchema();
  await q.run(
    `INSERT INTO local_originals (path, name, rel, sha256, size, origin, url, state, arrived_at, purged_at) VALUES (?,?,?,?,?,?,?,'transit',?,NULL)
     ON CONFLICT(path) DO UPDATE SET name = excluded.name, rel = excluded.rel, sha256 = excluded.sha256, size = excluded.size,
       origin = excluded.origin, url = excluded.url, state = 'transit', arrived_at = excluded.arrived_at, purged_at = NULL`,
    o.path, o.name, o.rel ?? null, o.sha256, Math.round(o.size), o.origin, o.url ?? null, nowStr(),
  );
}

/** Original retiré du serveur : il ne reste que sur l'ordinateur (et son index chez Cortex). */
export async function recordLocal(o: { path: string; name: string; rel?: string | null; sha256: string; size: number; origin: OriginalOrigin; url?: string | null }): Promise<void> {
  await ensureOriginalsSchema();
  const now = nowStr();
  await q.run(
    `INSERT INTO local_originals (path, name, rel, sha256, size, origin, url, state, arrived_at, purged_at) VALUES (?,?,?,?,?,?,?,'local',?,?)
     ON CONFLICT(path) DO UPDATE SET state = 'local', purged_at = excluded.purged_at`,
    o.path, o.name, o.rel ?? null, o.sha256, Math.round(o.size), o.origin, o.url ?? null, now, now,
  );
}

export async function markLocal(path: string): Promise<void> {
  await ensureOriginalsSchema();
  await q.run(`UPDATE local_originals SET state = 'local', purged_at = ? WHERE path = ?`, nowStr(), path);
}

export async function localOriginal(path: string): Promise<LocalOriginal | null> {
  await ensureOriginalsSchema();
  const r = await q.get<Row>(`SELECT * FROM local_originals WHERE path = ?`, path);
  return r ? fromRow(r) : null;
}

export async function localOriginals(state?: OriginalState): Promise<LocalOriginal[]> {
  await ensureOriginalsSchema();
  const rows = state
    ? await q.all<Row>(`SELECT * FROM local_originals WHERE state = ? ORDER BY path`, state)
    : await q.all<Row>(`SELECT * FROM local_originals ORDER BY path`);
  return rows.map(fromRow);
}

/** Le fichier n'est plus concerné : source retirée, ou original rendu au cloud (Premium). */
export async function forgetOriginal(path: string): Promise<void> {
  await ensureOriginalsSchema();
  await q.run(`DELETE FROM local_originals WHERE path = ?`, path);
}
