import path from "node:path";

/**
 * Registre multi-cours. Le FRAMEWORK (format EPFL, jobs, vérif, recherche, faiblesses)
 * est partagé ; le CORPUS, les DONNÉES, les ARCHÉTYPES et les FIGURES sont PAR COURS.
 *
 * ⚠️ RÈGLE D'OR : `cs-202` est le cours par défaut et sa config pointe EXACTEMENT sur
 * l'existant (data/cortex.db, data/refs, data/exams, data/uploads, contenu à la racine du
 * repo). Tant que le cours courant = cs-202, tous les chemins sont byte-identiques à avant.
 * Aucun autre cours n'écrit jamais dans la base/les dossiers de cs-202.
 */
export type CourseConfig = {
  id: string;
  /** Libellé long (UI). */
  name: string;
  /** Libellé court pour le sélecteur (ex. « CS-202 »). */
  short: string;
  /** Code affiché sur la garde / dans les prompts (ex. « CS-202 »). */
  examCode: string;
  /** Matière (ex. « Computer Systems »). */
  examName: string;
  /** Type d'examen (ex. « Final Exam »). */
  examKind: string;
  /** Établissement (ex. « EPFL »). */
  university: string;
  /** Les lignes institutionnelles de la garde. */
  universityLines: string[];
  /** Faculté (garde). */
  faculty: string;
  /** Enseignant·es. */
  profs: string[];
  /** Module d'archétypes/figures à utiliser ('cs-202' | 'algo' | 'ml'). */
  profile: string;
  /** Durée d'examen par défaut (minutes). */
  durationMin: number;
  /** Date de l'examen (ISO, optionnel) — alimente le compte à rebours du dashboard. */
  examDate?: string;
  /**
   * Chemins. Pour cs-202 = l'existant exact. Pour les autres = sous data/<id>/.
   * Tous résolus en absolu par `coursePaths()`.
   */
  dbFile: string; // relatif à data/
  refsRel: string; // relatif à data/
  examsRel: string; // relatif à data/
  uploadsRel: string; // relatif à data/
  /**
   * Racine du contenu à ingérer. Pour cs-202 = la RACINE du repo (`..`), où vivent
   * reviews.html, exercices/, cours/, labs/, notes/ (sources en lecture seule).
   * Pour les autres = data/<id>/content (Ben y dépose sites/séries/notes/cours).
   * Relatif au cwd (cortex/) — résolu par `coursePaths()`.
   */
  contentRel: string;
};

export const COURSES: Record<string, CourseConfig> = {
  "cs-202": {
    id: "cs-202",
    name: "Computer Systems",
    short: "CS-202",
    examCode: "CS-202",
    examName: "Computer Systems",
    examKind: "Final Exam",
    university: "EPFL",
    universityLines: [
      "École Polytechnique Fédérale de Lausanne",
      "Eidgenössische Technische Hochschule -- Lausanne",
      "Politecnico Federale -- Losanna",
      "Swiss Federal Institute of Technology -- Lausanne",
    ],
    faculty: "Faculté Informatique et Communications",
    profs: ["Argyraki K.", "Kashyap S.", "Chappelier J.-C."],
    profile: "cs-202",
    durationMin: 180,
    examDate: "2026-06-16",
    dbFile: "cortex.db",
    refsRel: "refs",
    examsRel: "exams",
    uploadsRel: "uploads",
    contentRel: "..", // racine du repo (sources en lecture seule)
  },
  algo: {
    id: "algo",
    name: "Algorithms",
    short: "Algo",
    examCode: "CS-250",
    examName: "Algorithms",
    examKind: "Final Exam",
    university: "EPFL",
    universityLines: [
      "École Polytechnique Fédérale de Lausanne",
      "Eidgenössische Technische Hochschule -- Lausanne",
      "Politecnico Federale -- Losanna",
      "Swiss Federal Institute of Technology -- Lausanne",
    ],
    faculty: "Faculté Informatique et Communications",
    profs: [],
    profile: "algo",
    durationMin: 180,
    dbFile: "algo/algo.db",
    refsRel: "algo/refs",
    examsRel: "algo/exams",
    uploadsRel: "algo/uploads",
    contentRel: "data/algo/content",
  },
  ml: {
    id: "ml",
    name: "Introduction to Machine Learning",
    short: "ML",
    examCode: "CS-233",
    examName: "Introduction to Machine Learning",
    examKind: "Final Exam",
    university: "EPFL",
    universityLines: [
      "École Polytechnique Fédérale de Lausanne",
      "Eidgenössische Technische Hochschule -- Lausanne",
      "Politecnico Federale -- Losanna",
      "Swiss Federal Institute of Technology -- Lausanne",
    ],
    faculty: "Faculté Informatique et Communications",
    profs: ["Dr. Mathieu Salzmann"],
    profile: "ml",
    durationMin: 180,
    dbFile: "ml/ml.db",
    refsRel: "ml/refs",
    examsRel: "ml/exams",
    uploadsRel: "ml/uploads",
    contentRel: "data/ml/content",
  },
  // moteur-v2 (P5) — COURS FACTICE de preuve « zéro-code » : matière inventée, institution fictive,
  // 2 annales PDF fabriquées (data/fictif/refs). AUCUN profil dédié, AUCUN archétype matière :
  // le moteur doit dériver format/moules/figures/texture de ses seules annales. Config pure.
  fictif: {
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
    profile: "generic",
    durationMin: 120,
    dbFile: "fictif/fictif.db",
    refsRel: "fictif/refs",
    examsRel: "fictif/exams",
    uploadsRel: "fictif/uploads",
    contentRel: "data/fictif/content",
  },
};

export const DEFAULT_COURSE = "cs-202";

/** Config d'un cours (défaut cs-202 si absent/inconnu — aucun appel existant ne change). */
export function getCourse(id?: string | null): CourseConfig {
  return (id && COURSES[id]) || COURSES[DEFAULT_COURSE];
}

/** id de cours valide (sinon défaut). */
export function normalizeCourse(id?: string | null): string {
  return id && COURSES[id] ? id : DEFAULT_COURSE;
}

export function listCourses(): CourseConfig[] {
  return Object.values(COURSES);
}

// Racine des données mutables (DB sqlite, refs, exams, uploads). CORTEX_DATA_DIR
// permet de la déplacer sur un volume persistant en prod (Railway) ; non posée
// (dev, CI) → ./data, comportement historique inchangé.
const DATA = process.env.CORTEX_DATA_DIR
  ? path.resolve(process.env.CORTEX_DATA_DIR)
  : path.join(process.cwd(), "data");

/** Racine data effective (./data ou CORTEX_DATA_DIR) — partagée avec le store auth. */
export function dataRoot(): string {
  return DATA;
}

export type CoursePaths = {
  dbPath: string;
  refsDir: string;
  examsDir: string;
  uploadsDir: string;
  contentRoot: string;
};

/** Chemins ABSOLUS d'un cours. cs-202 = exactement les chemins historiques. */
export function coursePaths(id?: string | null): CoursePaths {
  const c = getCourse(id);
  return {
    dbPath: path.join(DATA, c.dbFile),
    refsDir: path.join(DATA, c.refsRel),
    examsDir: path.join(DATA, c.examsRel),
    uploadsDir: path.join(DATA, c.uploadsRel),
    contentRoot: path.resolve(process.cwd(), c.contentRel),
  };
}

/** Chemin absolu de la DB d'un cours (utilisé par db/client). */
export function courseDbPath(id?: string | null): string {
  return path.join(DATA, getCourse(id).dbFile);
}
