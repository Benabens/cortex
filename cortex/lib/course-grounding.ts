import { q } from "@/db/q";
import { EXAM_SOURCE_TYPES } from "@/lib/exam-format";
import { normalize, tokenize } from "@/lib/text";

/**
 * ANCRAGE DANS LE COURS — une question ne doit reposer que sur des notions que
 * le cours présente, avec SA définition (mock 3 de CS-290 : bonne réponse
 * « status quo bias », notion absente des 13 documents du cours ; drills qui
 * classaient misuse/abuse et issue/dilemma selon des définitions du web).
 *
 * Le modèle (concepteur ou juge) cite le terme tel qu'il est écrit dans le
 * cours ; ce module vérifie, de façon déterministe, que ce terme existe dans le
 * corpus. Il ne juge pas la définition (c'est le rôle du juge, qui voit les
 * extraits) : il attrape la notion inventée que le modèle prétend avoir lue.
 */

/** Consigne commune à la conception et à la correction. */
export const COURSE_TERMS_RULE =
  `  - NOTIONS DU COURS SEULEMENT : toute notion nommée (dans la bonne réponse, les distracteurs, l'explication ou le corrigé) doit figurer dans les extraits ou les supports du cours, avec LA DÉFINITION DU COURS — jamais celle d'une autre source. N'introduis aucune notion que le cours ne présente pas (un biais, une métrique, une catégorie, une théorie), même plausible.`;

/**
 * La matière, pas l'évaluation : une grille d'évaluation, des consignes d'examen ou le
 * guide d'un poster disent COMMENT le cours est évalué, pas CE qu'il enseigne (HUM-285,
 * 02/11 : ~6 questions sur la grille D1/D2/D3 de l'essai et la bibliographie du poster) ; le plan
 * d'un support (« quelle place les biais occupent-ils dans le plan annoncé ? », banc du 02/11) ne
 * l'enseigne pas davantage.
 * Commune à l'extraction des notions et à la conception des questions.
 */
export const COURSE_MATTER_RULE =
  `  - MATIÈRE DU COURS SEULEMENT : aucune question ni notion sur les modalités d'examen (format, durée, barème, grille ou critères d'évaluation, consignes) ni sur la forme d'un rendu (poster, essai, rapport, mise en forme d'une bibliographie), ni sur l'organisation du cours (plan, ordre des chapitres, ce qu'annonce une diapositive) : teste ce que le cours enseigne, pas comment il est évalué ou découpé.`;

/** Au-delà, le corpus n'est pas chargé en mémoire : sans vérification possible, rien n'est rejeté. */
const MAX_CORPUS_CHARS = 30_000_000;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Racine tolérante d'un mot, comparée en PRÉFIXE : « stereotypes » → « stereoty »,
 * « matrices » → « matri » (matrix), « criteria » → « crite » (criterion), « LLMs » →
 * « llm ». Volontairement large : un faux rejet coûte une question juste, un faux
 * accueil n'est qu'un filet en moins (le juge voit aussi les extraits).
 */
function stem(word: string): string {
  if (word.length >= 6) return word.slice(0, Math.max(4, word.length - 3));
  return word.length >= 3 ? word.replace(/s$/, "") : word;
}

/**
 * Motifs d'un terme dans un texte TOKENISÉ (mots séparés d'une espace, ponctuation
 * retirée : élisions « d'ancrage », apostrophes « Simpson's », parenthèses) : mots dans
 * l'ordre ; mots accolés aussi (« group think » / « groupthink »).
 */
function termPatterns(term: string): RegExp[] {
  const words = tokenize(term, 1);
  if (!words.length) return [];
  const word = (w: string) => `${escapeRe(stem(w))}\\p{L}*`;
  const start = "(?:^| )";
  const out = [new RegExp(`${start}${words.map(word).join(" ")}(?= |$)`, "u")];
  if (words.length > 1) out.push(new RegExp(`${start}${word(words.join(""))}(?= |$)`, "u"));
  return out;
}

/**
 * Textes normalisés du corpus du cours courant, ou null s'il est vide ou trop gros pour être vérifié.
 * Sans les consignes d'examen (exam_info) : une grille d'évaluation dit comment le cours est noté,
 * ses termes (« lien conceptuel SHS », D1 de HUM-285) ne sont pas des notions du cours.
 */
async function corpusTexts(): Promise<string[] | null> {
  let rows: { text: string | null }[] = [];
  try {
    rows = await q.all<{ text: string | null }>(`SELECT i.text FROM items i LEFT JOIN sources s ON s.id = i.source_id WHERE s.type IS NULL OR s.type <> 'exam_info'`);
  } catch { return null; }
  let total = 0;
  const texts: string[] = [];
  for (const r of rows) {
    if (!r.text) continue;
    total += r.text.length;
    if (total > MAX_CORPUS_CHARS) return null;
    texts.push(tokenize(r.text, 1).join(" "));
  }
  return texts.length ? texts : null;
}

/**
 * Termes absents du corpus du cours courant, dans l'ordre et l'écriture reçus,
 * sans doublon. Vide si tous sont présents — ou si le cours n'a pas de corpus
 * (rien sur quoi s'ancrer : ne jamais rejeter faute de pouvoir vérifier).
 */
export async function absentCourseTerms(terms: string[]): Promise<string[]> {
  const byKey = new Map<string, string>();
  for (const t of terms) {
    const term = typeof t === "string" ? t.trim() : "";
    if (term && !byKey.has(normalize(term))) byKey.set(normalize(term), term);
  }
  const wanted = [...byKey.values()];
  if (!wanted.length) return [];
  const texts = await corpusTexts();
  if (!texts) return [];
  return wanted.filter((term) => {
    const patterns = termPatterns(term);
    return patterns.length > 0 && !texts.some((t) => patterns.some((re) => re.test(t)));
  });
}

/** Types de sources jamais pris comme « faits du cours » à tester (annales : on n'en recopie pas les questions). */
const NOT_COURSE_FACTS = new Set<string>(EXAM_SOURCE_TYPES);

/** Fenêtre d'un texte autour du premier mot de la requête qu'il contient. */
function windowAround(text: string, query: string, cap: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= cap) return t;
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4);
  const lower = t.toLowerCase();
  const at = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, Math.min(at - Math.floor(cap / 3), t.length - cap));
  return t.slice(start, start + cap);
}

/** Extraits du cours sur les sujets d'un lot (recherche plein texte), pour ancrer chaque question sur un fait précis. */
export async function coursePassages(topics: string[], perTopic = 2, cap = 900): Promise<{ src: string; text: string }[]> {
  const { search } = await import("@/lib/search");
  const out: { src: string; text: string }[] = [];
  const seen = new Set<number>();
  for (const topic of topics) {
    let groups: Awaited<ReturnType<typeof search>> = [];
    try { groups = await search(topic, 16, "or"); } catch { continue; }
    let k = 0;
    for (const h of groups.flatMap((g) => g.hits)) {
      if (k >= perTopic) break;
      if (NOT_COURSE_FACTS.has(h.sourceType) || seen.has(h.itemId)) continue;
      seen.add(h.itemId);
      const row = await q.get<{ text: string }>(`SELECT text FROM items WHERE id = ?`, h.itemId);
      if (!row?.text) continue;
      out.push({ src: h.sourceTitle, text: windowAround(row.text, topic, cap) });
      k++;
    }
  }
  return out;
}
