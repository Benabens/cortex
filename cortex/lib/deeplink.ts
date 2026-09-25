import { DEFAULT_COURSE } from "@/lib/courses";

/**
 * LIEN clic→source UNIFIÉ (corpus). Une seule logique partout (recherche, faiblesses,
 * /programme) → plus aucun lien périmé/404.
 *  - CS-202 (historique, validé) : HTML → viewer `/voir` (déplie + surligne) ; brut → `/sites/<anchor>`.
 *  - Autres cours (ML/CS-233, Algo/CS-250) : route course-aware `/csrc` (repli basename), PDF
 *    ouvert à la BONNE page via le fragment `#page=N` lu de l'anchor.
 *
 * `sourcePath` = chemin RÉEL relatif de la source (ce que /csrc résout). `anchor` = sourcePath +
 * éventuel `#page=N` (ou ancre HTML pour cs-202).
 */
export function sourceHref(
  course: string,
  sourcePath: string,
  anchor: string,
  opts?: { itemId?: number; q?: string },
): string {
  if (course === DEFAULT_COURSE) {
    if (sourcePath.endsWith(".html")) {
      const item = opts?.itemId != null ? `&item=${opts.itemId}` : "";
      const q = opts?.q ? `&q=${encodeURIComponent(opts.q)}` : "";
      return `/voir?src=${encodeURIComponent(sourcePath)}${item}${q}`;
    }
    return `/sites/${anchor}`;
  }
  const frag = anchor.includes("#") ? "#" + anchor.split("#")[1] : "";
  return `/csrc?course=${encodeURIComponent(course)}&p=${encodeURIComponent(sourcePath)}${frag}`;
}
