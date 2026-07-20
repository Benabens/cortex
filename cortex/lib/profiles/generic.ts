import { q } from "@/db/q";
import type { Archetype } from "@/lib/archetypes";
import { genericRefImageFor, genericVisionBlock } from "@/lib/course-vision";
import type { CourseProfile, Slot } from "@/lib/course-profile";
import { getCourse } from "@/lib/courses";
import { genericDirectivesBlock } from "@/lib/profiles/generic-directives";
import { getExamDna, sampleMolds } from "@/lib/exam-dna";

/**
 * Profil GÉNÉRIQUE pour un cours autre que cs-202 (algo, ml, …).
 * Réutilise le FRAMEWORK (format EPFL, garde, vérif à l'aveugle, grilles \rulelines, jobs)
 * mais SANS les macros/figures/directives propres à cs-202 (pas de \examtopo réseau ni d'inode OS).
 * Les figures sont dessinées en TikZ libre selon la matière (arbres, graphes, plots…).
 */

/** Notes/study-guide du cours ingérées (toutes les notes de la DB du cours). */
async function genericStaffNotes(max: number): Promise<string> {
  let rows: { text: string }[] = [];
  try {
    rows = await q.all<{ text: string }>(
      `SELECT i.text FROM items i JOIN sources s ON s.id = i.source_id
       WHERE s.type = 'note' ORDER BY s.recency_weight DESC, s.title`
    );
  } catch {}
  let out = rows.map((r) => r.text).join("\n\n");
  if (out.length > max) out = out.slice(0, max) + " […]";
  return out;
}

const GENERIC_LATEX_CONTRACT = [
  `═══ FORMAT DE SORTIE : LaTeX COMPILABLE (pdflatex/tectonic), PAS de HTML ═══`,
  `\`statement_tex\` et \`solution_tex\` contiennent du LaTeX (le CORPS seulement). N'écris NI \\documentclass, NI \\usepackage, NI \\begin{document}, NI l'en-tête de question, NI l'espace réponse (le système les ajoute).`,
  `Macros disponibles (utilise-les) :`,
  `  - \\subq{1.1}{Titre de la sous-question}{16}  → en-tête de sous-question avec points.`,
  `  - \\cn{1} \\cn{2} \\cn{3}  → énumérateurs entourés ① ② ③.`,
  `  - \\callout{This question is \\textbf{\\large FOR ALL STUDENTS.}}  → encadré centré.`,
  `  - \\rulelines{6}  → APRÈS CHAQUE sous-question : un espace-réponse ligné (choisis le nb de lignes selon la charge attendue). JAMAIS un simple blanc.`,
  `Conventions LaTeX :`,
  `  - Listes : \\begin{itemize}...\\end{itemize} ; options a) b) c) : \\begin{enumerate}[label=\\alph*)]...\\end{enumerate}.`,
  `  - Code/pseudo-code : \\begin{lstlisting} ... \\end{lstlisting}. Maths : $...$ et \\[ ... \\] (aligne avec align*).`,
  `  - Tableaux À REMPLIR : \\begin{tabular}{|l|c|c|}\\hline ... \\\\\\hline \\end{tabular} avec des \\rule{2.5cm}{0.4pt} pour les cases vides.`,
  `  - FIGURES = vraies figures TikZ adaptées à la MATIÈRE (arbres, graphes, tableaux de DP, frontières de décision, courbes de perte, schémas), PLEINE LARGEUR, centrées, légendées \\figcaption{Figure N: ...}. Dessine chaque figure toi-même en TikZ (n'utilise aucune macro de figure prédéfinie).`,
  `RÈGLES DE COMPILATION : échappe \\% \\& \\# \\_ dans le texte ; équilibre accolades/environnements ; pas de markdown ; pas d'images externes ; LaTeX qui COMPILE du premier coup.`,
].join("\n");

/**
 * moteur-v2 (P5) — ARCHÉTYPES NEUTRES pour un cours SANS module d'archétypes dédié : le squelette
 * minimal (un exercice d'examen creusé) — AUCUN contenu de matière. Tout le « caractère » du cours
 * (moules, figures, texture, style) vient alors de l'ADN détecté depuis SES annales.
 * = onboarding ZÉRO-CODE : ajouter un cours dans lib/courses.ts + déposer ses annales suffit.
 */
export function genericArchetypes(): Archetype[] {
  return [
    {
      id: "exam-exercise",
      category: "General",
      concept: "exercice d'examen du cours (artefact concret creusé par sous-questions)",
      structure: "UN artefact concret (problème, instance, jeu de données, programme, système) creusé par 4-6 sous-questions en escalier qui testent les interactions entre concepts.",
      grid: "espace de réponse ligné (\\rulelines) ou tableau à remplir selon la charge",
      figure: "si la question s'y prête : figure TikZ ou FIGURE SPEC (plot) dans l'idiome des annales du cours",
      trap: "un cas-limite/une idée fausse RÉELLE du cours (dérivée des annales), ré-instanciée sur le setup",
      weight: 1,
      topics: [],
    },
  ];
}

