import fs from "node:fs";
import path from "node:path";

/**
 * Révision du PROJET ML (CS-233), Milestones 1 & 2.
 *
 * Contenu PRÉ-CONSTRUIT et COMMITTÉ dans `data/ml/project-revision.json` : explication exhaustive
 * (architecture + mécanique + choix/hyperparamètres + résultats), questions de défense du prof avec
 * leurs réponses, et QCM/ouvertes sur le projet. La page `/projet` charge ce JSON tel quel — rien à
 * relancer après un `git pull`. Aucune dépendance à la DB, à l'ingestion ou à une clé API.
 *
 * ⚠️ Lecture seule du code du groupe (`data/ml/project/m1`, `m2`) : l'app explique, elle ne réécrit rien.
 */

export type Block =
  | { type: "prose"; text: string }
  | { type: "callout"; label?: string; text: string }
  | { type: "code"; lang?: string; code: string; caption?: string }
  | { type: "table"; headers: string[]; rows: string[][]; caption?: string }
  | { type: "list"; items: string[] };

export type Section = {
  id: string;
  title: string;
  milestone: "m1" | "m2" | "both";
  summary: string;
  blocks: Block[];
};

export type ProfQuestion = {
  id: number;
  milestone: "m1" | "m2" | "both";
  category: string;
  question: string;
  answer: string;
  keyPoint: string;
  codeRef?: string;
};

export type Qcm = {
  id: number;
  milestone: "m1" | "m2";
  topic: string;
  difficulty?: "facile" | "moyen" | "difficile";
  question: string;
  options: string[];
  correct: "A" | "B" | "C" | "D";
  explanation: string;
  verified?: boolean;
  verifyMethod?: string;
};

export type OpenQuestion = {
  id: number;
  milestone: "m1" | "m2";
  topic: string;
  question: string;
  answer: string;
  keyPoint: string;
};

export type ProjectRevision = {
  course: string;
  title: string;
  note: string;
  project: {
    title: string;
    course: string;
    scipers: string[];
    dataset: string;
    milestones: { id: string; label: string; methods: string[] }[];
  };
  sections: Section[];
  profQuestions: ProfQuestion[];
  qcm: Qcm[];
  open: OpenQuestion[];
  stats: { sections: number; profQuestions: number; qcm: number; qcmVerified: number; open: number };
};

function jsonPath(): string {
  return path.join(process.cwd(), "data", "ml", "project-revision.json");
}

/** Charge le JSON committé (source de vérité portable). null si absent/illisible. */
export function loadProjectRevision(): ProjectRevision | null {
  try {
    const f = jsonPath();
    return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as ProjectRevision) : null;
  } catch {
    return null;
  }
}
