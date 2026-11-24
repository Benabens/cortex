/**
 * INTERRUPTEURS DES NOUVELLES VÉRIFICATIONS (décision de Ben, 24/11/2026). Chaque contrôle ajouté
 * coûte des appels : il ne tourne en prod que si son coût tient dans le prix de l'action.
 *
 *  - CORTEX_CHECK_REVIEW : relecture de check_answer (re-résolution sans la réponse de l'étudiant,
 *    comparaison). ACTIVE par défaut (banc du 24/11 : p95 0,22 $ pour une aide à 0,3 crédit) ;
 *    « 0 » la coupe.
 *  - CORTEX_DRILL_REVIEW : relecture du drill (re-résolution sans le corrigé, comparaison, une
 *    réécriture). COUPÉE par défaut (p95 0,31 $ > 0,3 crédit) ; « 1 » l'active (prévu le 01/12, aide
 *    à 0,5 crédit).
 *  - CORTEX_VERIFY_V2 : nouvelle chaîne d'examen et de QCM — re-résolution sans le corrigé puis
 *    comparaison, égalités recalculées, hypothèses manquantes, réparation avant régénération, clé
 *    fausse retirée ; audit QCM « expert hors du cours » avec énoncé réparé. COUPÉE par défaut :
 *    gain non démontré au banc (CS-202 7/8 puis 4/8 contre 6/8) ; « 1 » l'active.
 */

/** Relecture de check_answer : active sauf CORTEX_CHECK_REVIEW=0. */
export function checkReviewEnabled(): boolean {
  return process.env.CORTEX_CHECK_REVIEW !== "0";
}

/** Relecture du drill : seulement avec CORTEX_DRILL_REVIEW=1. */
export function drillReviewEnabled(): boolean {
  return process.env.CORTEX_DRILL_REVIEW === "1";
}

/** Nouvelle vérification des examens et des QCM : seulement avec CORTEX_VERIFY_V2=1. */
export function verifyV2Enabled(): boolean {
  return process.env.CORTEX_VERIFY_V2 === "1";
}
