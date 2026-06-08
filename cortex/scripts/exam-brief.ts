/**
 * Imprime le "brief" de génération d'examen : contexte (faiblesses, concepts dus,
 * style des anciens examens, matière de cours) + le schéma JSON attendu.
 * Destiné à Claude Code (moi) : je lis ce brief, je rédige l'examen, je l'enregistre
 * via `npm run exam:save`. Zéro coût API (passe par l'abonnement Max).
 *
 * Lancer : npm run exam:brief
 */
import { buildBrief } from "../lib/exam";

console.log(buildBrief());
