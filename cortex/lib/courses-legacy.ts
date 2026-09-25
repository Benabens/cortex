/**
 * CATALOGUE HISTORIQUE — figé, lu UNE seule fois : c'est la graine de la
 * migration « cours en base » (db/courses-store.ts). Ce n'est plus le registre
 * du produit : à l'exécution, les cours viennent de la table `courses` du store
 * global (cf. lib/courses.ts).
 *
 * ⚠️ NE PLUS MODIFIER. Les valeurs ci-dessous alimentent les prompts et la garde
 * LaTeX de `cs-202` : l'invariant de non-régression (prompt + .tex byte-identiques)
 * exige qu'elles restent EXACTEMENT celles d'avant la mise en base. Ajouter un
 * cours se fait désormais depuis l'interface, pas ici.
 */

export type LegacyCourse = {
  id: string;
  name: string;
  short: string;
  examCode: string;
  examName: string;
  examKind: string;
  university: string;
  universityLines: string[];
  faculty: string;
  profs: string[];
  /** Profil curaté associé (lib/profiles/…) ; null → profil générique dérivé de l'ADN. */
  profileId: string | null;
  durationMin: number;
  examDate?: string;
  /** Chemins HISTORIQUES, relatifs à data/ — conservés tels quels (aucune donnée ne bouge). */
  dbFile: string;
  refsRel: string;
  examsRel: string;
  uploadsRel: string;
  /** Racine de contenu, relative au cwd (cortex/) — pas à data/. */
  contentRel: string;
};

const EPFL_LINES = [
  "École Polytechnique Fédérale de Lausanne",
  "Eidgenössische Technische Hochschule -- Lausanne",
  "Politecnico Federale -- Losanna",
  "Swiss Federal Institute of Technology -- Lausanne",
];

export const LEGACY_COURSES: LegacyCourse[] = [
  {
    id: "cs-202",
    name: "Computer Systems",
    short: "CS-202",
    examCode: "CS-202",
    examName: "Computer Systems",
    examKind: "Final Exam",
    university: "EPFL",
    universityLines: EPFL_LINES,
    faculty: "Faculté Informatique et Communications",
    profs: ["Argyraki K.", "Kashyap S.", "Chappelier J.-C."],
    profileId: "cs-202",
    durationMin: 180,
    examDate: "2026-06-16",
    dbFile: "cortex.db",
    refsRel: "refs",
    examsRel: "exams",
    uploadsRel: "uploads",
    contentRel: "..", // racine du repo (sources en lecture seule)
  },
  {
    id: "algo",
    name: "Algorithms",
    short: "Algo",
    examCode: "CS-250",
    examName: "Algorithms",
    examKind: "Final Exam",
    university: "EPFL",
    universityLines: EPFL_LINES,
    faculty: "Faculté Informatique et Communications",
    profs: [],
    profileId: "algo",
    durationMin: 180,
    dbFile: "algo/algo.db",
    refsRel: "algo/refs",
    examsRel: "algo/exams",
    uploadsRel: "algo/uploads",
    contentRel: "data/algo/content",
  },
  {
    id: "ml",
    name: "Introduction to Machine Learning",
    short: "ML",
    examCode: "CS-233",
    examName: "Introduction to Machine Learning",
    examKind: "Final Exam",
    university: "EPFL",
    universityLines: EPFL_LINES,
    faculty: "Faculté Informatique et Communications",
    profs: ["Dr. Mathieu Salzmann"],
    profileId: "ml",
    durationMin: 180,
    dbFile: "ml/ml.db",
    refsRel: "ml/refs",
    examsRel: "ml/exams",
    uploadsRel: "ml/uploads",
    contentRel: "data/ml/content",
  },
  {
    // Cours FACTICE de preuve « zéro-code » : matière inventée, institution fictive,
    // annales fabriquées. Aucun profil dédié → le moteur dérive tout de ses annales.
    id: "fictif",
    name: "Quantitative Oenology (cours factice de test)",
    short: "QO-101",
    examCode: "QO-101",
    examName: "Quantitative Oenology",
    examKind: "Final Exam",
    university: "Institut Polytechnique Fictif de Testville",
    universityLines: ["Institut Polytechnique Fictif de Testville"],
    faculty: "Faculté Fictive des Sciences du Vin",
    profs: [],
    profileId: null,
    durationMin: 120,
    dbFile: "fictif/fictif.db",
    refsRel: "fictif/refs",
    examsRel: "fictif/exams",
    uploadsRel: "fictif/uploads",
    contentRel: "data/fictif/content",
  },
];
