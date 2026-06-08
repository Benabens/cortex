/**
 * Imprime le contexte d'une faiblesse pour que Claude Code (moi) l'analyse :
 * sujet + note + chemin du screenshot (que je lis comme image).
 * Lancer : npm run weakness:brief -- <id>
 */
import path from "node:path";
import { sqlite } from "../db/client";

const id = Number(process.argv[2]);
if (!id) {
  console.error("usage: npm run weakness:brief -- <id>");
  process.exit(1);
}
const w = sqlite
  .prepare("SELECT topic, description, screenshot_path FROM weaknesses WHERE id = ?")
  .get(id) as { topic: string; description: string | null; screenshot_path: string | null } | undefined;
if (!w) {
  console.error("faiblesse introuvable");
  process.exit(1);
}
console.log("TOPIC:", w.topic);
console.log("NOTE:", w.description || "(aucune)");
console.log(
  "SCREENSHOT:",
  w.screenshot_path ? path.join(process.cwd(), "data", "uploads", w.screenshot_path) : "(aucun)"
);
