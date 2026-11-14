import { q } from "@/db/q";
import { normalize } from "@/lib/text";

/**
 * PÉRIMÈTRE DE LA MATIÈRE — les sources qui ne servent JAMAIS de matière aux questions
 * ni aux notions, quel que soit leur type : une note ou un support marqué « hors
 * programme » (par son titre ou le début de son texte), une archive d'une année passée,
 * et les archives d'organisation (thèmes des posters, exemple de rendu, grille d'évaluation).
 * HUM-285, job 12 du 13/11 : 3 QCM sur 10 venaient de notes d'archive « Gillet 2025, hors
 * programme 2026 » et de l'archive des posters 2024 ; job 14 : 6 sur 14, les titres étant des
 * noms de fichiers (« Archive_2025-26_… »).
 */

const OFF_PROGRAM = /\b(hors[ -]?programme|hors du programme|pas au programme|non examinables?|not examinable|not examined|not on the exam|not in the exam|out of scope|off[- ]syllabus|not part of the (syllabus|exam))\b/;

/**
 * Archives d'organisation : ce que le cours a fait faire (posters, rendus), comment il l'a noté
 * (grille d'évaluation) ou une archive d'une année passée (« Archive_2025-26_… »), pas ce qu'il enseigne.
 */
const ORG_ARCHIVE = /\b(themes? (des |de |du )?posters?|sujets? (des |de |du )?posters?|posters? (themes?|topics?)|posters? (de |des |du )?(19|20)\d\d|archives? (des |de |du )?posters?|exemples? (de |d.un |d.une )?(rendus?|resumes? et bibliographie)|rendus? (types?|exemples?)|attendus? du rendu|examples? (of )?(an? )?(submissions?|posters?|reports?)|sample (submissions?|posters?|reports?)|archives? (de |d.)?organisation|grilles? (d.)?eval\w*|criteres? (d.evaluation |du )poster)\b/;

/** Archive d'une année passée, nommée comme telle en tête du titre (« Archive_2025-26_… », « Archives 2024 — … »). */
const ARCHIVE_TITLE = /^\s*archives?\b/;

/**
 * Un titre de source est souvent un NOM DE FICHIER (« Archive_2025-26_Thèmes_des_posters_2024.md ») :
 * séparateurs et extension deviennent des espaces, sinon « \b » ne coupe pas sur « _ » (job 14 de
 * HUM-285, 13/11 : aucune archive écartée).
 */
export function readableTitle(title: string): string {
  return title.replace(/\.(md|markdown|txt|pdf|docx?|pptx?|html?|tex)$/i, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
}

const scopeText = (title: string, head: string) => normalize(`${readableTitle(title)}\n${head.slice(0, 400)}`).replace(/[’']/g, "'");

/** Marquée HORS PROGRAMME par son titre ou par le début de son texte. */
export function isOffProgram(title: string, head = ""): boolean {
  return OFF_PROGRAM.test(scopeText(title, head));
}

/** Hors programme, archive d'une année passée ou d'organisation : jamais matière à questions ni à notions. */
export function isExcludedMaterial(title: string, head = ""): boolean {
  const t = scopeText(title, head);
  return OFF_PROGRAM.test(t) || ORG_ARCHIVE.test(t) || ARCHIVE_TITLE.test(normalize(readableTitle(title)));
}

/**
 * Passage qui présente le cours plutôt que sa matière : la diapositive des enseignants et de leurs
 * domaines de recherche (job 14 de HUM-285 : « lequel de ces domaines est associé à Bendahan ? »),
 * une grille ou des critères d'évaluation d'un rendu. Lu sur le début d'un item (une page, une diapo).
 */
const COURSE_FRAME = /\b(domaines? (de recherche|d.expertise|de competences?)|(presentation|equipe) (des |de l.)?(enseignants?|intervenants?|enseignement|equipe pedagogique)|vos enseignants|qui sommes[- ]nous|teaching team|about (the|your) (instructors?|lecturers?|teachers?)|research interests|grilles? (d.)?evaluation|criteres? d.evaluation (du |de l.|de la |d.un |d.une )?(poster|essai|rendu|projet|travail|expose|presentation)|grading rubric)\b/;

export function isCourseFramePassage(text: string): boolean {
  return COURSE_FRAME.test(normalize(text.slice(0, 600)).replace(/[’']/g, "'"));
}

/** Passage qui ne sert jamais de matière : source exclue (par son début) ou cadre du cours. */
export function isExcludedPassage(text: string): boolean {
  return isExcludedMaterial("", text) || isCourseFramePassage(text);
}

/**
 * La MATIÈRE d'un item : vide si l'item se dit hors programme ou archive (par son début), sinon
 * son texte sans les paragraphes qui présentent le cours (enseignants, grille d'évaluation).
 * Un PDF a un item par page, mais un .md ou un .docx n'en a qu'un : écarter l'item entier pour
 * sa diapo d'introduction retirait toute la séance 1 de HUM-285 (banc du 13/11).
 */
export function courseMatter(text: string): string {
  if (!text || isExcludedMaterial("", text)) return "";
  if (!isCourseFramePassage(text) && !COURSE_FRAME.test(normalize(text).replace(/[’']/g, "'"))) return text;
  return text.split(/\n\s*\n/).filter((p) => !isCourseFramePassage(p)).join("\n\n").trim();
}

/**
 * Libellé lisible d'un support quand il doit nommer un chapitre ou une réserve : jamais un nom de
 * fichier — null, et l'appelant s'en passe.
 */
export function materialLabel(title: string): string | null {
  const t = title.trim();
  // Extension, « _ », ou un seul bloc à chiffres et points (« 01.00-Science ») ; « Applications » reste un titre.
  if (!t || /\.[a-z0-9]{2,5}$/i.test(t) || t.includes("_") || (!/\s/.test(t) && /\d/.test(t) && /[.-]/.test(t))) return null;
  return t;
}

/**
 * Titre et début du premier item de chaque source (ou des sources `ids`). Le début est coupé ICI,
 * pas en SQL : sur une base SQL_ASCII, `substr` coupe en octets, au milieu d'un « é », et le pilote
 * rejette toute la requête (banc HUM-285 du 13/11 : aucune archive écartée). Base illisible → titres seuls.
 */
export async function sourceHeads(ids?: number[]): Promise<{ id: number; title: string; head: string }[]> {
  const where = ids ? `WHERE s.id IN (${ids.map(() => "?").join(",")})` : "";
  try {
    const rows = await q.all<{ id: number | string; title: string | null; head: string | null }>(
      `SELECT s.id, s.title, (SELECT i.text FROM items i WHERE i.source_id = s.id ORDER BY i.id LIMIT 1) head FROM sources s ${where}`,
      ...(ids ?? []),
    );
    return rows.map((r) => ({ id: Number(r.id), title: r.title ?? "", head: (r.head ?? "").slice(0, 400) }));
  } catch {
    const rows = await q.all<{ id: number | string; title: string | null }>(`SELECT s.id, s.title FROM sources s ${where}`, ...(ids ?? []));
    return rows.map((r) => ({ id: Number(r.id), title: r.title ?? "", head: "" }));
  }
}

/** Identifiants des sources exclues de la matière (titre + début du premier item). Base illisible → aucune. */
export async function excludedSourceIds(): Promise<Set<number>> {
  try {
    const rows = await sourceHeads();
    return new Set(rows.filter((r) => isExcludedMaterial(r.title, r.head)).map((r) => r.id));
  } catch {
    return new Set();
  }
}
