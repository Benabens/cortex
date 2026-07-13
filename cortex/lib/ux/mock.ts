// Données MOCK réalistes — AUCUN back-end. Conçois l'UI contre CES formes de données.
// (Tu peux enrichir/ajouter des entrées pour peupler joliment les écrans.)

export const course = { code: "CS-233", name: "Introduction to Machine Learning", term: "2025" };

export const dashboard = {
  greeting: "Bon après-midi",
  next: { title: "Gradient Descent & Optimization", theme: "Optimization", weightPct: 16, status: "JAMAIS_VU" as const },
  mastery: { pct: 47, mastered: 17, total: 36 },
  coverage: { pct: 62, covered: 22, total: 36 },
  revisionsDue: { due: 3, planned: 5 },
  weaknessesTracked: { count: 4, severe: 1 },
  weaknesses: [
    { title: "SVM à marge souple (soft margin) & paramètre C", severity: "GROS" as const },
    { title: "Rétropropagation — dérivées en chaîne", severity: "MOYEN" as const },
    { title: "Régularisation L1 vs L2", severity: "LÉGER" as const },
  ],
  recent: [
    { label: "Examen blanc — Régression & biais", when: "il y a 2 j", score: "78%" },
    { label: "Drill — Descente de gradient", when: "hier", score: "5/6" },
  ],
};

export type Severity = "GROS" | "MOYEN" | "LÉGER";
export type WState = "RATÉE" | "EN_COURS" | "VUE";
export const weaknesses = [
  { title: "SVM à marge souple & paramètre C", desc: "Confusion marge / régularisation", severity: "GROS" as Severity, state: "RATÉE" as WState, source: "Exo série 7 · raté", corpus: ["Kernels", "Final 2024 · Q4"] },
  { title: "Descente de gradient — taux d'apprentissage", desc: "Divergence quand le pas est trop grand", severity: "GROS" as Severity, state: "RATÉE" as WState, source: "Final 2023 · Q2 · raté", corpus: ["Optimisation", "Cours 4"] },
  { title: "Rétropropagation", desc: "Dérivées en chaîne mal enchaînées", severity: "MOYEN" as Severity, state: "EN_COURS" as WState, source: "Discussion collée", corpus: ["MLP", "Cours 9"] },
  { title: "PCA — interprétation des axes", desc: "Confond variance expliquée et corrélation", severity: "MOYEN" as Severity, state: "VUE" as WState, source: "Screenshot slide", corpus: ["Non-supervisé", "Cours 11"] },
  { title: "Biais-variance — lecture des courbes", desc: "Repère mal le point d'équilibre", severity: "MOYEN" as Severity, state: "EN_COURS" as WState, source: "Exo série 5", corpus: ["Généralisation"] },
  { title: "Régularisation L1 vs L2", desc: "Sparsité vs shrinkage", severity: "LÉGER" as Severity, state: "VUE" as WState, source: "Screenshot slide", corpus: ["Régression"] },
  { title: "Softmax & cross-entropy", desc: "Gradient de la cross-entropy", severity: "LÉGER" as Severity, state: "VUE" as WState, source: "Discussion collée", corpus: ["Classification"] },
];

