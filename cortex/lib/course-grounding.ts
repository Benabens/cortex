import { q } from "@/db/q";
import { EXAM_SOURCE_TYPES } from "@/lib/exam-format";
import { courseMatter, excludedSourceIds, isExcludedMaterial } from "@/lib/source-scope";
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
  `  - NOTIONS DU COURS SEULEMENT : toute notion nommée (dans la bonne réponse, les distracteurs, l'explication ou le corrigé) doit figurer dans les extraits ou les supports du cours, avec LA DÉFINITION DU COURS — jamais celle d'une autre source, ni plus étroite (une condition ajoutée), ni plus large (une condition oubliée) ; ne confonds jamais deux notions voisines du cours. N'introduis aucune notion que le cours ne présente pas (un biais, une métrique, une catégorie, une théorie), même plausible.`;

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

/** Un examen nommé : « midterm », « QCM », « final exam »… (« final » seul est trop courant : « final value theorem »). */
const EXAM_WORD = /\b(exam|exams|examen|examens|midterm|midterms|mid-term|partiel|partiels|quiz|qcm|mcq|mcqs|final exam|examen final|finals|oral exam|examen oral)\b/;
/** Ce qu'une note de modalités dit d'un examen : son format, sa durée, son barème, ce qui est permis. */
const LOGISTICS_WORD = /\b(format|formats|modalites?|duree|duration|bareme|grading|graded|notation|ponderation|weighting|consignes?|instructions|allowed|autorises?|autorisees?|permitted|closed book|open book|calculat\w*|deadline|rubric|nombre de questions|number of questions)\b/;
/** Formules qui suffisent seules. */
const LOGISTICS_PHRASE = /\b(modalites d.examen|modalites d.evaluation|exam format|format de l.examen|grading scheme|grille d.evaluation|criteres d.evaluation|evaluation criteria|closed book|open book|cheat ?sheet (allowed|autorise\w*))\b/;

/**
 * Une note de MODALITÉS D'EXAMEN, pas une notion du cours (même règle que
 * COURSE_MATTER_RULE, appliquée sans modèle) : « Midterm MCQ format — half Bendahan… »
 * (HUM, 13/11) remontait comme concept à réviser. Lu sur un titre de carte ou un concept.
 */
export function isExamLogistics(text: string): boolean {
  const t = normalize(text).replace(/[’']/g, "'");
  if (LOGISTICS_PHRASE.test(t)) return true;
  return EXAM_WORD.test(t) && LOGISTICS_WORD.test(t);
}

/**
 * Notions de la MATIÈRE seulement, à l'usage (les notions d'un cours préparé avant la règle
 * restent en base jusqu'à sa re-préparation) : ni une modalité d'examen, ni un libellé qui se
 * dit hors programme ou archive (« Thèmes des posters 2024 »), ni une notion dont les meilleurs
 * passages ne sont QUE dans des sources exclues (HUM-285, 13/11 : RGPD/LPD, d'une note d'archive
 * « hors programme 2026 »). Recherche stricte (tous les mots) d'abord, large à défaut.
 */
export async function topicsInScope<T extends { label: string }>(topics: T[]): Promise<T[]> {
  // Un nom de fichier n'est jamais une notion (« S_ance_1_…_slides_01.00.md », job 14 de HUM-285).
  const fileName = (l: string) => /\.(md|markdown|txt|pdf|docx?|pptx?|html?)$/i.test(l.trim()) || /\w_\w/.test(l);
  const byLabel = topics.filter((t) => !isExamLogistics(t.label) && !isExcludedMaterial(t.label) && !fileName(t.label));
  const excluded = await excludedSourceIds();
  if (!excluded.size) return byLabel;
  const { rankedHits } = await import("@/lib/search");
  const out: T[] = [];
  for (const t of byLabel) {
    const material = async (mode: "and" | "or") => (await rankedHits(t.label.slice(0, 200), 12, mode)).filter((h) => !NOT_COURSE_FACTS.has(h.sourceType));
    const strict = await material("and");
    const hits = strict.length ? strict : await material("or");
    const top = hits.slice(0, 3);
    if (top.length && top.every((h) => excluded.has(Number(h.sourceId)))) continue;
    out.push(t);
  }
  return out;
}

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
  // Hors programme et archives d'organisation : jamais un passage à tester (lib/source-scope).
  const excluded = await excludedSourceIds();
  for (const topic of topics) {
    let groups: Awaited<ReturnType<typeof search>> = [];
    try { groups = await search(topic, 16, "or"); } catch { continue; }
    let k = 0;
    for (const h of groups.flatMap((g) => g.hits)) {
      if (k >= perTopic) break;
      if (NOT_COURSE_FACTS.has(h.sourceType) || excluded.has(Number(h.sourceId)) || seen.has(h.itemId)) continue;
      seen.add(h.itemId);
      const row = await q.get<{ text: string }>(`SELECT text FROM items WHERE id = ?`, h.itemId);
      const matter = courseMatter(row?.text ?? "");
      if (!matter) continue;
      out.push({ src: h.sourceTitle, text: windowAround(matter, topic, cap) });
      k++;
    }
  }
  return out;
}

/** Mots porteurs d'une requête : 5 lettres ou plus, ou un nombre (année, pourcentage). */
function queryWords(query: string): string[] {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 5 || /^\d{2,}$/.test(w));
  return [...new Set(words)].slice(0, 40);
}

