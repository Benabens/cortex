/**
 * LIEN clic→source UNIFIÉ (corpus). Une seule logique partout (recherche, faiblesses,
 * /programme, sources) : la route course-aware `/csrc` (repli basename), PDF ouvert à la BONNE
 * page via le fragment `#page=N` lu de l'anchor.
 *
 * `sourcePath` = chemin RÉEL relatif de la source (ce que /csrc résout). `anchor` = sourcePath +
 * éventuel `#page=N`.
 *
 * Plus de `/voir` ni de `/sites` pour cs-202 : ces chemins du mono-user répondent 404 en
 * production (proxy.ts), et tous les liens « Voir » de ce cours y menaient.
 */
export function sourceHref(
  course: string,
  sourcePath: string,
  anchor: string,
): string {
  const frag = anchor.includes("#") ? "#" + anchor.split("#")[1] : "";
  return `/csrc?course=${encodeURIComponent(course)}&p=${encodeURIComponent(sourcePath)}${frag}`;
}

/**
 * Lien déjà ÉCRIT en base (plan_chapters.source_href, exam_exercises.exam_href / course_href,
 * bank_questions.exam_href) par une version qui produisait `/voir?src=…` ou `/sites/<anchor>` :
 * relu vers `/csrc`, le seul service de fichier présent en production. Tout autre lien passe tel quel.
 */
export function liveSourceHref(course: string, href: string | null): string | null {
  if (!href) return href;
  if (href.startsWith("/voir?")) {
    const src = new URLSearchParams(href.slice("/voir?".length)).get("src");
    return src ? sourceHref(course, src, src) : null;
  }
  if (href.startsWith("/sites/")) {
    const anchor = decodeURIComponent(href.slice("/sites/".length));
    return sourceHref(course, anchor.split("#")[0], anchor);
  }
  return href;
}
