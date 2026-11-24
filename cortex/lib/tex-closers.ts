/**
 * Accolade fermée par une marque markdown : le modèle ouvre `\emph{` puis ferme comme en markdown
 * (« \emph{nouveau* ; », « \textbf{oui** ( », « \texttt{net\_len`. »). L'accolade reste ouverte,
 * avale la suite et le document ne compile plus.
 *
 * Banc Opus 5.5 high du 23-24/11/2026 (CS-202 écrit, 5 passages) : 14 des 26 rejets du vérificateur
 * disaient « le fond est juste, le LaTeX ne compile pas » pour ce seul défaut. Chacun déclenchait une
 * régénération complète (≈ 1 $ avec la revérification) qui jetait un exercice juste.
 */

/** Commandes de texte dont l'argument tient sur une ligne. */
const TEXT_COMMAND = /\\(?:emph|textbf|textit|texttt|textsc|textsf|textrm|underline)\{/g;

/** Environnements dont le contenu est du code : jamais touchés. */
const VERBATIM = /\\begin\{(lstlisting|verbatim|Verbatim|minted)\}[\s\S]*?\\end\{\1\}|\\(?:verb|lstinline)(\S)[\s\S]*?\2/g;

/** Accolades ouvertes moins accolades fermées (hors `\{`, `\}`, commentaires et code verbatim). */
export function braceBalance(tex: string): number {
  let depth = 0;
  for (const line of tex.replace(VERBATIM, "").split("\n")) {
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "\\") { i++; continue; }
      if (ch === "%") break;
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
  }
  return depth;
}

/**
 * Position de la marque qui ferme l'argument ouvert en `open` sur sa ligne, ou -1 si l'argument se
 * ferme normalement, ou si aucune marque n'a la forme d'une fermeture : collée à un mot (pas après
 * l'accolade ni une espace, ce qui écarte `\texttt{*p}`) et suivie d'une espace, d'une ponctuation
 * ou de la fin de ligne.
 */
function markdownCloser(line: string, open: number): { at: number; len: number } | null {
  let depth = 0;
  let closer: { at: number; len: number } | null = null;
  for (let i = open; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return null;
    else if (depth === 1 && !closer && (ch === "*" || ch === "`")) {
      const len = line.startsWith("**", i) ? 2 : 1;
      const before = line[i - 1];
      const after = line[i + len] ?? "";
      if (before && before !== "{" && !/\s/.test(before) && (after === "" || /[\s.,;:!?)\]'"»]/.test(after))) closer = { at: i, len };
    }
  }
  return closer;
}

/**
 * Le source où chaque `\emph{…*` (ou `**`, ou accent grave) resté ouvert sur sa ligne est refermé par
 * `}` à la place de la marque. Ne touche rien si le document est équilibré (un argument qui s'étend
 * sur plusieurs lignes reste tel quel), ni le code verbatim, et jamais plus de réparations que
 * d'accolades manquantes. Rend le texte d'entrée à l'identique quand il n'y a rien à réparer.
 */
export function repairMarkdownClosers(tex: string): string {
  if (!tex || !/[*`]/.test(tex)) return tex;
  let missing = braceBalance(tex);
  if (missing <= 0) return tex;
  const verbatim = [...tex.matchAll(VERBATIM)].map((m) => [m.index!, m.index! + m[0].length] as const);
  const inVerbatim = (i: number) => verbatim.some(([a, b]) => i >= a && i < b);
  const out: string[] = [];
  let lineStart = 0;
  for (const line of tex.split("\n")) {
    let fixed = line;
    if (missing > 0 && !inVerbatim(lineStart)) {
      // De droite à gauche : une réparation ne décale pas les positions encore à lire.
      const opens = [...line.matchAll(TEXT_COMMAND)].map((m) => m.index! + m[0].length - 1).reverse();
      for (const open of opens) {
        if (missing <= 0) break;
        const c = markdownCloser(fixed, open);
        if (!c) continue;
        fixed = `${fixed.slice(0, c.at)}}${fixed.slice(c.at + c.len)}`;
        missing--;
      }
    }
    out.push(fixed);
    lineStart += line.length + 1;
  }
  return out.join("\n");
}

/** L'exercice avec énoncé et corrigé réparés (même objet si rien ne change). */
export function repairExerciseClosers<T extends { statement_tex?: string; solution_tex?: string }>(q: T): T {
  if (!q) return q;
  const st = typeof q.statement_tex === "string" ? repairMarkdownClosers(q.statement_tex) : q.statement_tex;
  const so = typeof q.solution_tex === "string" ? repairMarkdownClosers(q.solution_tex) : q.solution_tex;
  return st === q.statement_tex && so === q.solution_tex ? q : { ...q, statement_tex: st, solution_tex: so };
}