/**
 * La fenêtre de `cap` caractères qui contient le plus de mots DISTINCTS de la requête, calée
 * sur une fin de phrase ou un mot : le fait cherché n'est pas toujours près du premier mot du
 * sujet (Svenson (1981), à 3 500 caractères du titre d'un support de HUM-285, 02/11).
 */
export function densestWindow(text: string, query: string, cap: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= cap) return t;
  const lower = t.toLowerCase();
  const positions = queryWords(query).map((w) => {
    const at: number[] = [];
    for (let i = lower.indexOf(w); i >= 0 && at.length < 60; i = lower.indexOf(w, i + 1)) at.push(i);
    return at;
  }).filter((a) => a.length);
  if (!positions.length) return t.slice(0, cap);
  // Fenêtres essayées autour de chaque occurrence : le mot au premier quart, au début, ou à la fin.
  const lead = Math.floor(cap / 4);
  const starts = new Set<number>();
  for (const p of positions.flat()) for (const s of [p - lead, p, p - cap + 60]) starts.add(Math.max(0, Math.min(s, t.length - cap)));
  let best = 0;
  let bestScore = -1;
  for (const start of [...starts].sort((x, y) => x - y)) {
    const score = positions.filter((at) => at.some((i) => i >= start && i < start + cap)).length;
    if (score > bestScore) { bestScore = score; best = start; }
  }
  // Calage : le début recule jusqu'à une fin de phrase proche (sinon un mot) ; la fin ne recule
  // jamais, pour ne rien perdre de ce que la fenêtre contenait, et avance jusqu'au mot suivant.
  const sentence = t.lastIndexOf(". ", best);
  const start = best === 0 ? 0 : sentence >= 0 && best - sentence < 160 ? sentence + 2 : t.lastIndexOf(" ", best) + 1;
  let end = Math.min(t.length, best + cap);
  const space = t.indexOf(" ", end);
  if (end < t.length && space >= 0 && space - end < 40) end = space;
  return t.slice(start, end);
}

/**
 * Passages du cours qui servent de PREUVE : pour chaque requête (un fait, un énoncé, une
 * notion), les meilleurs résultats de la recherche plein texte, en fenêtres larges centrées sur
 * la requête. Deux fenêtres d'un même support ne sont gardées que si elles ne se recouvrent pas.
 * Jamais les annales, exemples ni consignes d'examen, ni une source hors programme. `budget` borne le total en caractères.
 */
export async function evidencePassages(queries: string[], opts: { perQuery?: number; cap?: number; budget?: number } = {}): Promise<{ src: string; text: string }[]> {
  const { perQuery = 2, cap = 1800, budget = 24_000 } = opts;
  // Par pertinence, tous types confondus : search() regroupe par type (exercices avant supports),
  // ce qui pouvait faire passer le meilleur passage d'un support après deux exercices voisins.
  const { rankedHits } = await import("@/lib/search");
  const out: { src: string; text: string }[] = [];
  const windows = new Map<number, string[]>();
  const excluded = await excludedSourceIds();
  let used = 0;
  for (const query of queries.map((x) => x.trim()).filter(Boolean)) {
    if (used >= budget) break;
    let hits: Awaited<ReturnType<typeof rankedHits>> = [];
    try { hits = await rankedHits(query.slice(0, 400), 16, "or"); } catch { continue; }
    let k = 0;
    for (const h of hits) {
      if (k >= perQuery || used >= budget) break;
      if (NOT_COURSE_FACTS.has(h.sourceType) || excluded.has(Number(h.sourceId))) continue;
      const row = await q.get<{ text: string }>(`SELECT text FROM items WHERE id = ?`, h.itemId);
      const matter = courseMatter(row?.text ?? "");
      if (!matter) continue;
      const text = densestWindow(matter, query, cap);
      const seen = windows.get(h.itemId) ?? [];
      // Même fenêtre (ou presque) déjà montrée pour une autre requête : rien de neuf.
      if (seen.some((w) => w.includes(text.slice(0, 200)) || text.includes(w.slice(0, 200)))) { k++; continue; }
      windows.set(h.itemId, [...seen, text]);
      out.push({ src: h.sourceTitle, text });
      used += text.length;
      k++;
    }
  }
  return out;
}

