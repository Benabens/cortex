/**
 * Clé d'ordre de cours d'un deep-link vers le support du prof. Module sans dépendance :
 * partagé par lib/program (tri « Par section ») et lib/course-plan (rattachement déterministe
 * des notions aux chapitres), qui ne peuvent pas s'importer mutuellement.
 */

/**
 * Dérive une CLÉ D'ORDRE DE COURS depuis un `course_href` (deep-link vers le passage de cours,
 * = « là où la notion est traitée », pas la 1re mention : courseHrefFor vise le meilleur hit de
 * matériel de cours). Signal principal = n° de lecture ; signal fin = page. Formats gérés :
 *   - ML / algo : /csrc?course=…&p=slides%2Flecture_12.pdf#page=31  → lecture 12, page 31
 *   - algo      : …p=…Lecture10withoutanim.pdf                      → lecture 10
 *   - cs-202    : …CS202_Lectures_Part2…#page=N (offset) ou index.html#chapN
 * Renvoie null si aucun signal (le topic finit en bas du tri « Par section »).
 */
export function courseOrderKey(courseHref: string | null | undefined): number | null {
  if (!courseHref) return null;
  const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
  const mP = courseHref.match(/[?&](?:p|src)=([^&#]+)/);
  const p = mP ? dec(mP[1]) : courseHref;
  const page = Number(courseHref.match(/#page=(\d+)/)?.[1] ?? 0) || 0;
  const mLec = p.match(/lect(?:ure)?[ _-]?0*(\d+)/i); // lecture_12 / Lecture10 / lecture 3
  if (mLec) return Number(mLec[1]) * 100000 + page;
  const mPart = p.match(/part[ _-]?0*(\d+)/i); // cs-202 : Part1 (L1-10) / Part2 (L11-18)
  if (mPart) return (Number(mPart[1]) <= 1 ? 1 : 11) * 100000 + page;
  const mChap = courseHref.match(/#(?:chap(?:ter)?[-_]?)?0*(\d+)/i); // index.html#chapN
  if (mChap) return Number(mChap[1]) * 100000 + page;
  return page > 0 ? 9_000_000 + page : null; // page seule = signal faible → en fin
}

/** N° de lecture porté par un deep-link de cours (null si le lien ne désigne pas une lecture). */
export function lectureOfCourseHref(courseHref: string | null | undefined): number | null {
  const key = courseOrderKey(courseHref);
  return key != null && key < 9_000_000 ? Math.floor(key / 100000) : null;
}