export const program = [
  { n: 1, section: "Fondements & régression", types: [
    { id: "1.1", title: "Régression linéaire (forme fermée)", desc: "pinv, biais, X^T X singulière", weightPct: 7, status: "EN_COURS", masteryPct: 48 },
    { id: "1.2", title: "Ridge & Lasso", desc: "shrinkage, sparsité, chemin de régularisation", weightPct: 3, status: "EN_COURS", masteryPct: 40 },
    { id: "1.3", title: "Biais-variance & sur-apprentissage", desc: "décomposition, courbes d'apprentissage", weightPct: 4, status: "SOLIDE", masteryPct: 78 },
  ]},
  { n: 2, section: "Classification", types: [
    { id: "2.1", title: "SVM & kernels", desc: "marge, paramètre C, noyau RBF", weightPct: 12, status: "JAMAIS_VU", masteryPct: 0 },
    { id: "2.2", title: "Régression logistique", desc: "cross-entropy, softmax", weightPct: 7, status: "SOLIDE", masteryPct: 82 },
    { id: "2.3", title: "k-NN & LDA", desc: "distances, frontières de décision", weightPct: 3, status: "EN_COURS", masteryPct: 35 },
    { id: "2.4", title: "Naive Bayes", desc: "indépendance conditionnelle", weightPct: 1, status: "SOLIDE", masteryPct: 76 },
  ]},
  { n: 3, section: "Réseaux de neurones", types: [
    { id: "3.1", title: "MLP & rétropropagation", desc: "gradient, chain rule", weightPct: 14, status: "EN_COURS", masteryPct: 55 },
    { id: "3.2", title: "CNN — convolutions & pooling", desc: "champs récepteurs, partage de poids", weightPct: 4, status: "JAMAIS_VU", masteryPct: 0 },
  ]},
  { n: 4, section: "Optimisation", types: [
    { id: "4.1", title: "Descente de gradient & optimisation", desc: "pas, momentum, convergence", weightPct: 16, status: "JAMAIS_VU", masteryPct: 0 },
    { id: "4.2", title: "SGD & mini-batch", desc: "variance, taux d'apprentissage", weightPct: 4, status: "EN_COURS", masteryPct: 42 },
  ]},
  { n: 5, section: "Régularisation & généralisation", types: [
    { id: "5.1", title: "Régularisation L1 vs L2", desc: "sparsité vs shrinkage", weightPct: 6, status: "EN_COURS", masteryPct: 30 },
    { id: "5.2", title: "Validation croisée", desc: "k-fold, sélection de modèle", weightPct: 3, status: "SOLIDE", masteryPct: 80 },
    { id: "5.3", title: "Dimension VC & bornes", desc: "capacité, généralisation", weightPct: 1, status: "JAMAIS_VU", masteryPct: 0 },
  ]},
  { n: 6, section: "Apprentissage non-supervisé", types: [
    { id: "6.1", title: "k-means", desc: "inertie, initialisation, k", weightPct: 5, status: "SOLIDE", masteryPct: 84 },
    { id: "6.2", title: "PCA", desc: "variance, vecteurs propres", weightPct: 6, status: "EN_COURS", masteryPct: 60 },
    { id: "6.3", title: "Mélanges gaussiens (GMM)", desc: "EM, responsabilités", weightPct: 2, status: "JAMAIS_VU", masteryPct: 0 },
  ]},
  { n: 7, section: "Méthodes ensemblistes", types: [
    { id: "7.1", title: "Forêts aléatoires", desc: "bagging, importance des variables", weightPct: 2, status: "EN_COURS", masteryPct: 45 },
    { id: "7.2", title: "Boosting", desc: "AdaBoost, gradient boosting", weightPct: 2, status: "JAMAIS_VU", masteryPct: 0 },
  ]},
];

export const exams = {
  format: "QCM + OUVERT",
  detected: "Examen final CS-233 sur 100 pts : ~16 questions à choix (SCQ + MCQ) + problèmes ouverts.",
  distribution: [
    { type: "QCM (choix unique)", count: 3, pts: 24 },
    { type: "Questions ouvertes", count: 4, pts: 52 },
    { type: "Preuves", count: 2, pts: 24 },
  ],
  ready: [
    { name: "Examen #4", meta: "2 questions · QCM 16 (16 vér.) + 2 ouvertes", status: "PRÊT" },
    { name: "Examen #3", meta: "3 questions · QCM 16 + 3 ouvertes", status: "PRÊT" },
  ],
};

export const training = {
  themes: ["Descente de gradient", "SVM", "MLP"],
  labs: [
    { name: "Lab 3 — Optimisation", exos: 4, pts: 80, status: "EN_COURS", pct: 35 },
    { name: "Lab 4 — Réseaux", exos: 5, pts: 100, status: "À_FAIRE", pct: 0 },
  ],
  corrections: [
    { title: "SVM — marge maximale", when: "il y a 2h", state: "À_REVOIR", score: "14/20" },
    { title: "Régression — moindres carrés", when: "hier", state: "SOLIDE", score: "18/20" },
  ],
};

