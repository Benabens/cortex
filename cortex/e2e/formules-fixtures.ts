// i18n-allow-file: contenu d'examen fictif (énoncés, corrigés), jamais affiché hors test et démo
/**
 * EXAMENS FICTIFS AVEC FORMULES (e2e/formules.spec.ts) : un QCM, une question composée et un retour
 * de correction, tels que les routes de l'app les renvoient. Textes inventés, sans LLM.
 */

export const QCM_ID = 9101;
export const BLOCKS_ID = 9102;

export const QCM_EXAM = {
  id: QCM_ID, status: "ready", verifySummary: null, pdf: null, solutions: null, open: [],
  items: [
    {
      id: 1, idx: 0, topic: "Suites", type: "scq", verified: 1,
      stem: String.raw`Soit la suite définie par $x_{t+1} = 2x_t$ et $x_1 = 3$. Que vaut $\frac{x_3}{x_1}$ ?`,
      options: ["$2$", "$4$", String.raw`$\frac{1}{4}$`, "$x_1^2$"],
    },
    {
      id: 2, idx: 1, topic: "Dérivées", type: "scq", verified: 1,
      stem: String.raw`Quelle est la dérivée de \(f(x) = \sqrt{x^2 + 1}\) ?`,
      options: [String.raw`$\frac{x}{\sqrt{x^2 + 1}}$`, "$2x$", String.raw`$\frac{1}{2\sqrt{x}}$`],
    },
  ],
};

export const QCM_GRADE = {
  score: 1, total: 2, openSolutions: [],
  detail: [
    { idx: 0, correct: [1], chosen: [0], ok: false, points: 0, explanation: String.raw`On a $x_3 = 2^2 x_1$, donc $\frac{x_3}{x_1} = 4$.`, misconceptions: [String.raw`Confond $x_2$ et $x_3$.`, "", "", ""] },
    { idx: 1, correct: [0], chosen: [0], ok: true, points: 1, explanation: String.raw`Dérivée d'une composée : $f'(x) = \frac{2x}{2\sqrt{x^2 + 1}}$.`, misconceptions: ["", "", ""] },
  ],
};

const SCENARIO = String.raw`On étudie la somme partielle $S_n = \sum_{k=1}^{n} \frac{1}{k^2}$ pour $n \ge 1$. On admet que

\[ \sum_{k=1}^{n} \frac{1}{k^2} = 1 + \frac{1}{4} + \frac{1}{9} + \frac{1}{16} + \frac{1}{25} + \frac{1}{36} + \frac{1}{49} + \frac{1}{64} + \cdots \le \frac{\pi^2}{6} \]`;

export const BLOCKS_EXAM = {
  kind: "blocks", id: BLOCKS_ID, createdAt: "2026-11-23 10:00:00", status: "ready", verifySummary: null, pdf: null, solutions: null, requested: 1, missing: [],
  blocks: [{
    id: 1, idx: 0, title: "Séries de Riemann", section: null, scenario: SCENARIO, points: 3,
    parts: [
      { id: 11, idx: 0, kind: "scq", prompt: "Que vaut $S_2$ ?", code: "", options: [String.raw`$\frac{5}{4}$`, String.raw`$\frac{3}{2}$`, "$1$"], points: 1 },
      { id: 12, idx: 1, kind: "short", prompt: String.raw`Montrer que $S_n \le 2 - \frac{1}{n}$ pour tout $n \ge 1$.`, code: "", options: [], points: 2 },
    ],
  }],
};

export const BLOCKS_GRADE = {
  score: 1, total: 3, pending: 1,
  detail: [
    { partId: 11, kind: "scq", ok: true, points: 1, max: 1, correct: 0, answer: "", criteria: [], explanation: String.raw`$S_2 = 1 + \frac{1}{4} = \frac{5}{4}$.` },
    {
      partId: 12, kind: "short", ok: null, points: 0, max: 2, correct: -1,
      answer: String.raw`Par récurrence : \[ S_{n+1} \le 2 - \frac{1}{n} + \frac{1}{(n+1)^2} \le 2 - \frac{1}{n+1} \]`,
      criteria: [{ label: "Initialisation : $S_1 = 1$", points: 1 }, { label: String.raw`Hérédité avec $\frac{1}{(n+1)^2} \le \frac{1}{n} - \frac{1}{n+1}$`, points: 1 }],
      explanation: "",
    },
  ],
};

export const CHECK_RESULT = {
  verdict: "partial",
  feedback: String.raw`L'idée de la récurrence est juste, mais il manque l'inégalité $\frac{1}{(n+1)^2} \le \frac{1}{n(n+1)}$.`,
  correct_solution: "",
  score: { earned: 1, total: 2 },
  criteria: [
    { label: "Initialisation : $S_1 = 1$", points: 1, achieved: true, essential: true, justification: String.raw`Le cas $n = 1$ donne $S_1 = 1 \le 1$.` },
    { label: "Hérédité", points: 1, achieved: false, essential: true, justification: String.raw`Le passage de $S_n$ à $S_{n+1}$ n'est pas justifié.` },
  ],
};
