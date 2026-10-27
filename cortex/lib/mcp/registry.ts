import checkAnswer from "./tools/check-answer";
import generateDrill from "./tools/generate-drill";
import generateMockExam from "./tools/generate-mock-exam";
import getAccountStatus from "./tools/get-account-status";
import getJobStatus from "./tools/get-job-status";
import getResults from "./tools/get-results";
import getStudyPlan from "./tools/get-study-plan";
import getWeakPoints from "./tools/get-weak-points";
import listCourses from "./tools/list-courses";
import searchCourseMaterials from "./tools/search-course-materials";
import type { ToolDef } from "./tool";

/**
 * REGISTRE DES OUTILS — liste explicite (le bundler de Next ne découvre pas un
 * dossier à l'exécution). Ajouter un outil = un fichier dans tools/ + une ligne
 * ici. Ordre alphabétique : `tools/list` déterministe (cache de prompt du client).
 * Les règles d'un registre sain sont vérifiées au chargement : un nom invalide
 * ou en double fait échouer le démarrage plutôt qu'un appel chez le client.
 */
const ALL: ToolDef[] = [
  checkAnswer, generateDrill, generateMockExam, getAccountStatus, getJobStatus,
  getResults, getStudyPlan, getWeakPoints, listCourses, searchCourseMaterials,
] as unknown as ToolDef[];

function validate(tools: ToolDef[]): ToolDef[] {
  const seen = new Set<string>();
  for (const t of tools) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(t.name)) throw new Error(`Outil MCP au nom invalide : ${t.name}`);
    if (seen.has(t.name)) throw new Error(`Outil MCP en double : ${t.name}`);
    if (!t.title || t.description.length < 40) throw new Error(`Outil MCP sans titre ou description : ${t.name}`);
    seen.add(t.name);
  }
  return [...tools].sort((a, b) => a.name.localeCompare(b.name));
}

export const TOOLS: readonly ToolDef[] = validate(ALL);
