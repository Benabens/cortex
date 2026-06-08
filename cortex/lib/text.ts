/** Outils texte partagés : normalisation, tokenisation, distance d'édition. */

/** Minuscule + suppression des accents (aligné sur le tokenizer FTS remove_diacritics). */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** Découpe en tokens alphanumériques normalisés (>= minLen). */
export function tokenize(s: string, minLen = 2): string[] {
  return normalize(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= minLen);
}

/**
 * Distance de Damerau-Levenshtein bornée (transpositions incluses : "tehm" ~ "them").
 * Retourne une valeur > max si la distance dépasse max (early-exit pour la perf).
 */
export function boundedEdit(a: string, b: string, max: number): number {
  const al = a.length, bl = b.length;
  if (Math.abs(al - bl) > max) return max + 1;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prevPrev = new Array(bl + 1).fill(0);
  let prev = new Array(bl + 1).fill(0);
  let curr = new Array(bl + 1).fill(0);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    const from = Math.max(1, i - max);
    const to = Math.min(bl, i + max);
    if (from > 1) curr[from - 1] = max + 1;
    for (let j = from; j <= to; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prevPrev[j - 2] + 1);
      }
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (to < bl) curr[to + 1] = max + 1;
    if (rowMin > max) return max + 1;
    [prevPrev, prev, curr] = [prev, curr, prevPrev];
  }
  return prev[bl];
}
