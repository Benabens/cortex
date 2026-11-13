import { q } from "@/db/q";
import { EXAM_SOURCE_TYPES } from "@/lib/exam-format";
import { normalize, tokenize } from "@/lib/text";
import { excludedSourceIds, materialLabel } from "@/lib/source-scope";

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

export type CoverageTopic = { label: string; method: string | null; weight: number; chapter: string | null; repeat?: boolean; subTheme?: string | null };

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

/**
 * Sous-thèmes nommés d'une notion : les énumérations entre parenthèses de son libellé ou de
 * sa méthode (au moins trois éléments séparés par « , » ou « / »). CS-290 : « nommer le
 * phénomène (filter bubble, illusory truth effect, mis/dis/malinformation, reinforcing vs
 * balancing loop) » — le générateur prenait toujours le premier, les boucles jamais.
 */
export function subThemes(label: string, method: string | null): string[] {
  const out: string[] = [];
  for (const src of [label, method ?? ""]) {
    for (const m of src.matchAll(/\(([^()]{6,})\)/g)) {
      const parts = m[1].split(/\s*,\s*|\s+\/\s+/).map((x) => x.trim()).filter((x) => x.length >= 3);
      if (parts.length >= 3) out.push(...parts);
    }
  }
  return [...new Set(out)];
}

/** Un texte déjà posé (énoncé, thème) parle-t-il de ce sous-thème : au moins la moitié de ses mots. */
function mentions(text: string, sub: string): boolean {
  const words = tokenize(normalize(sub), 4);
  const want = words.length ? words : tokenize(normalize(sub), 2);
  if (!want.length) return false;
  const have = new Set(tokenize(normalize(text), 2));
  return want.filter((w) => have.has(w)).length * 2 >= want.length;
}

/**
 * Poids d'un chapitre : ses notions DISTINCTES (une variante ne compte qu'une fois), sommées
 * puis divisées par la racine de leur nombre. Un chapitre découpé en vingt notions (ou préparé
 * trois fois) ne prend pas l'examen pour autant : CS-290, 7 QCM sur 12 en Fairness 1.
 */
