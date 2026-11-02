import { q } from "@/db/q";
import { EXAM_SOURCE_TYPES } from "@/lib/exam-format";
import { normalize, tokenize } from "@/lib/text";

/**
 * COUVERTURE DES CHAPITRES — les questions d'un examen se répartissent sur
 * TOUS les chapitres du cours, au prorata de leur poids d'examen. Avant, les
 * notions étaient prises par poids décroissant (pickCoverage : 60 % de tête) :
 * sur CS-290, trois préparations successives avaient laissé quatre variantes
 * d'une même notion de Fairness 1 en tête, et 5 examens sur 5 ne portaient que
 * sur Fairness 1.
 *
 * Le chapitre d'une notion : celui du plan du cours (topics.plan_chapter_id)
 * quand il existe, sinon le support du cours (note, slides, série…) où ses
 * mots les plus rares apparaissent. Sans au moins deux chapitres, rien n'est
 * réparti (l'appelant garde son ordre par poids).
 */

export type CoverageTopic = { label: string; method: string | null; weight: number; chapter: string | null; repeat?: boolean };

const UNCLASSIFIED = "(non classé)";

/** Racines des mots d'un libellé : 5 premières lettres, pour rapprocher « paradox »/« paradoxe », « sensitive »/« sensibles ». */
function roots(label: string): Set<string> {
  return new Set(tokenize(label, 3).map((w) => (w.length >= 5 ? w.slice(0, 5) : w)));
}

/**
 * Deux libellés sont des variantes d'une même notion s'ils partagent au moins
 * 40 % de leurs racines — y compris d'une langue à l'autre (mock 4 de CS-290 :
 * « Simpson's paradox / confounder » et « Paradoxe de Simpson — Berkeley »).
 */
export function variants(a: string, b: string): boolean {
  const x = roots(a);
  const y = roots(b);
  const inter = [...x].filter((w) => y.has(w)).length;
  const union = new Set([...x, ...y]).size;
  return union > 0 && inter / union >= 0.4;
}

/** Notions d'un chapitre par poids, les variantes d'une notion déjà prise renvoyées en fin de liste. */
function diverse(topics: CoverageTopic[]): CoverageTopic[] {
  const byWeight = [...topics].sort((a, b) => b.weight - a.weight);
  const first: CoverageTopic[] = [];
  const later: CoverageTopic[] = [];
  for (const t of byWeight) (first.some((f) => variants(f.label, t.label)) ? later : first).push(t);
  return [...first, ...later];
}

/**
 * n sujets répartis sur les chapitres : un par chapitre (les plus lourds
 * d'abord s'il y a moins de questions que de chapitres), le surplus au prorata
 * du poids (plus forts restes) ; dans un chapitre, ses notions par poids, une
 * reprise marquée `repeat` seulement quand il n'en reste plus. Ordre alterné
 * entre chapitres, pour que chaque lot en mêle plusieurs.
 */
