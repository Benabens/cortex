import type { Archetype } from "@/lib/archetypes";
import type { CourseProfile } from "@/lib/course-profile";
import { makeGenericProfile } from "@/lib/profiles/generic";

/**
 * Archétypes ALGORITHMS (CS-250-like). Figures = arbres, graphes, tableaux de DP, récursion.
 * Aucune macro réseau/OS : les figures sont dessinées en TikZ libre.
 */
export const ALGO_ARCHETYPES: Archetype[] = [
  {
    id: "dynamic-programming",
    category: "Dynamic Programming",
    concept: "Dynamic programming: recurrence, table, and reconstruction",
    structure: "UN problème d'optimisation concret (sac à dos / sous-séquence / découpe). 1) définir le sous-problème et la récurrence, 2) remplir le tableau de DP sur une instance NUMÉRIQUE, 3) reconstruire la solution optimale, 4) complexité temps/espace.",
    grid: "tableau de DP à remplir (\\begin{tabular} avec \\rule) + \\rulelines pour les justifications",
    figure: "tableau de DP (lignes = items/positions, colonnes = capacité/index) en TikZ ou tabular",
    trap: "cas de base mal posé ; double comptage ; ordre de remplissage qui viole les dépendances ; égalité dans l'argmax",
    weight: 3,
    topics: ["dynamic programming", "dp", "knapsack", "recurrence", "memoization", "subsequence", "edit distance"],
  },
  {
    id: "graph-traversal",
    category: "Graphs",
    concept: "Graph traversal and structure (BFS/DFS, components, topological order)",
    structure: "UN graphe concret dessiné (8-12 sommets). 1) exécuter BFS/DFS depuis une source (ordre de visite, arbre), 2) classer les arêtes (tree/back/cross), 3) composantes / tri topologique, 4) propriété à prouver brièvement.",
    grid: "tableau d'ordre de visite + \\rulelines",
    figure: "graphe dirigé/non-dirigé en TikZ (nodes + edges étiquetées)",
    trap: "ordre de visite dépendant de l'ordre des voisins (préciser) ; back-edge ⇔ cycle ; graphe non connexe",
    weight: 3,
    topics: ["graph", "bfs", "dfs", "topological", "components", "traversal", "edges"],
  },
  {
    id: "shortest-path",
    category: "Graphs",
    concept: "Shortest paths (Dijkstra / Bellman-Ford)",
    structure: "UN graphe pondéré. 1) dérouler Dijkstra étape par étape (distances, file de priorité), 2) effet d'une arête NÉGATIVE (pourquoi Dijkstra échoue), 3) Bellman-Ford + détection de cycle négatif, 4) complexité.",
    grid: "tableau distances/prédécesseurs par itération (\\begin{tabular}) + \\rulelines",
    figure: "graphe pondéré orienté en TikZ",
    trap: "arête de poids négatif ; relaxation dans le mauvais ordre ; égalité de distances",
    weight: 2,
    topics: ["shortest path", "dijkstra", "bellman-ford", "weighted", "relaxation", "negative"],
  },
  {
    id: "greedy-exchange",
    category: "Greedy",
    concept: "Greedy algorithms and exchange-argument proofs",
    structure: "UN problème (intervalles / ordonnancement / Huffman). 1) appliquer la règle gloutonne sur une instance, 2) donner un contre-exemple à une règle naïve, 3) PROUVER l'optimalité par argument d'échange, 4) complexité.",
    grid: "\\rulelines pour la preuve + tableau de la trace gloutonne",
    figure: "diagramme d'intervalles / arbre de Huffman en TikZ",
    trap: "règle gloutonne plausible mais FAUSSE ; choix de tri qui change le résultat",
    weight: 2,
    topics: ["greedy", "exchange argument", "interval scheduling", "huffman", "optimal"],
  },
  {
    id: "divide-conquer",
    category: "Divide & Conquer",
    concept: "Divide & conquer and recurrence analysis (Master theorem)",
    structure: "UN algorithme récursif. 1) écrire la récurrence T(n), 2) résoudre par Master theorem / arbre de récursion, 3) comparer à une variante, 4) cas où le théorème ne s'applique pas.",
    grid: "arbre de récursion + \\rulelines",
    figure: "arbre de récursion en TikZ (niveaux, coût par niveau)",
    trap: "cas du Master theorem mal identifié ; terme non polynomial ; sous-problèmes de tailles inégales",
    weight: 2,
    topics: ["divide and conquer", "master theorem", "recurrence", "merge sort", "recursion tree"],
  },
  {
    id: "complexity-proof",
    category: "Complexity",
    concept: "Asymptotic complexity and lower bounds",
    structure: "1) borner la complexité d'un bout de pseudo-code, 2) prouver une borne O/Ω/Θ par définition, 3) comparer deux fonctions, 4) borne inférieure (decision tree / adversaire).",
    grid: "\\rulelines pour les preuves",
    figure: "(optionnelle) arbre de décision en TikZ",
    trap: "confondre O et Θ ; constantes cachées ; somme de séries mal bornée",
    weight: 1,
    topics: ["complexity", "asymptotic", "big-o", "lower bound", "proof", "theta", "omega"],
  },
];

export const algoProfile: CourseProfile = makeGenericProfile("algo", ALGO_ARCHETYPES);
