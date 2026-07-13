import { currentCourse } from "@/db/client";
import { completeText, extractJson } from "@/lib/llm";
import { getCourse } from "@/lib/courses";

export type CheckResult = {
  verdict: "correct" | "partial" | "wrong";
  feedback: string;
  correct_solution: string;
};

/**
 * Vérificateur perso : re-résout la question indépendamment puis compare à la réponse de Ben.
 * Moteur = Claude Code (Max). `imageRel` = chemin relatif au cwd d'une photo de la réponse.
 */
export async function checkSolution(input: { statement: string; answer?: string; imageRel?: string | null }): Promise<CheckResult> {
  const c = getCourse(currentCourse());
  const lines = [
    `Tu es un correcteur rigoureux de ${c.examCode} ${c.examName} (${c.university}).`,
    `VOICI LA QUESTION D'EXAMEN :`,
    input.statement,
    ``,
  ];
  if (input.imageRel) lines.push(`La réponse de l'étudiant est dans l'image située à ${input.imageRel} — lis-la avec l'outil Read (elle peut être manuscrite).`);
  if (input.answer) lines.push(`RÉPONSE DE L'ÉTUDIANT (texte) : « ${input.answer} »`);
  lines.push(
    ``,
    `Procède ainsi :`,
    `1) Résous la question toi-même, de zéro, rigoureusement.`,
    `2) Compare ta solution à la réponse de l'étudiant. Verdict :`,
    `   - "correct" : juste et complet.`,
    `   - "partial" : bonne intuition mais incomplet ou erreur mineure.`,
    `   - "wrong" : faux.`,
    `3) feedback : explication CIBLÉE et actionnable de l'erreur (OÙ et POURQUOI ça coince, ce qu'il faut revoir), en français. Pas de blabla.`,
    `4) correct_solution : la bonne solution, concise mais complète.`,
    `Réponds UNIQUEMENT avec un objet JSON {"verdict","feedback","correct_solution"}. Aucune prose autour, aucune balise markdown.`
  );
  const text = await completeText({ prompt: lines.join("\n"), model: "opus", timeoutMs: 200_000 });
  return extractJson<CheckResult>(text);
}
