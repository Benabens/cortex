import { q } from "@/db/q";
import type { Archetype } from "@/lib/archetypes";
import { genericRefImageFor, genericVisionBlock } from "@/lib/course-vision";
import type { CourseProfile, Slot } from "@/lib/course-profile";
import { getCourse } from "@/lib/courses";
import { formatContextFor } from "@/lib/exam-format";
import { genericDirectivesBlock, languageName, type GenericStyle } from "@/lib/profiles/generic-directives";
import { getExamDna, pickCoverage, sampleMolds } from "@/lib/exam-dna";

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
 * ARCHÉTYPES NEUTRES pour un cours SANS module d'archétypes dédié : le squelette
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

/**
 * ARCHÉTYPES DES MATIÈRES NON-STEM (SHS, droit, gestion…) : la question part
 * d'un élément précis du cours (conditions d'une définition, résultat d'étude,
 * tension entre acteurs) et se corrige avec une GRILLE. Aucun contenu de
 * matière : le cours apporte les notions, l'ADN de ses annales le style.
 */
const CONCEPT_CONDITIONS: Archetype = {
  id: "concept-conditions",
  category: "Compréhension",
  concept: "compréhension fine d'une notion : ses conditions de définition mises à l'épreuve",
  structure: "une situation inédite où UNE seule condition de la définition d'une notion du cours change (ou manque) ; 2-3 sous-questions : la notion s'applique-t-elle encore ? quelle condition fait basculer ? que deviendrait la conclusion si… ? Réponses JUSTIFIÉES par les conditions, pas par le nom de la notion.",
  grid: "espace de réponse ligné (\\rulelines) ; corrigé avec GRILLE (critères + points)",
  figure: "aucune, sauf un tableau court si le cours en utilise",
  trap: "un cas qui ressemble à la notion mais viole une condition précise de sa définition (même mesure, une condition change)",
  weight: 1,
  topics: [],
};

const STUDY_EVIDENCE: Archetype = {
  id: "study-evidence",
  category: "Résultats d'études",
  concept: "lecture critique d'un résultat d'étude du cours (auteurs, chiffres, conditions)",
  structure: "un résultat d'étude ou un chiffre PRÉCIS cité dans le cours, reformulé dans un court énoncé (dont une affirmation abusive) ; sous-questions : ce que l'étude montre exactement, ce qu'elle ne permet PAS de conclure (corrélation/causalité, population, condition), une application juste.",
  grid: "espace de réponse ligné (\\rulelines) ; corrigé avec GRILLE (critères + points)",
  figure: "aucune",
  trap: "le bon résultat attribué à la mauvaise étude, inversé, ou sur-généralisé au-delà de ses conditions",
  weight: 1,
  topics: [],
};

const ARGUMENTATION: Archetype = {
  id: "argumentation-essay",
  category: "Argumentation",
  concept: "question d'argumentation / essai : une thèse discutable tirée du cours",
  structure: "une question DISCUTABLE (pas de réponse unique) reliant au moins deux séances du cours ; consigne de longueur ; l'étudiant construit une thèse, des arguments appuyés sur des notions et études PRÉCISES du cours, un contre-argument et une conclusion nuancée.",
  grid: "GRILLE DE CORRECTION explicite : thèse claire, mobilisation exacte des notions (conditions), références précises (études, chiffres), contre-argument traité, structure — avec points par critère",
  figure: "aucune",
  trap: "la réponse facile qui récite les définitions sans les articuler ni discuter leurs limites",
  weight: 1,
  topics: [],
};

const TEXT_CRITIQUE: Archetype = {
  id: "text-critique",
  category: "Critique de texte",
  concept: "critique d'un court texte (analyse d'un tiers, extrait d'article, réponse d'IA) contenant des erreurs",
  structure: "un texte INÉDIT de 120-200 mots qui analyse une situation avec les notions du cours et contient 2-3 erreurs plausibles (notion mal appliquée, condition oubliée, résultat d'étude déformé, causalité abusive) ; l'étudiant les repère, les corrige avec le cours et propose une version juste.",
  grid: "GRILLE : chaque erreur repérée et corrigée (points), justification par le cours, qualité de la version corrigée",
  figure: "aucune",
  trap: "une erreur subtile (bonne notion, mauvaise condition) mêlée à une erreur visible",
  weight: 1,
  topics: [],
};

const ORAL_QUESTION: Archetype = {
  id: "oral-question",
  category: "Oral",
  concept: "question d'oral avec relances de l'examinateur",
  structure: "une question principale ouverte sur un thème du cours + 2-3 RELANCES (contre-exemple, limite d'une notion, lien avec une autre séance) ; le corrigé donne les attendus de chaque étape.",
  grid: "GRILLE : attendus de la réponse principale et de chaque relance, points par élément",
  figure: "aucune",
  trap: "une relance qui fait tomber la réponse récitée (cas où la notion ne s'applique plus)",
  weight: 1,
  topics: [],
};

