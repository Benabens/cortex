/**
 * Diapositive en colonnes : le texte extrait garde la mise en page (plusieurs études côte à côte),
 * chaque ligne y mêle les colonnes et les noms des études sont au pied de LEUR colonne. Aplati
 * (`\s+` → « »), il devenait une suite de phrases entrecoupées (« L'effet Argentine, Nigeria…
 * s'affaiblit… ») : banc HUM-285 du 15/11, le résultat de Walter et al. prêté aux Community Notes
 * ou à Porter & Wood dans un run sur deux, et confirmé par la vérification à l'aveugle.
 *
 * `readColumns` relit un tel bloc colonne par colonne, avant tout aplatissement. Un bloc n'est
 * relu que si ses colonnes sont séparées par au moins 3 espaces aux MÊMES positions sur toutes
 * ses lignes, et si la prose continue d'une ligne à l'autre dans au moins deux colonnes : un
 * tableau (une cellule courte par ligne) ou du code aligné restent lus par ligne.
 */

const GAP = 3;
/** Une ligne qui porte au moins deux segments séparés par une gouttière. */
const MULTI = new RegExp(`\\S {${GAP},}\\S`);

type Gap = [number, number];

/** Gouttières d'un ensemble de lignes : positions blanches sur TOUTES, larges d'au moins GAP. */
function gapsOf(lines: string[]): Gap[] {
  const width = Math.max(0, ...lines.map((l) => l.length));
  const used = new Array<boolean>(width).fill(false);
  for (const l of lines) for (let p = 0; p < l.length; p++) if (l[p] !== " ") used[p] = true;
  const first = used.indexOf(true);
  const gaps: Gap[] = [];
  let start = -1;
  for (let p = first + 1; p < width; p++) {
    if (!used[p] && start < 0) start = p;
    if (used[p] && start >= 0) {
      if (p - start >= GAP) gaps.push([start, p]);
      start = -1;
    }
  }
  return gaps;
}

/** Cellules d'une ligne, une par colonne (vide si la colonne n'a rien sur cette ligne). */
function cellsOf(line: string, gaps: Gap[]): string[] {
  const bounds = [0, ...gaps.flatMap(([a, b]) => [a, b]), Infinity];
  const cells: string[] = [];
  for (let k = 0; k < bounds.length; k += 2) cells.push(line.slice(bounds[k], bounds[k + 1] === Infinity ? undefined : bounds[k + 1]).trim());
  return cells;
}

/** Une phrase coupée en fin de ligne qui continue sur la suivante, dans la même colonne. */
function continues(prev: string, next: string, colWidth: number): boolean {
  if (prev.length < Math.max(12, 0.6 * colWidth)) return false;
  if (/[.!?:;]$/.test(prev)) return false;
  return /^\p{Ll}/u.test(next) || /[,\-–]$/.test(prev);
}

/** Relit colonne par colonne les blocs de diapositive en colonnes ; tout le reste est inchangé. */
export function readColumns(text: string): string {
  if (!MULTI.test(text)) return text;
  const lines = text.split("\n").map((l) => l.replace(/\t/g, "    ").replace(/\s+$/, ""));
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!MULTI.test(lines[i])) { out.push(lines[i]); i++; continue; }
    // Le bloc s'étend tant que ses gouttières survivent ; trois lignes vides le ferment.
    let end = i + 1;
    let gaps = gapsOf([lines[i]]);
    let blanks = 0;
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim()) {
        if (++blanks >= 3) break;
        continue;
      }
      const next = gapsOf(lines.slice(i, j + 1).filter((l) => l.trim()));
      if (!next.length) break;
      gaps = next;
      blanks = 0;
      end = j + 1;
    }
    const block = lines.slice(i, end);
    const rows = block.map((l) => (l.trim() ? cellsOf(l, gaps) : null));
    const cols = gaps.length + 1;
    const widths = Array.from({ length: cols }, (_, c) => Math.max(0, ...rows.map((r) => (r ? r[c].length : 0))));
    let prose = 0;
    for (let c = 0; c < cols; c++) {
      let hit = false;
      for (let r = 0; r + 1 < rows.length && !hit; r++) {
        const a = rows[r]?.[c];
        const b = rows[r + 1]?.[c];
        if (a && b && continues(a, b, widths[c])) hit = true;
      }
      if (hit) prose++;
    }
    const nonBlank = rows.filter(Boolean).length;
    if (cols < 2 || nonBlank < 3 || prose < 2) {
      out.push(...block);
      i = end;
      continue;
    }
    for (let c = 0; c < cols; c++) {
      const column: string[] = [];
      for (const r of rows) {
        if (r && r[c]) column.push(r[c]);
        else if (!r && column.length && column[column.length - 1] !== "") column.push("");
      }
      if (column.length) out.push(...column, "");
    }
    i = end;
  }
  return out.join("\n");
}