export function spreadOverChapters(topics: CoverageTopic[], n: number, opts: { avoid?: string[] } = {}): CoverageTopic[] | null {
  if (n <= 0 || !topics.length) return null;
  const groups = new Map<string, CoverageTopic[]>();
  for (const t of topics) {
    const key = t.chapter ?? UNCLASSIFIED;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  // Au moins deux VRAIS chapitres ; les notions non rattachées forment alors un groupe de plus.
  if ([...groups.keys()].filter((k) => k !== UNCLASSIFIED).length < 2) return null;
  const chapters = [...groups.entries()].map(([name, ts]) => ({
    name,
    topics: diverse(ts),
    weight: ts.reduce((s, t) => s + Math.max(0, t.weight), 0) || ts.length,
  })).sort((a, b) => b.weight - a.weight);

  const quota = new Map<string, number>();
  if (n < chapters.length) {
    for (const c of chapters.slice(0, n)) quota.set(c.name, 1);
  } else {
    for (const c of chapters) quota.set(c.name, 1);
    const rest = n - chapters.length;
    const total = chapters.reduce((s, c) => s + c.weight, 0);
    const ideal = chapters.map((c) => ({ c, x: (rest * c.weight) / total }));
    for (const { c, x } of ideal) quota.set(c.name, quota.get(c.name)! + Math.floor(x));
    let left = n - [...quota.values()].reduce((s, v) => s + v, 0);
    ideal.sort((a, b) => b.x - Math.floor(b.x) - (a.x - Math.floor(a.x)) || b.c.weight - a.c.weight);
    for (let i = 0; left > 0; i = (i + 1) % ideal.length, left--) quota.set(ideal[i].c.name, quota.get(ideal[i].c.name)! + 1);
  }

  // Tour par tour, un sujet par chapitre encore sous son quota : d'abord une notion qui n'est
  // la variante d'AUCUNE notion déjà prise dans l'examen (tous chapitres confondus) ni d'une
  // notion des examens précédents (`avoid`), puis une non reprise, puis une reprise marquée.
  const avoid = opts.avoid ?? [];
  const out: CoverageTopic[] = [];
  const taken = new Map<string, Set<CoverageTopic>>();
  const active = chapters.filter((c) => quota.get(c.name));
  for (let k = 0; out.length < n; k++) {
    let added = false;
    for (const c of active) {
      if (k >= quota.get(c.name)! || out.length >= n) continue;
      const mine = taken.get(c.name) ?? new Set<CoverageTopic>();
      const free = c.topics.filter((t) => !mine.has(t));
      const clash = (t: CoverageTopic) => out.some((o) => variants(o.label, t.label));
      const old = (t: CoverageTopic) => avoid.some((a) => variants(a, t.label));
      // Plus que des variantes ou des notions déjà posées ici : la place va à un autre chapitre
      // qui a mieux (pas de doublon dans l'examen plutôt qu'un prorata exact).
      const elsewhere = (ok: (t: CoverageTopic) => boolean): { pick: CoverageTopic; owner: string } | null => {
        for (const d of chapters) {
          const t = d.topics.find((x) => !(taken.get(d.name)?.has(x)) && ok(x));
          if (t) return { pick: t, owner: d.name };
        }
        return null;
      };
      const fresh = (t: CoverageTopic) => !clash(t) && !old(t);
      // Ordre de préférence : notion neuve ici, neuve ailleurs, non doublon ici, non doublon ailleurs.
      let pick: CoverageTopic | undefined = free.find(fresh);
      let owner = c.name;
      if (!pick) {
        const moved = elsewhere(fresh) ?? (free.some((t) => !clash(t)) ? null : elsewhere((t) => !clash(t)));
        if (moved) ({ pick, owner } = moved);
        else pick = free.find((t) => !clash(t));
      }
      pick ??= free[0];
      if (pick) {
        const set = taken.get(owner) ?? new Set<CoverageTopic>();
        set.add(pick);
        taken.set(owner, set);
        out.push(pick);
      } else {
        out.push({ ...c.topics[k % c.topics.length], repeat: true });
      }
      added = true;
    }
    if (!added) break;
  }
  return out;
}

/**
 * Chapitre de chaque notion du cours courant : celui du plan du cours, sinon
 * le support du cours (hors annales) dont le texte porte ses mots les plus
 * rares (idf), ceux du libellé comptant double. null si rien ne la rattache.
 */
export async function assignChapters(topics: { label: string; method: string | null; weight: number; chapterId?: number | null }[]): Promise<CoverageTopic[]> {
  if (topics.some((t) => t.chapterId != null)) {
    let titles = new Map<number, string>();
    try {
      titles = new Map((await q.all<{ id: number; title: string }>(`SELECT id, title FROM plan_chapters`)).map((r) => [Number(r.id), r.title]));
    } catch { /* pas de plan */ }
    if (titles.size) return topics.map((t) => ({ label: t.label, method: t.method, weight: t.weight, chapter: t.chapterId != null ? titles.get(Number(t.chapterId)) ?? null : null }));
  }
  let docs: { title: string; tokens: Set<string> }[] = [];
  try {
    const exam = new Set<string>(EXAM_SOURCE_TYPES);
    const rows = await q.all<{ title: string; type: string; text: string | null }>(
      `SELECT s.title, s.type, i.text FROM items i JOIN sources s ON s.id = i.source_id ORDER BY s.id, i.id`,
    );
    const bySource = new Map<string, Set<string>>();
    for (const r of rows) {
      if (exam.has(r.type) || !r.text) continue;
      const set = bySource.get(r.title) ?? new Set<string>();
      for (const tok of tokenize(normalize(r.text), 4)) set.add(tok);
      bySource.set(r.title, set);
    }
    docs = [...bySource.entries()].map(([title, tokens]) => ({ title, tokens }));
  } catch { /* corpus illisible : aucun chapitre */ }
  if (docs.length < 2) return topics.map((t) => ({ label: t.label, method: t.method, weight: t.weight, chapter: null }));
  const df = (tok: string) => docs.reduce((n, d) => n + (d.tokens.has(tok) ? 1 : 0), 0);
  return topics.map((t) => {
    const words = new Map<string, number>();
    for (const tok of tokenize(t.method ?? "", 4)) words.set(tok, 1);
    for (const tok of tokenize(t.label, 4)) words.set(tok, 2);
    let best: { title: string; score: number; size: number } | null = null;
    for (const d of docs) {
      let score = 0;
      for (const [tok, w] of words) if (d.tokens.has(tok)) score += w / df(tok);
      // À égalité, le support le plus SPÉCIFIQUE (le moins de mots) : un polycopié qui contient
      // tout ne doit pas absorber les notions de chaque chapitre.
      if (score > 0 && (!best || score > best.score || (score === best.score && d.tokens.size < best.size))) best = { title: d.title, score, size: d.tokens.size };
    }
    return { label: t.label, method: t.method, weight: t.weight, chapter: best?.title ?? null };
  });
}
