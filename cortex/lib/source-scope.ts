import { q } from "@/db/q";
import { normalize } from "@/lib/text";

/**
 * PÉRIMÈTRE DE LA MATIÈRE — les sources qui ne servent JAMAIS de matière aux questions
 * ni aux notions, quel que soit leur type : une note ou un support marqué « hors
 * programme » (par son titre ou le début de son texte), et les archives d'organisation
 * (thèmes des posters d'une année passée, exemple de rendu). HUM-285, job 12 du 13/11 :
 * 3 QCM sur 10 venaient de notes d'archive « Gillet 2025, hors programme 2026 » et de
 * l'archive des posters 2024.
 */

const OFF_PROGRAM = /\b(hors[ -]?programme|hors du programme|pas au programme|non examinables?|not examinable|not examined|not on the exam|not in the exam|out of scope|off[- ]syllabus|not part of the (syllabus|exam))\b/;

/** Archives d'organisation : ce que le cours a fait faire (posters, rendus), pas ce qu'il enseigne. */
const ORG_ARCHIVE = /\b(themes? (des |de |du )?posters?|sujets? (des |de |du )?posters?|posters? (themes?|topics?)|posters? (de |des |du )?(19|20)\d\d|archives? (des |de |du )?posters?|exemples? (de |d.un |d.une )?rendus?|rendus? (types?|exemples?)|examples? (of )?(an? )?(submissions?|posters?|reports?)|sample (submissions?|posters?|reports?)|archives? (de |d.)?organisation)\b/;

/** Marquée HORS PROGRAMME par son titre ou par le début de son texte. */
export function isOffProgram(title: string, head = ""): boolean {
  return OFF_PROGRAM.test(normalize(`${title}\n${head.slice(0, 400)}`));
}

/** Hors programme ou archive d'organisation : jamais matière à questions ni à notions. */
export function isExcludedMaterial(title: string, head = ""): boolean {
  const t = normalize(`${title}\n${head.slice(0, 400)}`).replace(/[’']/g, "'");
  return OFF_PROGRAM.test(t) || ORG_ARCHIVE.test(t);
}

/** Identifiants des sources exclues de la matière (titre + début du premier item). Base illisible → aucune. */
export async function excludedSourceIds(): Promise<Set<number>> {
  try {
    const rows = await q.all<{ id: number | string; title: string | null; head: string | null }>(
      `SELECT s.id, s.title, (SELECT substr(i.text, 1, 400) FROM items i WHERE i.source_id = s.id ORDER BY i.id LIMIT 1) head FROM sources s`,
    );
    return new Set(rows.filter((r) => isExcludedMaterial(r.title ?? "", r.head ?? "")).map((r) => Number(r.id)));
  } catch {
    return new Set();
  }
}