/** Archétypes d'un cours sans profil curaté, selon le style de son examen. */
export function genericArchetypesFor(style: GenericStyle): Archetype[] {
  if (style === "essay") return [ARGUMENTATION, TEXT_CRITIQUE];
  if (style === "oral") return [ORAL_QUESTION];
  if (style === "humanities") return [CONCEPT_CONDITIONS, STUDY_EVIDENCE, TEXT_CRITIQUE, ARGUMENTATION];
  return genericArchetypes();
}

/** Style des sujets d'un cours : essai et oral suivent le format ; sinon la discipline décide. */
export function genericStyleFor(courseId: string): GenericStyle {
  const f = formatContextFor(courseId);
  if (f.kind === "essay") return "essay";
  if (f.kind === "oral") return "oral";
  return f.discipline === "humanities" ? "humanities" : "problems";
}

/** Nombre de sujets par défaut d'un examen à exercices générique (jamais un slot unique). */
const STYLE_SLOTS: Record<GenericStyle, number> = { problems: 4, humanities: 4, essay: 2, oral: 3 };

/** Notions à couvrir, une par sujet : notions du programme, sinon titres des sources de cours. */
async function coverageLabels(n: number): Promise<string[]> {
  let labels: string[] = [];
  try {
    labels = (await q.all<{ label: string }>(`SELECT label FROM topics ORDER BY exam_weight DESC, exam_count DESC, label`)).map((r) => r.label);
  } catch {}
  if (!labels.length) {
    try {
      labels = (await q.all<{ title: string }>(
        `SELECT DISTINCT s.title FROM sources s WHERE s.type NOT IN ('final','midterm','sample_questions','exam_info') ORDER BY s.recency_weight DESC, s.id`,
      )).map((r) => r.title);
    } catch {}
  }
  return pickCoverage(labels, n);
}

/**
 * Construit un profil générique à partir des archétypes d'un cours.
 *
 * La fiche du cours est lue À L'USAGE, pas ici : depuis que les cours vivent en
 * base, ce module est évalué (via lib/profiles/algo|ml) avant que le cache des
 * cours ne soit rempli — une lecture immédiate ferait échouer le CHARGEMENT de
 * toute route important le moteur. Les textes produits, eux, sont inchangés.
 */