/** Construit un profil générique à partir des archétypes d'un cours. */
export function makeGenericProfile(courseId: string, archetypes: Archetype[]): CourseProfile {
  const c = getCourse(courseId);
  const matiere = `${c.examCode} ${c.examName} (${c.university})`;

  const slotsFromArchetypes = async (): Promise<Slot[]> => {
    // 6 slots (ou moins) : archétypes triés par poids × boost faiblesses (la boucle Phase 5),
    // points dégressifs ≈ 180 total.
    let hay = "";
    try {
      hay = (await q.all<{ topic: string; description: string | null }>(
        `SELECT topic, description FROM weaknesses ORDER BY severity DESC LIMIT 10`
      ))
        .map((w) => `${w.topic} ${w.description ?? ""}`)
        .join(" ")
        .toLowerCase();
    } catch {}
    const boost = (a: Archetype) => (a.topics.some((t) => hay.includes(t)) ? 1.5 : 1);
    const sorted = [...archetypes].sort((a, b) => b.weight * boost(b) - a.weight * boost(a));
    const picks = sorted.slice(0, 6);
    const pts = [35, 35, 30, 30, 25, 25];
    // moteur-v2 (P2) — MOULES échantillonnés proportionnellement à l'ADN détecté du cours
    // (moules « ouverts » : un exam d'exercices n'a pas de statement_truefalse). Sans ADN → null.
    const dna = await getExamDna().catch(() => null);
    const molds = sampleMolds(dna, picks.length, {
      only: ["proof_analysis", "derivation", "design", "applied_scenario", "formula_computation", "code_trace", "table_fill", "figure_reading"],
    });
    return picks.map((a, i) => ({
      category: a.category,
      points: pts[i] ?? 20,
      mold: molds[i] ?? null,
      brief: [
        `ARCHÉTYPE « ${a.id} » — ${a.concept}.`,
        `Construction : ${a.structure}`,
        `Grille de réponse : ${a.grid}.`,
        `Figure : ${a.figure}.`,
        `PIÈGE à inclure (ré-instancié sur TON setup, pas recopié) : ${a.trap}.`,
      ].join(" "),
    }));
  };

  return {
    directivesBlock: () => genericDirectivesBlock(c.examCode, c.examName),
    visionBlock: genericVisionBlock, // images-étalon rendues depuis les vrais examens du cours (Phase 2)
    staffNotesText: genericStaffNotes,
    refImageFor: genericRefImageFor,
    latexContract: () => GENERIC_LATEX_CONTRACT,
    archetypes,
    examSlots: slotsFromArchetypes,
    buildBlueprint: slotsFromArchetypes,
    promptIntroFull: () => [
      `Tu es l'équipe enseignante de ${matiere}.`,
      `Tu rédiges un examen final INÉDIT, EN ANGLAIS, indiscernable d'un vrai final EPFL de ${c.examName}. Les CONTRAINTES DURES ci-dessus priment sur tout.`,
      ``,
      `═══ STRUCTURE ═══`,
      `Plusieurs exercices indépendants, notés séparément, ~180 points au total, 3 h.`,
      `PRINCIPE : chaque grosse question (≥25 pts) = UN artefact concret (un problème, une instance, un jeu de données, un algorithme) creusé par 4-7 sous-questions \\subq{N.M}{...}{pts} EN ESCALIER (difficulté croissante) qui testent les INTERACTIONS entre concepts, avec AU MOINS UN VRAI PIÈGE (cas-limite) et des nombres NON RONDS. Profondeur > largeur.`,
    ],
    promptIntroBatch: (n: number) => [
      `Tu es l'équipe enseignante de ${matiere}. Tu rédiges ${n} exercices INÉDITS, EN ANGLAIS, d'un examen final indiscernable d'un vrai final de ${c.examName}.`,
      `PRINCIPE : chaque exercice = UN artefact concret creusé par des sous-questions \\subq{N.M}{...}{pts} en escalier qui testent les INTERACTIONS, avec AU MOINS UN VRAI PIÈGE et des NOMBRES NON RONDS.`,
    ],
    exerciseLead: (target: string, a: Archetype, pts: number, _refImage: string | null) => [
      `Tu rédiges UN SEUL exercice de Final ${c.examCode} EN ANGLAIS, qualité examen, CIBLÉ sur : « ${target} ».`,
      `Archétype à RÉ-INSTANCIER (ne recopie pas) : ${a.concept}. Construction : ${a.structure} Grille de réponse : ${a.grid}. Figure : ${a.figure}. PIÈGE à inclure : ${a.trap}.`,
      `Barème ~${pts} points. UN artefact concret creusé par des sous-questions \\subq{N.M}{...}{pts} en escalier, NOMBRES NON RONDS.`,
    ],
    regenLead: (category: string | undefined, concept: string, points: number | undefined, diagnostic: string, _refImage: string | null) => [
      `Régénère UN SEUL exercice de Final ${c.examCode} EN ANGLAIS, catégorie « ${category} », concept proche de « ${concept} », barème ${points} points.`,
      `La version précédente a ce PROBLÈME à corriger : ${diagnostic}`,
      `Applique le PRINCIPE : UN artefact concret creusé par des sous-questions \\subq{N.M}{...}{pts} en escalier qui testent les INTERACTIONS, avec AU MOINS UN VRAI PIÈGE et des NOMBRES NON RONDS.`,
    ],
    qaIntro: () => `Tu es l'équipe enseignante de ${matiere}.`,
  };
}
