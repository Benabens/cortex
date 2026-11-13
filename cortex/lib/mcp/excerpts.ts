import { normalize, tokenize } from "@/lib/text";

/**
 * EXTRAITS DE RECHERCHE POUR LE MCP. Le surlignage du moteur (ts_headline / snippet
 * FTS5) rend quelques mots — « Souveraineté de l'IA » (13/11) — trop peu pour qu'un
 * assistant s'appuie dessus. On repart du texte de l'item et on découpe une fenêtre
 * d'environ 300 caractères autour du passage qui contient le plus de termes cherchés.
 */

export const EXCERPT_CHARS = 300;

/** Texte normalisé caractère par caractère, avec l'index d'origine de chaque caractère. */
function normalizedWithMap(text: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const n = normalize(text[i]);
    for (let k = 0; k < n.length; k++) { norm += n[k]; map.push(i); }
  }
  return { norm, map };
}

/** Début de mot : la recherche est en préfixe (« propre » trouve « propres »). */
function occurrences(norm: string, term: string): number[] {
  const out: number[] = [];
  for (let at = norm.indexOf(term); at !== -1 && out.length < 200; at = norm.indexOf(term, at + 1)) {
    if (at === 0 || !/[\p{L}\p{N}]/u.test(norm[at - 1])) out.push(at);
  }
  return out;
}

/**
 * Extrait d'environ `size` caractères autour de la meilleure occurrence des termes
 * de `query` dans `text` (accents et casse ignorés), termes entre « ». Aucun terme
 * trouvé (requête corrigée par le moteur) → début du texte.
 */
export function contextExcerpt(text: string, query: string, size = EXCERPT_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  // Pluriel retiré : « symetriques » cherché doit trouver « symétrique » (le moteur, lui, corrige).
  const terms = [...new Set(tokenize(query, 2).map((t) => (t.length >= 5 ? t.replace(/(es|s|x)$/, "") : t)))].sort((a, b) => b.length - a.length);
  const { norm, map } = normalizedWithMap(flat);
  const hits = terms.flatMap((t) => occurrences(norm, t).map((at) => ({ t, at })));

  let center = 0;
  if (hits.length) {
    // Le passage qui réunit le plus de termes DIFFÉRENTS dans la fenêtre gagne ; à égalité, le premier.
    let best = -1;
    for (const h of hits) {
      const near = new Set(hits.filter((o) => Math.abs(o.at - h.at) <= size / 2).map((o) => o.t)).size;
      if (near > best) { best = near; center = map[h.at]; }
    }
  }
  let start = hits.length ? Math.max(0, center - Math.floor(size * 0.4)) : 0;
  let end = Math.min(flat.length, start + size);
  start = Math.max(0, end - size);
  // Coupe sur des frontières de mots.
  if (start > 0) { const sp = flat.indexOf(" ", start); if (sp !== -1 && sp - start < 30) start = sp + 1; }
  if (end < flat.length) { const sp = flat.lastIndexOf(" ", end); if (sp > start && end - sp < 30) end = sp; }

  let out = flat.slice(start, end);
  if (terms.length) {
    const piece = normalizedWithMap(out);
    const marks: Array<[number, number]> = [];
    for (const t of terms) {
      for (const at of occurrences(piece.norm, t)) {
        let stop = at + t.length;
        while (stop < piece.norm.length && /[\p{L}\p{N}]/u.test(piece.norm[stop])) stop++;
        const a = piece.map[at], b = piece.map[stop - 1] + 1;
        if (!marks.some(([x, y]) => a < y && b > x)) marks.push([a, b]);
      }
    }
    for (const [a, b] of marks.sort((x, y) => y[0] - x[0])) out = `${out.slice(0, a)}«${out.slice(a, b)}»${out.slice(b)}`;
  }
  return `${start > 0 ? "… " : ""}${out}${end < flat.length ? " …" : ""}`;
}

/**
 * Source marquée HORS PROGRAMME par son titre ou par le début de son texte (une
 * note « Hors programme : … ») : elle passe après les supports du cours.
 */
const OFF_PROGRAM = /\b(hors[ -]?programme|hors du programme|pas au programme|non examinables?|not examinable|not examined|not on the exam|not in the exam|out of scope|off[- ]syllabus|not part of the (syllabus|exam))\b/;

export function isOffProgram(title: string, head = ""): boolean {
  return OFF_PROGRAM.test(normalize(`${title}\n${head.slice(0, 400)}`));
}
