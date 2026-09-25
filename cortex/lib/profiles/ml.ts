import type { Archetype } from "@/lib/archetypes";
import type { CourseProfile } from "@/lib/course-profile";
import { makeGenericProfile } from "@/lib/profiles/generic";

/**
 * Archétypes MACHINE LEARNING (CS-433-like). Figures = frontières de décision, courbes de
 * perte, schémas de réseau, plots 2D. Aucune macro réseau/OS.
 */
export const ML_ARCHETYPES: Archetype[] = [
  {
    id: "gradient-backprop",
    category: "Optimization",
    concept: "Gradients, backpropagation and gradient descent",
    structure: "UN petit réseau / une fonction de perte concrète. 1) écrire la perte, 2) calculer les gradients (chain rule) à la main sur des valeurs NUMÉRIQUES, 3) un pas de (S)GD avec un learning rate donné, 4) effet du learning rate / divergence.",
    grid: "\\rulelines pour les calculs + tableau des valeurs intermédiaires",
    figure: "schéma de réseau (nodes/couches) ou graphe de calcul en TikZ",
    trap: "oublier un terme de la chain rule ; signe du gradient ; learning rate trop grand (divergence)",
    weight: 3,
    topics: ["gradient", "backpropagation", "backprop", "gradient descent", "sgd", "chain rule", "learning rate"],
  },
  {
    id: "bias-variance",
    category: "Generalization",
    concept: "Bias-variance tradeoff, over/underfitting, regularization",
    structure: "UN scénario d'apprentissage (courbes train/test). 1) diagnostiquer bias vs variance, 2) effet de la complexité du modèle / régularisation λ, 3) cross-validation, 4) choix justifié.",
    grid: "courbes à tracer/annoter + \\rulelines",
    figure: "courbes d'erreur train/validation vs complexité en TikZ (pgfplots-like / lignes)",
    trap: "confondre bias et variance ; λ trop grand = underfit ; data leakage en CV",
    weight: 3,
    topics: ["bias", "variance", "overfitting", "underfitting", "regularization", "cross-validation", "generalization"],
  },
  {
    id: "linear-logistic",
    category: "Linear Models",
    concept: "Linear and logistic regression (loss, normal equations, MLE)",
    structure: "UN petit jeu de données 2D. 1) poser la perte (MSE / log-loss), 2) équations normales ou un pas de gradient à la main, 3) frontière de décision, 4) interprétation probabiliste (MLE).",
    grid: "tableau de données + \\rulelines",
    figure: "nuage de points 2D + frontière de décision en TikZ",
    trap: "oublier le biais ; sigmoïde mal appliquée ; non-séparabilité linéaire",
    weight: 2,
    topics: ["linear regression", "logistic regression", "mse", "log loss", "normal equations", "mle", "decision boundary"],
  },
  {
    id: "svm-kernels",
    category: "Kernels",
    concept: "SVM, margins and kernels",
    structure: "1) marge et vecteurs supports sur un jeu 2D, 2) effet du paramètre C, 3) kernel trick (pourquoi / quel kernel), 4) primal vs dual.",
    grid: "\\rulelines + tableau",
    figure: "points 2D + hyperplan + marges (vecteurs supports) en TikZ",
    trap: "marge dure vs molle ; non-séparabilité ; mauvais choix de kernel",
    weight: 2,
    topics: ["svm", "margin", "support vector", "kernel", "hinge loss", "dual"],
  },
  {
    id: "unsupervised",
    category: "Unsupervised",
    concept: "k-means and PCA",
    structure: "1) dérouler k-means sur des points (assignations, centroïdes) étape par étape, 2) sensibilité à l'init, 3) PCA : composantes principales, variance expliquée, 4) projection.",
    grid: "tableau d'assignations/centroïdes par itération + \\rulelines",
    figure: "nuage de points + clusters/centroïdes ou axes PCA en TikZ",
    trap: "k-means converge vers un optimum LOCAL ; standardisation avant PCA ; signe des composantes",
    weight: 2,
    topics: ["k-means", "clustering", "pca", "principal component", "unsupervised", "variance explained"],
  },
  {
    id: "neural-dims",
    category: "Neural Nets",
    concept: "Neural network and CNN dimensioning",
    structure: "UN réseau/CNN concret. 1) compter les paramètres par couche, 2) dimensions des activations (conv/pool stride/padding), 3) effet d'une couche, 4) nombre d'opérations.",
    grid: "tableau couche → (forme, #params) + \\rulelines",
    figure: "schéma d'architecture (couches, tailles) en TikZ",
    trap: "formule conv output size (stride/padding) ; partage de poids ; oubli du biais",
    weight: 1,
    topics: ["neural network", "cnn", "convolution", "parameters", "stride", "padding", "pooling", "dimensions"],
  },
];

export const mlProfile: CourseProfile = makeGenericProfile("ml", ML_ARCHETYPES);
