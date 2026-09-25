/**
 * Directives génériques (format + difficulté) pour un cours autre que cs-202.
 * PAS d'exclusions matière (cs-202 a les siennes dans lib/directives.ts) : ici on cadre
 * surtout la LANGUE, la PROFONDEUR et le RÉALISME. Le scope matière vient du study-guide
 * ingéré (staffNotesText) + des vrais examens de référence du cours.
 */
export function genericDirectivesBlock(examCode: string, examName: string): string {
  return [
    `═══════════════════════════════════════════════════════════════════════════`,
    `CONTRAINTES DURES — ${examCode} ${examName}`,
    `═══════════════════════════════════════════════════════════════════════════`,
    ``,
    `🧩 FORMAT :`,
    `  - LANGUE : 100% ANGLAIS — titres ET corps de tous les énoncés et corrigés en anglais.`,
    `  - Modèles de format = les VRAIS examens de référence du cours fournis (mêmes types de questions, même ton, même mise en page). N'invente pas de format : calque celui des past-exams.`,
    `  - SCOPE : ne génère QUE sur les sujets du study-guide / des notes du cours et des past-exams ci-dessous. Ne sors pas du programme.`,
    `  - PRINCIPE DE CONSTRUCTION : chaque grosse question part d'UN SEUL artefact concret et non-trivial (un problème, une instance, un jeu de données, un algorithme) creusé par 4-7 SOUS-QUESTIONS EN ESCALIER (difficulté croissante) qui testent les INTERACTIONS entre concepts, avec AU MOINS UN VRAI PIÈGE (cas-limite, frontière). Profondeur > largeur. Pas de questions déconnectées ni de simples vrai/faux.`,
    ``,
    `📐 DIFFICULTÉ : niveau d'un vrai final EPFL — nombres NON RONDS, charge de calcul/raisonnement réelle, cas-limites. L'étudiant moyen doit transpirer.`,
    `═══════════════════════════════════════════════════════════════════════════`,
  ].join("\n");
}
