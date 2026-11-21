/**
 * Barème par exercice d'un examen blanc (audit « formats » du 16/11, a3-P1-6).
 *
 * Quand l'annale donne le barème de chaque exercice (`exam_exercises.points`, relevé à l'indexation),
 * l'examen blanc le reproduit : ses points, triés, vont aux slots dans l'ordre de leurs poids (le plus
 * gros exercice de l'annale au slot le plus lourd), étirés ou resserrés au nombre d'exercices demandé.
 * Le barème n'est retenu que si sa somme est le total que la détection du format a lu dans l'annale :
 * l'indexation extrait aussi des sous-questions (« si elle teste une technique distincte »), et des
 * sujets « au choix » se comptent chacun sur le total ; sans total lu, rien ne permet de les écarter.
 *
 * Sinon, le total se partage selon les poids des slots du blueprint (archétypes d'un profil curaté,
 * parts égales d'un profil adaptatif). Le total reste celui du blueprint quel que soit le nombre
 * d'exercices demandé, comme dans le compositeur : 8 exercices sur un blueprint de 6 ne font plus
 * 250 points au lieu de 180, et 3 exercices sur 6 gardent les 180 points de l'examen.
 *
 * Écartés, faute de signal fiable avant génération :
 * - le nombre de sous-questions : le modèle dimensionne ses sous-questions d'après les points qu'on lui
 *   impose (une grosse question : 4 à 7 \subq), et changer les points après coup désaccorderait le
 *   corrigé, qui détaille les points par sous-question ;
 * - la longueur dans l'annale : `statement` est un résumé de 1 à 3 phrases, et l'écart entre les pages
 *   de début (`exam_page`) vaut 0 pour tous les exercices d'une même page.
 */
import { q } from "@/db/q";
import { readStoredProfile } from "@/lib/exam-format";
import { splitPoints } from "@/lib/profiles/generic";

/**
 * Les points de chaque exercice de l'annale la plus récente qui les donne tous (au moins deux, aucun
 * nul), quand leur somme est le total de l'annale ; null sinon (cf. en-tête).
 */
export async function annaleExercisePoints(): Promise<number[] | null> {
  const total = (await readStoredProfile())?.total_points;
  if (!(typeof total === "number" && total > 0)) return null;
  type Row = { exam_title: string; exam_year: number | null; points: number | null };
  let rows: Row[] = [];
  try {
    rows = await q.all<Row>(
      `SELECT exam_title, exam_year, points FROM exam_exercises WHERE exam_title IS NOT NULL
       ORDER BY (exam_year IS NULL), exam_year DESC, exam_title, exam_page, id`
    );
  } catch {
    return null;
  }
  const annales = new Map<string, (number | null)[]>();
  for (const r of rows) {
    const key = `${r.exam_title}|${r.exam_year ?? ""}`;
    if (!annales.has(key)) annales.set(key, []);
    annales.get(key)!.push(r.points);
  }
  for (const points of annales.values()) {
    if (points.length < 2 || !points.every((p): p is number => typeof p === "number" && p > 0)) continue;
    if (Math.abs(points.reduce((s, p) => s + p, 0) - total) < 0.5) return points;
  }
  return null;
}

/**
 * Des poids ramenés à `n` sujets en gardant leur masse : chaque poids occupe une part égale de
 * [0, 1], chaque sujet reçoit ce qui tombe dans la sienne. 6 poids sur 3 sujets : deux par sujet ;
 * 6 sur 7 : chaque sujet prend un morceau d'un ou deux poids voisins.
 */
export function resampleWeights(weights: number[], n: number): number[] {
  const k = weights.length;
  if (k === n) return weights.slice();
  return Array.from({ length: n }, (_, i) => {
    const [a, b] = [i / n, (i + 1) / n];
    return weights.reduce((s, w, j) => s + w * Math.max(0, Math.min(b, (j + 1) / k) - Math.max(a, j / k)), 0);
  });
}

/**
 * Les points des slots, dans leur ordre : le barème de l'annale (total = sa somme) s'il est connu,
 * réparti par rang de poids des slots ; sinon `total` partagé selon les poids des slots.
 */
export function exercisePoints(slotWeights: number[], total: number, annale: number[] | null): number[] {
  if (!annale) return splitPoints(total, slotWeights);
  const n = slotWeights.length;
  const sorted = [...annale].sort((x, y) => y - x);
  // Autant d'exercices que l'annale : ses points tels quels (12 et 18 ne deviennent pas 10 et 20).
  const pts = sorted.length === n ? sorted : splitPoints(annale.reduce((s, p) => s + p, 0), resampleWeights(sorted, n)).sort((x, y) => y - x);
  // Rang de chaque slot par poids décroissant (à égalité, l'ordre du blueprint).
  const rank = slotWeights.map((w, i) => ({ w, i })).sort((x, y) => y.w - x.w || x.i - y.i);
  const out = new Array<number>(n);
  rank.forEach(({ i }, r) => { out[i] = pts[r]; });
  return out;
}