/** Mots vides ignorés par la recherche dans tout le corpus (articles, liaisons, verbes d'énoncé). */
const SCAN_STOP = new Set("les des une dans pour par sur aux avec sans son ses leur leurs plus moins pas cette ces elle elles ils sont etre fait faire selon cours quelle quel quels quelles lequel laquelle entre comme tout tous toute toutes meme peut peuvent deux aussi ainsi alors donc dont mais encore notion notions passage passages present presente presentee presentes presentees explicitement seulement indique mentionne the and for with from that this which are".split(" "));

/** Texte replié (minuscules, sans accents) de MÊME LONGUEUR que l'original : une position y vaut une position de l'original. */
function fold(text: string): string {
  let out = "";
  for (const ch of text) {
    const f = ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    out += f.length === ch.length ? f : ch.length === 1 ? (f[0] ?? ch) : ch;
  }
  return out;
}

/**
 * Passages trouvés dans TOUT le corpus du cours, sans la recherche plein texte : chaque mot
 * porteur de la requête est cherché par sa racine (accents, pluriels, flexions : « bifaces » pour
 * « biface », « vérifiabilité » pour « vérifiable »), et la fenêtre qui en réunit le plus est
 * gardée. Banc HUM-285 du 13/11 : 29 questions rejetées « hors cours » par un second regard qui
 * n'avait vu que les extraits de la recherche plein texte (« le RLHF n'est pas présenté dans ces
 * passages », alors que la séance 7 le détaille). Jamais une source exclue, une annale ni le cadre du cours.
 */
export async function corpusWindows(queries: string[], opts: { perQuery?: number; cap?: number; budget?: number } = {}): Promise<{ src: string; text: string }[]> {
  const { perQuery = 2, cap = 1800, budget = 12_000 } = opts;
  let rows: { id: number; sid: number; type: string; title: string; text: string | null }[] = [];
  try {
    rows = await q.all(`SELECT i.id, s.id sid, s.type, s.title, i.text FROM items i JOIN sources s ON s.id = i.source_id`);
  } catch { return []; }
  const excluded = await excludedSourceIds();
  const docs: { id: number; src: string; text: string; folded: string }[] = [];
  let total = 0;
  for (const r of rows) {
    if (NOT_COURSE_FACTS.has(r.type) || r.type === "exam_info" || excluded.has(Number(r.sid))) continue;
    const text = courseMatter(r.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    total += text.length;
    if (total > MAX_CORPUS_CHARS) return [];
    docs.push({ id: Number(r.id), src: r.title, text, folded: fold(text) });
  }
  const out: { src: string; text: string }[] = [];
  const shown = new Set<string>();
  let used = 0;
  for (const query of queries.map((x) => x.trim()).filter(Boolean)) {
    if (used >= budget) break;
    const stems = [...new Set(tokenize(query, 4).filter((w) => !SCAN_STOP.has(w) && !/^\d+$/.test(w)).map(stem))].slice(0, 24);
    if (!stems.length) continue;
    const res = stems.map((s) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(s)}\\p{L}*`, "gu"));
    const scored: { doc: (typeof docs)[number]; start: number; score: number }[] = [];
    for (const doc of docs) {
      const hits = res.map((re) => [...doc.folded.matchAll(re)].slice(0, 80).map((m) => m.index!));
      if (hits.filter((h) => h.length).length < Math.min(2, stems.length)) continue;
      let best = { start: 0, score: 0 };
      for (const p of hits.flat()) {
        const start = Math.max(0, Math.min(p - Math.floor(cap / 3), doc.text.length - cap));
        const score = hits.filter((h) => h.some((i) => i >= start && i < start + cap)).length;
        if (score > best.score) best = { start, score };
      }
      scored.push({ doc, ...best });
    }
    // Au moins la moitié des mots porteurs dans une même fenêtre : un mot isolé ne prouve rien.
    const need = Math.max(2, Math.ceil(stems.length / 2));
    for (const s of scored.filter((x) => x.score >= Math.min(need, stems.length)).sort((a, b) => b.score - a.score).slice(0, perQuery)) {
      const begin = s.start === 0 ? 0 : s.doc.text.lastIndexOf(" ", s.start) + 1;
      const text = s.doc.text.slice(begin, begin + cap);
      const key = `${s.doc.id}:${begin}`;
      if (shown.has(key) || used >= budget) continue;
      shown.add(key);
      out.push({ src: s.doc.src, text });
      used += text.length;
    }
  }
  return out;
}