export const sources = {
  path: "/Users/ben/Documents/Cortex/ML",
  tree: [ { name: "Finals", count: 2 }, { name: "Solutions", count: 2 }, { name: "Séries", count: 3 }, { name: "Slides", count: 3 } ],
  files: [
    { name: "CS233 Final 2024", type: "PDF", extracts: 5, active: true, folder: "Finals" },
    { name: "CS233 Final 2023", type: "PDF", extracts: 4, active: false, folder: "Finals" },
    { name: "CS233 Final 2024 — solutions", type: "PDF", extracts: 9, active: true, folder: "Solutions" },
    { name: "CS233 Final 2023 — solutions", type: "PDF", extracts: 6, active: false, folder: "Solutions" },
    { name: "Série 7 — SVM & kernels", type: "PDF", extracts: 6, active: false, folder: "Séries" },
    { name: "Série 5 — corrigée", type: "PDF", extracts: 4, active: true, folder: "Séries" },
    { name: "Série 3", type: "PDF", extracts: 3, active: false, folder: "Séries" },
    { name: "Cours 4 — Optimisation", type: "PDF", extracts: 7, active: true, folder: "Slides" },
    { name: "Cours 9 — Réseaux", type: "PDF", extracts: 5, active: false, folder: "Slides" },
    { name: "Cheat sheet — SVM", type: "HTML", extracts: 2, active: true, folder: "Slides" },
  ],
  templates: [
    { name: "Final CS-233 2024", year: "2024", checked: true },
    { name: "Final CS-233 2023", year: "2023", checked: true },
    { name: "Midterm CS-233 2024", year: "2024", checked: false },
    { name: "Final CS-233 2022", year: "2022", checked: false },
  ],
  availableCount: 28,
};

export type SearchType = "REVIEW" | "EXO" | "FINAL" | "CHEATSHEET" | "SLIDES" | "CODE";
export type Recency = "week" | "month" | "older";

export const search = {
  suggestions: ["Descente de gradient", "SVM", "backprop", "PCA", "softmax"],
  recency: ["Cette semaine", "Ce mois", "Tout"],
  results: [
    { title: "SVM à marge souple — cas 1/2/3", context: "Classification", type: "CHEATSHEET" as SearchType, when: "il y a 3 j", recency: "week" as Recency },
    { title: "Descente de gradient stochastique", context: "Cours 4 · Optimisation", type: "SLIDES" as SearchType, when: "il y a 5 j", recency: "week" as Recency },
    { title: "Régression logistique 0/1", context: "Série 3 · corrigée", type: "EXO" as SearchType, when: "hier", recency: "week" as Recency },
    { title: "Rétropropagation — dérivation complète", context: "Réseaux de neurones", type: "REVIEW" as SearchType, when: "aujourd'hui", recency: "week" as Recency },
    { title: "Final CS-233 2024 — énoncé", context: "Annales", type: "FINAL" as SearchType, when: "il y a 2 sem.", recency: "month" as Recency },
    { title: "Final CS-233 2024 — corrigé", context: "Annales · solutions", type: "FINAL" as SearchType, when: "il y a 2 sem.", recency: "month" as Recency },
    { title: "PCA — vecteurs propres & variance", context: "Non-supervisé", type: "SLIDES" as SearchType, when: "il y a 8 j", recency: "month" as Recency },
    { title: "softmax & cross-entropy", context: "Classification", type: "CHEATSHEET" as SearchType, when: "il y a 4 j", recency: "week" as Recency },
    { title: "k-means — implémentation NumPy", context: "Labs", type: "CODE" as SearchType, when: "il y a 6 j", recency: "week" as Recency },
    { title: "Backprop en 20 lignes", context: "Snippet", type: "CODE" as SearchType, when: "ce mois", recency: "month" as Recency },
    { title: "Régularisation L1 vs L2", context: "Généralisation", type: "REVIEW" as SearchType, when: "il y a 2 j", recency: "week" as Recency },
    { title: "Série 7 — SVM & kernels", context: "Séries · à corriger", type: "EXO" as SearchType, when: "il y a 9 j", recency: "month" as Recency },
    { title: "Biais-variance — décomposition", context: "Cours 2", type: "SLIDES" as SearchType, when: "le mois dernier", recency: "older" as Recency },
    { title: "Final 2023 — problème 3 (MLP)", context: "Annales", type: "FINAL" as SearchType, when: "l'an dernier", recency: "older" as Recency },
    { title: "Kernels & RBF — aide-mémoire", context: "Classification", type: "CHEATSHEET" as SearchType, when: "il y a 3 sem.", recency: "month" as Recency },
    { title: "Gradient descent — momentum & Adam", context: "Optimisation", type: "REVIEW" as SearchType, when: "aujourd'hui", recency: "week" as Recency },
    { title: "Régression linéaire — forme fermée", context: "Série 1 · corrigée", type: "EXO" as SearchType, when: "le mois dernier", recency: "older" as Recency },
    { title: "GMM & EM — dérivation", context: "Non-supervisé", type: "SLIDES" as SearchType, when: "il y a 12 j", recency: "month" as Recency },
  ],
};