export function makeGenericProfile(courseId: string, archetypes: Archetype[], opts: { adaptive?: boolean } = {}): CourseProfile {
  const c = () => getCourse(courseId);
  const matiere = () => `${c().examCode} ${c().examName} (${c().university})`;
  // Profil CURATÉ (algo, ml) : ses archétypes, et l'anglais de ses annales — inchangés.
  // Profil ADAPTATIF (cours créé sans profil) : langue et archétypes selon le format résolu.
  const adaptive = !!opts.adaptive;
  const style = (): GenericStyle => (adaptive ? genericStyleFor(courseId) : "problems");
  const language = () => (adaptive ? formatContextFor(courseId).language : "en");
  const LANG = () => languageName(language())[0];
  const currentArchetypes = () => (adaptive ? genericArchetypesFor(style()) : archetypes);

  /**
   * Cours adaptatif : N sujets (selon le style), archétypes en rotation, chacun
   * sur une notion DIFFÉRENTE du programme — plus jamais un slot unique qui
   * absorbe tout l'examen.
   */
  const adaptiveSlots = async (): Promise<Slot[]> => {
    const st = style();
    const archs = genericArchetypesFor(st);
    const n = STYLE_SLOTS[st];
    const labels = await coverageLabels(n);
    const dna = st === "problems" ? await getExamDna().catch(() => null) : null;
    const molds = sampleMolds(dna, n, {
      only: ["proof_analysis", "derivation", "design", "applied_scenario", "formula_computation", "code_trace", "table_fill", "figure_reading"],
    });
    const pts = Math.max(5, Math.round(180 / n / 5) * 5);
    return Array.from({ length: n }, (_, i) => {
      const a = archs[i % archs.length];
      const theme = labels.length ? labels[i % labels.length] : null;
      return {
        category: a.category,
        points: pts,
        mold: molds[i] ?? null,
        brief: [
          `ARCHÉTYPE « ${a.id} » — ${a.concept}.`,
          theme ? `THÈME : « ${theme} » (une notion différente pour chaque sujet).` : null,
          `Construction : ${a.structure}`,
          `Grille de réponse : ${a.grid}.`,
          `Figure : ${a.figure}.`,
          `PIÈGE à inclure (ré-instancié sur TON setup, pas recopié) : ${a.trap}.`,
        ].filter(Boolean).join(" "),
      };
    });
  };

  const slotsFromArchetypes = async (): Promise<Slot[]> => {
    if (adaptive) return adaptiveSlots();
    // 6 slots (ou moins) : archétypes triés par poids × boost faiblesses (boucle de rétroaction des faiblesses),
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
    // MOULES échantillonnés proportionnellement à l'ADN détecté du cours
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

  /** Principe de construction d'un sujet, selon le style (le texte « problems » est l'historique). */
  const principle = () =>
    style() === "problems"
      ? `UN artefact concret creusé par des sous-questions \\subq{N.M}{...}{pts} en escalier qui testent les INTERACTIONS, avec AU MOINS UN VRAI PIÈGE et des NOMBRES NON RONDS.`
      : `UN élément PRÉCIS du cours (notion et conditions de sa définition, résultat d'étude, tension entre acteurs) à MOBILISER pour justifier, nuancer ou critiquer — sous-questions \\subq{N.M}{...}{pts}, et une GRILLE de correction dans le corrigé.`;
  const kindLabel = () => ({ problems: "exercices", humanities: "questions", essay: "sujets d'essai", oral: "questions d'oral" })[style()];

  return {
    directivesBlock: () => genericDirectivesBlock(c().examCode, c().examName, language(), style()),
    visionBlock: genericVisionBlock, // images-étalon rendues depuis les vrais examens du cours
    staffNotesText: genericStaffNotes,
    refImageFor: genericRefImageFor,
    latexContract: () => GENERIC_LATEX_CONTRACT,
    get archetypes() { return currentArchetypes(); },
    examSlots: slotsFromArchetypes,
    buildBlueprint: slotsFromArchetypes,
    promptIntroFull: () => style() === "problems" ? [
      `Tu es l'équipe enseignante de ${matiere()}.`,
      `Tu rédiges un examen final INÉDIT, EN ${LANG()}, indiscernable d'un vrai final EPFL de ${c().examName}. Les CONTRAINTES DURES ci-dessus priment sur tout.`,
      ``,
      `═══ STRUCTURE ═══`,
      `Plusieurs exercices indépendants, notés séparément, ~180 points au total, 3 h.`,
      `PRINCIPE : chaque grosse question (≥25 pts) = UN artefact concret (un problème, une instance, un jeu de données, un algorithme) creusé par 4-7 sous-questions \\subq{N.M}{...}{pts} EN ESCALIER (difficulté croissante) qui testent les INTERACTIONS entre concepts, avec AU MOINS UN VRAI PIÈGE (cas-limite) et des nombres NON RONDS. Profondeur > largeur.`,
    ] : [
      `Tu es l'équipe enseignante de ${matiere()}.`,
      `Tu rédiges un examen INÉDIT, EN ${LANG()}, indiscernable d'un vrai examen de ${c().examName}. Les CONTRAINTES DURES ci-dessus priment sur tout.`,
      ``,
      `═══ STRUCTURE ═══`,
      `Plusieurs ${kindLabel()} indépendants, chacun sur une notion différente du programme.`,
      `PRINCIPE : ${principle()}`,
    ],
    promptIntroBatch: (n: number) => style() === "problems" ? [
      `Tu es l'équipe enseignante de ${matiere()}. Tu rédiges ${n} exercices INÉDITS, EN ${LANG()}, d'un examen final indiscernable d'un vrai final de ${c().examName}.`,
      `PRINCIPE : chaque exercice = ${principle()}`,
    ] : [
      `Tu es l'équipe enseignante de ${matiere()}. Tu rédiges ${n} ${kindLabel()} INÉDITS, EN ${LANG()}, d'un examen indiscernable d'un vrai examen de ${c().examName}.`,
      `PRINCIPE : chaque sujet = ${principle()}`,
    ],
    exerciseLead: (target: string, a: Archetype, pts: number, _refImage: string | null) => [
      `Tu rédiges UN SEUL ${style() === "problems" ? `exercice de Final ${c().examCode}` : `sujet d'examen de ${c().examCode}`} EN ${LANG()}, qualité examen, CIBLÉ sur : « ${target} ».`,
      `Archétype à RÉ-INSTANCIER (ne recopie pas) : ${a.concept}. Construction : ${a.structure} Grille de réponse : ${a.grid}. Figure : ${a.figure}. PIÈGE à inclure : ${a.trap}.`,
      style() === "problems"
        ? `Barème ~${pts} points. UN artefact concret creusé par des sous-questions \\subq{N.M}{...}{pts} en escalier, NOMBRES NON RONDS.`
        : `Barème ~${pts} points. ${principle()}`,
    ],
    regenLead: (category: string | undefined, concept: string, points: number | undefined, diagnostic: string, _refImage: string | null) => [
      `Régénère UN SEUL ${style() === "problems" ? `exercice de Final ${c().examCode}` : `sujet d'examen de ${c().examCode}`} EN ${LANG()}, catégorie « ${category} », concept proche de « ${concept} », barème ${points} points.`,
      `La version précédente a ce PROBLÈME à corriger : ${diagnostic}`,
      `Applique le PRINCIPE : ${principle()}`,
    ],
    qaIntro: () => `Tu es l'équipe enseignante de ${matiere()}.`,
  };
}