function chapterWeight(topics: CoverageTopic[]): number {
  const distinct: CoverageTopic[] = [];
  for (const t of [...topics].sort((a, b) => b.weight - a.weight)) if (!distinct.some((d) => variants(d.label, t.label))) distinct.push(t);
  const sum = distinct.reduce((s, t) => s + Math.max(0, t.weight), 0);
  return sum ? sum / Math.sqrt(distinct.length) : topics.length;
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
export function spreadOverChapters(topics: CoverageTopic[], n: number, opts: { avoid?: string[]; asked?: string[] } = {}): CoverageTopic[] | null {
  if (n <= 0 || !topics.length) return null;
  const groups = new Map<string, CoverageTopic[]>();
  for (const t of topics) {
    const key = t.chapter ?? UNCLASSIFIED;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  // Au moins deux VRAIS chapitres ; les notions non rattachées forment alors un groupe de plus.
  if ([...groups.keys()].filter((k) => k !== UNCLASSIFIED).length < 2) return null;
  const avoid = opts.avoid ?? [];
  const asked = opts.asked ?? [];
  const isAsked = (x: string) => asked.some((a) => mentions(a, x));
  // Une notion à sous-thèmes nommés compte une fois par sous-thème (ceux pas encore posés dans
  // les examens précédents d'abord) : une reprise teste une AUTRE facette, ce n'est pas un doublon.
  const expand = (ts: CoverageTopic[]) => ts.flatMap((t) => {
    const all = subThemes(t.label, t.method);
    return all.length ? [...all.filter((x) => !isAsked(x)), ...all.filter(isAsked)].map((subTheme) => ({ ...t, subTheme })) : [t];
  });
  const chapters = [...groups.entries()].map(([name, ts]) => ({
    name,
    topics: diverse(expand(ts)),
    weight: chapterWeight(ts),
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
  // Une notion à sous-thèmes n'est « déjà posée » que pour les sous-thèmes que les énoncés des
  // examens précédents (`asked`) ont traités.
  const out: CoverageTopic[] = [];
  const taken = new Map<string, Set<CoverageTopic>>();
  const active = chapters.filter((c) => quota.get(c.name));
  // Part de chaque chapitre (n × poids / total) et charge prévue (quota + places reçues − cédées) :
  // une place cédée pour la nouveauté va au chapitre le MOINS servi, jamais au-delà de sa part
  // arrondie au supérieur (CS-290 : toutes partaient vers Fairness 1, le plus riche en notions).
  const totalWeight = chapters.reduce((s, c) => s + c.weight, 0) || 1;
  const share = new Map(chapters.map((c) => [c.name, (n * c.weight) / totalWeight]));
  const cap = new Map(chapters.map((c) => [c.name, Math.max(quota.get(c.name) ?? 0, Math.ceil(share.get(c.name)!))]));
  const load = new Map(chapters.map((c) => [c.name, quota.get(c.name) ?? 0]));
  for (let k = 0; out.length < n; k++) {
    let added = false;
    for (const c of active) {
      if (k >= quota.get(c.name)! || out.length >= n) continue;
      const mine = taken.get(c.name) ?? new Set<CoverageTopic>();
      const free = c.topics.filter((t) => !mine.has(t));
      const otherFacet = (o: CoverageTopic, t: CoverageTopic) => o.label === t.label && !!o.subTheme && !!t.subTheme && o.subTheme !== t.subTheme;
      const clash = (t: CoverageTopic) => out.some((o) => variants(o.label, t.label) && !otherFacet(o, t));
      const old = (t: CoverageTopic) => (t.subTheme ? isAsked(t.subTheme) : avoid.some((a) => variants(a, t.label)));
      // Plus que des variantes ou des notions déjà posées ici : la place va à un autre chapitre
      // qui a mieux (pas de doublon dans l'examen plutôt qu'un prorata exact) ; pour la seule
      // nouveauté, dans la limite de sa part.
      const elsewhere = (ok: (t: CoverageTopic) => boolean, capped: boolean): { pick: CoverageTopic; owner: string } | null => {
        let best: { pick: CoverageTopic; owner: string; served: number } | null = null;
        for (const d of chapters) {
          if (d.name === c.name || (capped && load.get(d.name)! >= cap.get(d.name)!)) continue;
          const t = d.topics.find((x) => !(taken.get(d.name)?.has(x)) && ok(x));
          const served = load.get(d.name)! / Math.max(share.get(d.name)!, 1e-9);
          if (t && (!best || served < best.served)) best = { pick: t, owner: d.name, served };
        }
        return best && { pick: best.pick, owner: best.owner };
      };
      const fresh = (t: CoverageTopic) => !clash(t) && !old(t);
      // Une autre facette d'une notion déjà donnée à l'examen n'est pas une notion neuve : une notion
      // = une question tant qu'il en reste (examen 4 de HUM-285), les facettes servent ensuite.
      const unseen = (t: CoverageTopic) => fresh(t) && !(t.subTheme && out.some((o) => o.label === t.label));
      // Ordre de préférence : notion neuve ici, neuve ailleurs, non doublon ici, non doublon ailleurs.
      // La PREMIÈRE question d'un chapitre y reste même sur une notion déjà posée : la couverture
      // de chaque chapitre passe avant la nouveauté (CS-290 : Safety 2 n'a qu'une notion).
      let pick: CoverageTopic | undefined = free.find(unseen);
      let owner = c.name;
      if (!pick && k > 0) {
        const moved = elsewhere(unseen, true);
        if (moved) {
          ({ pick, owner } = moved);
          load.set(owner, load.get(owner)! + 1);
          load.set(c.name, load.get(c.name)! - 1);
        }
      }
      pick ??= free.find(fresh) ?? (k === 0 ? free.find((t) => !clash(t)) : undefined);
      if (!pick) {
        const moved = elsewhere(fresh, true) ?? (free.some((t) => !clash(t)) ? null : elsewhere((t) => !clash(t), false));
        if (moved) {
          ({ pick, owner } = moved);
          load.set(owner, load.get(owner)! + 1);
          load.set(c.name, load.get(c.name)! - 1);
        } else pick = free.find((t) => !clash(t));
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
export async function assignChapters(
  topics: { label: string; method: string | null; weight: number; chapterId?: number | null }[],
  opts: { fillChapters?: boolean } = {},
): Promise<CoverageTopic[]> {
  if (topics.some((t) => t.chapterId != null)) {
    let titles = new Map<number, string>();
    try {
      titles = new Map((await q.all<{ id: number; title: string }>(`SELECT id, title FROM plan_chapters ORDER BY seq`)).map((r) => [Number(r.id), r.title]));
    } catch { /* pas de plan */ }
    if (titles.size) {
      const out = topics.map((t) => ({ label: t.label, method: t.method, weight: t.weight, chapter: t.chapterId != null ? titles.get(Number(t.chapterId)) ?? null : null }));
      return opts.fillChapters ? withEmptyChapters(out, [...titles.values()]) : out;
    }
  }
  let docs: { title: string; tokens: Set<string> }[] = [];
  try {
    const exam = new Set<string>(EXAM_SOURCE_TYPES);
    const excluded = await excludedSourceIds();
    const rows = await q.all<{ sid: number; title: string; type: string; text: string | null }>(
      `SELECT s.id sid, s.title, s.type, i.text FROM items i JOIN sources s ON s.id = i.source_id ORDER BY s.id, i.id`,
    );
    const bySource = new Map<string, Set<string>>();
    for (const r of rows) {
      // Une archive (thèmes des posters, note hors programme) n'est pas un chapitre du cours.
      if (exam.has(r.type) || excluded.has(Number(r.sid)) || !r.text) continue;
      const set = bySource.get(r.title) ?? new Set<string>();
      for (const tok of tokenize(normalize(r.text), 4)) set.add(tok);
      bySource.set(r.title, set);
    }
    docs = [...bySource.entries()].map(([title, tokens]) => ({ title, tokens }));
  } catch { /* corpus illisible : aucun chapitre */ }
  if (docs.length < 2) return topics.map((t) => ({ label: t.label, method: t.method, weight: t.weight, chapter: null }));
  const df = (tok: string) => docs.reduce((n, d) => n + (d.tokens.has(tok) ? 1 : 0), 0);
  const assigned = topics.map((t) => {
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
  return opts.fillChapters ? withEmptyChapters(assigned, docs.map((d) => d.title)) : assigned;
}

/**
 * Une notion « de chapitre » (son titre) pour chaque chapitre qui n'en a aucune : banc moteur du
 * 04/11/2026 — sans annale, les notions sont des types d'exercice rattachés à quelques chapitres
 * seulement, et la répartition ignorait les autres (synth-40qcm : 4 chapitres sur 12 à 0 ; HUM-285 :
 * 10 sur 16). Poids : le plus faible des notions, pour ne pas peser plus que le cours.
 */
function withEmptyChapters(topics: CoverageTopic[], chapters: string[]): CoverageTopic[] {
  const covered = new Set(topics.map((t) => t.chapter).filter(Boolean));
  const weight = Math.max(1, Math.min(...topics.map((t) => t.weight).filter((w) => w > 0), Infinity));
  // Un chapitre nommé par un fichier (« Archive_2025-26_Thèmes_des_posters_2024.md ») ne devient jamais une notion (job 14 de HUM-285).
  const extra = chapters.filter((c) => !covered.has(c) && materialLabel(c)).map((c) => ({ label: c, method: null, weight: Number.isFinite(weight) ? weight : 1, chapter: c }));
  return [...topics, ...extra];
}
