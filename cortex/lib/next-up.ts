import type { ProgramOverview, TopicView } from "@/lib/program";

/**
 * Accueil « Next up » : la notion à travailler maintenant, puis les suivantes.
 *
 * Fonctions pures au-dessus de `programOverview()` : aucune requête, aucun chiffre calculé ici
 * qui n'existe déjà dans le programme. La notion du haut reste celle de `nextTopic()` (lib/program) ;
 * ce module classe celles qui viennent après, avec la même règle : poids à l'examen × écart de
 * maîtrise × « dû ou jamais vu ».
 * À terme ce classement a sa place dans lib/program (nextTopic = le premier du classement), pour
 * que la règle n'existe qu'à un endroit.
 */

export type NextUpTopic = {
  id: number;
  label: string;
  category: string | null;
  /** Part des questions des finals qui portent sur cette notion, en %. */
  examWeight: number;
  status: TopicView["status"];
  mastery: number | null;
  /** « Tombé N fois » : occurrences indexées si le cours en a, sinon le compte de l'analyse. */
  count: number;
  /** Chapitre du plan du prof où la notion est traitée (null = non rattachée, ou plan non dérivé). */
  chapter: { lectureNo: number | null; title: string } | null;
};

type Ranked = Pick<TopicView, "id" | "examWeight" | "mastery" | "attempts" | "dueAt">;

/** Priorité d'une notion : la même règle que `nextTopic()`. */
export function priorityOf(t: Ranked, now: number): number {
  const gap = (10 - (t.mastery ?? 0)) / 10; // jamais vue → 1
  const due = t.attempts === 0 || (!!t.dueAt && new Date(t.dueAt).getTime() <= now) ? 1 : 0.3;
  return t.examWeight * gap * due;
}

/** Notions par priorité décroissante. À égalité, l'ordre d'entrée est conservé. */
export function rankTopics<T extends Ranked>(topics: T[], now: number = Date.now()): T[] {
  return topics
    .map((t, i) => ({ t, i, p: priorityOf(t, now) }))
    .sort((a, b) => b.p - a.p || a.i - b.i)
    .map((x) => x.t);
}

/** Une notion du programme, réduite à ce que l'Accueil affiche. */
export function toNextUp(t: TopicView, chapters: ProgramOverview["chapters"]): NextUpTopic {
  const ch = t.chapterId == null ? undefined : chapters.find((c) => c.id === t.chapterId);
  return {
    id: t.id,
    label: t.label,
    category: t.category,
    examWeight: t.examWeight,
    status: t.status,
    mastery: t.mastery,
    count: (t.occurrences ?? 0) > 0 ? t.occurrences! : t.examCount,
    chapter: ch ? { lectureNo: ch.lectureNo, title: ch.title } : null,
  };
}

/** Les `limit` notions qui suivent `after` (la notion du haut) dans l'ordre de priorité. */
export function upNext(
  overview: ProgramOverview,
  after: number | null,
  limit = 3,
  now: number = Date.now()
): NextUpTopic[] {
  return rankTopics(overview.topics, now)
    .filter((t) => t.id !== after)
    .slice(0, limit)
    .map((t) => toNextUp(t, overview.chapters));
}
