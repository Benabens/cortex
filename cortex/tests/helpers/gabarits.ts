/**
 * Fixtures FICTIVES des gabarits d'examen (aucun contenu de cours réel) : un cours EPFL inventé,
 * deux cours hors EPFL inventés (anglais, français), et un examen de chaque forme (écrit, QCM avec
 * ouvertes, questions composées). Partagées par les tests et par scripts/gabarits-captures.ts.
 * À appeler après avoir posé CORTEX_DATA_DIR.
 */
import type { ExamBlock } from "../../lib/blocks";
import type { QcmExamData } from "../../lib/qcm-latex";

export const DATE = "2026-11-16";

export type GabaritCourses = { epfl: string; neutralEn: string; neutralFr: string };

/** Crée les trois cours fictifs ; renvoie leurs identifiants. */
export async function createGabaritCourses(): Promise<GabaritCourses> {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded, reloadCourses } = await import("../../lib/courses");
  await ensureCoursesLoaded();
  const { buildCourseRow } = await import("../../lib/course-create");
  const { insertCourse } = await import("../../db/courses-store");
  const epfl = buildCourseRow({ name: "Fictional Systems", code: "FIC-101", university: "EPFL", teachers: "Prof. A. Fictif", language: "en", examFormat: { kind: "exercises", durationMin: 120 } }, "owner");
  await insertCourse(epfl);
  const neutralEn = buildCourseRow({ name: "Imaginary Networks", code: "IMG-210", university: "Testville University", teachers: "Dr. B. Example", language: "en", examFormat: { kind: "exercises", durationMin: 90 } }, "owner");
  await insertCourse(neutralEn);
  const neutralFr = buildCourseRow({ name: "Algèbre inventée", code: "INV-300", language: "fr", examFormat: { kind: "exercises", durationMin: 60, documents: "none" } }, "owner");
  await insertCourse(neutralFr);
  await reloadCourses();
  return { epfl: epfl.id, neutralEn: neutralEn.id, neutralFr: neutralFr.id };
}

/** Examen écrit : deux exercices inventés. */
export const WRITTEN_SPEC = {
  title: "Examen fictif",
  duration_min: 120,
  questions: [
    { category: "General", concept: "Toy recurrence", points: 30, statement_tex: String.raw`\subq{1.1}{Closed form}{30} Solve $u_{n+1} = 2u_n + 1$, $u_0 = 0$.\rulelines{4}`, solution_tex: String.raw`$u_n = 2^n - 1$.` },
    { category: "General", concept: "Imaginary queue", points: 20, statement_tex: String.raw`\subq{2.1}{Throughput}{20} A queue serves 3 jobs per second. How many in 7 s?\rulelines{3}`, solution_tex: String.raw`21 jobs.` },
  ],
};

/** QCM inventé (un choix unique, un choix multiple) et une question ouverte. */
export const QCM_DATA: QcmExamData = {
  items: [
    { topic: "Toy arithmetic", type: "scq", stem: "What is 2 + 3?", options: ["4", "5", "6", "7"], correct: [1], misconceptions: ["off by one", "", "doubling", "guess"], explanation: "2 + 3 = 5.", verified: 1 },
    { topic: "Toy parity", type: "mcq", stem: "Which numbers are even?", options: ["2", "3", "4", "5"], correct: [0, 2], misconceptions: ["", "odd", "", "odd"], explanation: "2 and 4 are divisible by 2.", verified: 1 },
  ],
  open: [
    { category: "General", concept: "Invented sequence", points: 10, statement_tex: String.raw`Give the next term of $1, 4, 9, 16$.`, solution_tex: String.raw`$25$, the squares.` } as never,
  ],
};

/** Questions composées inventées : un choix unique, une lecture de code, une réponse courte. */
export const BLOCKS: ExamBlock[] = [
  {
    title: "Imaginary counter", section: null, scenario: "A counter starts at 0 and adds 3 at each step.", points: 9, verified: 1,
    parts: [
      { kind: "scq", prompt: "Value after 2 steps?", code: "", options: ["3", "6", "9"], correct: 1, answer: "", criteria: [], points: 3, explanation: "0 + 3 + 3 = 6." },
      { kind: "code_output", prompt: "What does this print?", code: "print(3 * 2)", options: [], correct: -1, answer: "6", criteria: [], points: 3, explanation: "3 * 2 = 6." },
      { kind: "short", prompt: "Why is the counter always a multiple of 3?", code: "", options: [], correct: -1, answer: "It only adds 3.", criteria: [{ label: "adds 3", points: 3 }], points: 3, explanation: "Induction on steps." },
    ],
  },
];
