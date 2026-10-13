import type { TopicCluster } from "@/lib/program";

/**
 * PLAN DE REGROUPEMENT des notions d'un cours : la partition proposée par le modèle (types
 * canoniques, libellés bruts qu'ils couvrent, lecture où chaque type est traité), figée dans un
 * fichier pour être relue AVANT d'être écrite.
 *
 * Pourquoi un fichier : le modèle ne rend pas deux fois le même regroupement. Sans lui, la
 * partition affichée par un essai à blanc ne serait pas celle qu'écrit la passe suivante. Avec lui,
 * ce qui a été relu est exactement ce qui est appliqué, sans nouvel appel modèle.
 *
 * Le plan porte aussi l'index sur lequel il a été calculé (libellé brut → nombre d'exos) : il ne
 * s'applique qu'à une base dont l'index est identique. Tout ici est pur (aucune base, aucun modèle).
 */

export type RegroupType = TopicCluster & { lecture_no: number | null };

export type RegroupPlan = {
  course: string;
  createdAt: string;
  /** Libellé brut de l'index → nombre d'exos, au moment du calcul. */
  index: Record<string, number>;
  types: RegroupType[];
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Valide la forme d'un plan lu sur disque. Lève avec la raison précise. */
export function parsePlan(raw: unknown): RegroupPlan {
  if (!isRecord(raw)) throw new Error("Plan illisible : un objet JSON est attendu.");
  const { course, createdAt, index, types } = raw;
  if (typeof course !== "string" || !course) throw new Error("Plan illisible : « course » manquant.");
  if (!isRecord(index)) throw new Error("Plan illisible : « index » manquant.");
  for (const [label, n] of Object.entries(index))
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw new Error(`Plan illisible : compte invalide pour « ${label} ».`);
  if (!Array.isArray(types) || !types.length) throw new Error("Plan illisible : « types » vide ou manquant.");
  const out: RegroupType[] = types.map((t, i) => {
    if (!isRecord(t) || typeof t.label !== "string" || !t.label.trim()) throw new Error(`Plan illisible : type n° ${i + 1} sans label.`);
    if (!Array.isArray(t.members) || !t.members.length || t.members.some((m) => typeof m !== "string"))
      throw new Error(`Plan illisible : « ${t.label} » n'a pas de membres.`);
    const lec = t.lecture_no;
    if (lec != null && (typeof lec !== "number" || !Number.isInteger(lec))) throw new Error(`Plan illisible : lecture invalide pour « ${t.label} ».`);
    const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    return { label: t.label, method: text(t.method), category: text(t.category), archetype: text(t.archetype), members: t.members as string[], lecture_no: lec ?? null };
  });
  return { course, createdAt: typeof createdAt === "string" ? createdAt : "", index: index as Record<string, number>, types: out };
}

/**
 * Écarts entre un plan et l'index courant. Liste vide = le plan s'applique tel quel : même jeu de
 * libellés bruts, mêmes comptes, et chaque libellé dans exactement un type. Un seul écart suffit à
 * refuser l'application : le plan a été calculé sur un autre index que celui de cette base.
 */
export function planMismatches(plan: RegroupPlan, rawCount: Map<string, number>): string[] {
  const gaps: string[] = [];
  for (const [label, n] of rawCount) {
    const planned = plan.index[label];
    if (planned === undefined) gaps.push(`« ${label} » (×${n}) est dans l'index mais pas dans le plan`);
    else if (planned !== n) gaps.push(`« ${label} » : ${n} exo(s) dans l'index, ${planned} dans le plan`);
  }
  for (const label of Object.keys(plan.index))
    if (!rawCount.has(label)) gaps.push(`« ${label} » est dans le plan mais plus dans l'index`);

  const owners = new Map<string, number>();
  for (const t of plan.types)
    for (const m of new Set(t.members)) {
      if (!rawCount.has(m)) { if (plan.index[m] === undefined) gaps.push(`« ${t.label} » regroupe « ${m} », inconnu de l'index`); continue; }
      owners.set(m, (owners.get(m) ?? 0) + 1);
    }
  for (const label of rawCount.keys()) {
    const k = owners.get(label) ?? 0;
    if (k === 0) gaps.push(`« ${label} » n'appartient à aucun type du plan`);
    else if (k > 1) gaps.push(`« ${label} » appartient à ${k} types du plan`);
  }
  return gaps;
}

/** Une notion telle qu'affichée : son nombre d'occurrences et le chapitre où elle est rangée. */
export type NotionLine = { label: string; count: number; lectureNo: number | null };

/** Résumé chiffré d'une partition (pour comparer avant et après). */
export function partitionStats(notions: NotionLine[]): { notions: number; once: number; max: number; occurrences: number; unattached: number } {
  const fallen = notions.filter((n) => n.count > 0);
  return {
    notions: fallen.length,
    once: fallen.filter((n) => n.count === 1).length,
    max: fallen.reduce((m, n) => Math.max(m, n.count), 0),
    occurrences: fallen.reduce((s, n) => s + n.count, 0),
    unattached: fallen.filter((n) => n.lectureNo == null).length,
  };
}

/**
 * Liste lisible d'une partition, chapitre par chapitre dans l'ordre du plan, notions par nombre
 * d'occurrences décroissant ; les notions sans chapitre viennent à la fin.
 */
export function renderPartition(notions: NotionLine[], chapters: { lecture_no: number | null; title: string }[]): string {
  const lines: string[] = [];
  const order = (a: NotionLine, b: NotionLine) => b.count - a.count || a.label.localeCompare(b.label);
  const known = new Set(chapters.map((c) => c.lecture_no).filter((n): n is number => n != null));
  chapters.forEach((c, i) => {
    const inCh = notions.filter((n) => n.lectureNo != null && n.lectureNo === c.lecture_no).sort(order);
    lines.push(`${i + 1}. ${c.title} : ${inCh.length} notion(s), ${inCh.reduce((s, n) => s + n.count, 0)} occurrence(s)`);
    for (const n of inCh) lines.push(`     ×${n.count}  ${n.label}`);
  });
  const loose = notions.filter((n) => n.lectureNo == null || !known.has(n.lectureNo)).sort(order);
  if (loose.length) {
    lines.push(`Non rattachées : ${loose.length} notion(s), ${loose.reduce((s, n) => s + n.count, 0)} occurrence(s)`);
    for (const n of loose) lines.push(`     ×${n.count}  ${n.label}`);
  }
  return lines.join("\n");
}
