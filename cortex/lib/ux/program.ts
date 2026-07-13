/**
 * Helpers Programme — travaillent sur les VRAIS topics de GET /api/program.
 * Regroupement par `category`, maîtrise back 0–10 → %, garde anti-Buffer.
 * Aucune donnée inventée : les seuls dérivés sont le tri et les « points à gagner »
 * (= poids × (1 − maîtrise)), calcul client documenté dans MAPPING.md.
 */

import { asText } from "@/lib/ux/api";
import { toStatus, type MaybeText, type DashStats } from "@/lib/ux/types";
import type { Status } from "@/lib/ux/labels";

/** Topic brut renvoyé par GET /api/program (formes confirmées par curl). */
export type ProgramTopic = {
  id: number;
  label: MaybeText;
  method: MaybeText;
  exoType: MaybeText;
  trap: MaybeText;
  category: MaybeText;
  archetype: MaybeText;
  examWeight: number;
  examCount: number;
  source: MaybeText;
  description: MaybeText;
  mastery: number | null; // 0–10
  attempts: number;
  lastScore: number | null;
  lastDoneAt: string | null;
  lastExamId: number | null;
  dueAt: string | null;
  status: string;
};

export type ProgramResp = {
  topics: ProgramTopic[];
  stats: DashStats;
  next: ProgramTopic | null;
  coverNext: ProgramTopic | null;
};

/** Type d'exo prêt pour l'UI (textes coercés, % dérivés). */
export type UiType = {
  key: number;
  num: string; // numérotation présentationnelle "section.index"
  title: string;
  desc: string | null;
  section: string;
  sectionN: number;
  weightPct: number;
  mastery10: number | null;
  masteryPct: number; // 0–100 (0 si jamais fait)
  status: Status;
  examCount: number;
};

export type SectionAgg = {
  n: number;
  section: string;
  types: UiType[];
  weight: number;
  /** part de l'examen (%) = poids de la section / poids total du programme.
      Les poids bruts du back ne somment pas forcément à 100 → on normalise. */
  sharePct: number;
  masteryWeighted: number;
  coveredCount: number;
};

/** Points encore récupérables à l'examen = poids × (1 − maîtrise). */
export function pointsAtStake(t: { weightPct: number; masteryPct: number }): number {
  return Math.round(((t.weightPct * (100 - t.masteryPct)) / 100) * 10) / 10;
}

/**
 * Topics réels → sections UI (groupées par catégorie, ordonnées par poids total
 * décroissant ; types triés par poids dans chaque section). Les topics au label
 * corrompu/vide sont écartés (rien d'affichable honnêtement).
 */
export function buildSections(topics: ProgramTopic[]): SectionAgg[] {
  const byCat = new Map<string, ProgramTopic[]>();
  for (const t of topics) {
    if (!asText(t.label)) continue;
    const cat = asText(t.category) ?? "Autres";
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat)!.push(t);
  }

  const cats = [...byCat.entries()].sort(
    (a, b) =>
      b[1].reduce((s, t) => s + t.examWeight, 0) - a[1].reduce((s, t) => s + t.examWeight, 0)
  );

  const grandTotal = [...byCat.values()].flat().reduce((s, t) => s + t.examWeight, 0) || 1;

  return cats.map(([section, raw], ci) => {
    const sorted = [...raw].sort((a, b) => b.examWeight - a.examWeight);
    const types: UiType[] = sorted.map((t, ti) => {
      const masteryPct =
        t.mastery === null ? 0 : Math.max(0, Math.min(100, Math.round(t.mastery * 10)));
      return {
        key: t.id,
        num: `${ci + 1}.${ti + 1}`,
        title: asText(t.label)!,
        desc: asText(t.description) ?? asText(t.exoType) ?? asText(t.method),
        section,
        sectionN: ci + 1,
        weightPct: t.examWeight,
        mastery10: t.mastery,
        masteryPct,
        status: toStatus(t.status, t.mastery),
        examCount: t.examCount,
      };
    });
    const weight = types.reduce((a, t) => a + t.weightPct, 0);
    const wm = types.reduce((a, t) => a + t.weightPct * t.masteryPct, 0);
    return {
      n: ci + 1,
      section,
      types,
      weight: Math.round(weight * 10) / 10,
      sharePct: Math.round((weight / grandTotal) * 100),
      masteryWeighted: weight ? Math.round(wm / weight) : 0,
      coveredCount: types.filter((t) => t.status !== "JAMAIS_VU").length,
    };
  });
}

/** Part de l'examen encore à prendre (%) = stake total / poids total (normalisé). */
export function stakeSharePct(types: UiType[]): number {
  const totalWeight = types.reduce((a, t) => a + t.weightPct, 0) || 1;
  return Math.round((types.reduce((a, t) => a + pointsAtStake(t), 0) / totalWeight) * 100);
}

export function flatten(sections: SectionAgg[]): UiType[] {
  return sections.flatMap((s) => s.types);
}

export function byPriority(types: UiType[]): UiType[] {
  return [...types].sort((a, b) => pointsAtStake(b) - pointsAtStake(a));
}

/** Somme des points encore récupérables (dérivé, arrondi entier). */
export function totalStake(types: UiType[]): number {
  return Math.round(types.reduce((a, t) => a + pointsAtStake(t), 0));
}
