/**
 * NON-RECOUVREMENT des questions composées d'un même examen, sans appel au modèle.
 *
 * Prod, 22/11/2026 : les questions, construites en parallèle, ne se voyaient pas ; la Q2(b)
 * refaisait toute la Q3 (fermentation bloquée), la Q2(c) la Q1 (assemblage). Le sujet d'une
 * question est lu dans son TITRE (court, rédigé par le modèle pour nommer le thème) : ses
 * termes, sans les mots vides ni le vocabulaire commun à presque tout l'examen (« vin », « cuve »
 * dans un cours d'œnologie), calculé sur l'examen lui-même. Une sous-question qui porte la
 * majorité des termes du sujet d'une AUTRE question la recouvre ; deux questions dont les sujets
 * se recouvrent se recouvrent en entier. Module pur.
 */
export type OverlapBlock = { title: string; scenario: string; parts: { prompt: string; options: string[] }[] };
/** `part` = -1 : la question `block` entière recouvre la question `other`. */
export type Overlap = { block: number; part: number; other: number; terms: string[] };

/** Mots vides de trois lettres et plus, nombres compris (« deux vins » ne nomme pas un sujet). */
const STOP = new Set([
  "the", "and", "for", "with", "from", "into", "about", "after", "before", "between", "their", "your", "what", "which", "when",
  "where", "that", "this", "these", "those", "one", "two", "three", "four", "five", "its", "are", "was", "how", "why", "who",
  "does", "using", "under", "over", "les", "des", "une", "aux", "avec", "pour", "dans", "sans", "entre", "apres", "avant",
  "leur", "leurs", "votre", "vos", "nos", "quel", "quelle", "quels", "quelles", "cette", "ces", "est", "sont", "deux",
  "trois", "quatre", "cinq", "par", "sur", "sous", "comment", "pourquoi", "qui", "que", "quoi", "der", "die", "das", "und",
  "mit", "von", "fur", "zwei", "drei", "ein", "eine", "einer", "los", "las", "del", "con", "por", "para", "dos", "tres",
  "una", "gli", "della", "per", "due", "tre",
]);

/** Racines grossières : minuscules sans accents, pluriel en « s » retiré, cinq premières lettres. */
function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().split(/[^\p{L}]+/u)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    const w = raw.length > 3 && raw.endsWith("s") ? raw.slice(0, -1) : raw;
    out.add(w.slice(0, 5));
  }
  return out;
}

const partText = (p: OverlapBlock["parts"][number]) => [p.prompt, ...p.options].join(" ");
const atLeast = (n: number) => Math.max(1, Math.ceil(0.6 * n));

/** Les recouvrements, triés par question puis sous-question. Une question recouverte en entier n'a pas de sous-question signalée. */
export function findOverlaps(blocks: OverlapBlock[]): Overlap[] {
  const all = blocks.map((b) => new Set([...stems(b.title), ...stems(b.scenario), ...b.parts.flatMap((p) => [...stems(partText(p))])]));
  // Commun à presque tout l'examen : le vocabulaire du cours, pas un sujet.
  const generic = (t: string) => all.filter((s) => s.has(t)).length >= Math.max(3, Math.ceil(0.75 * blocks.length));
  const subject = blocks.map((b) => new Set([...stems(b.title)].filter((t) => !generic(t))));
  const found: Overlap[] = [];
  const whole = new Set<number>();
  for (let x = 0; x < blocks.length; x++) {
    for (let y = 0; y < x; y++) {
      if (whole.has(y) || !subject[x].size || !subject[y].size) continue;
      const shared = [...subject[x]].filter((t) => subject[y].has(t));
      // Les deux sujets, pas seulement le plus court : « Recommendation » ne recouvre pas « Recommendation fairness ».
      if (shared.length >= atLeast(Math.max(subject[x].size, subject[y].size))) {
        found.push({ block: x, part: -1, other: y, terms: shared });
        whole.add(x);
        break;
      }
    }
  }
  for (let x = 0; x < blocks.length; x++) {
    if (whole.has(x)) continue;
    for (const [k, p] of blocks[x].parts.entries()) {
      const words = stems(partText(p));
      for (let y = 0; y < blocks.length; y++) {
        if (y === x || whole.has(y)) continue;
        const own = [...subject[y]].filter((t) => !subject[x].has(t));
        const hit = own.filter((t) => words.has(t));
        if (own.length && hit.length >= atLeast(own.length)) {
          found.push({ block: x, part: k, other: y, terms: hit });
          break;
        }
      }
    }
  }
  return found.sort((a, b) => a.block - b.block || a.part - b.part);
}
