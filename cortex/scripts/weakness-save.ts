/**
 * Enregistre l'analyse d'une faiblesse rédigée par Claude Code.
 * Lancer : npm run weakness:save -- <id> <fichier.json>
 * JSON : { "topic": "...", "concepts": ["..."], "explanation": "..." }
 */
import fs from "node:fs";
import { updateWeaknessAnalysis } from "../lib/weaknesses";

const id = Number(process.argv[2]);
const file = process.argv[3];
if (!id || !file) {
  console.error("usage: npm run weakness:save -- <id> <fichier.json>");
  process.exit(1);
}
const a = JSON.parse(fs.readFileSync(file, "utf8")) as {
  topic: string;
  concepts: string[];
  explanation: string;
};
const description = `${a.explanation}\n\nConcepts clés : ${(a.concepts ?? []).join(" · ")}`;
(async () => {
  await updateWeaknessAnalysis(id, a.topic, description);
  console.log(`✓ Faiblesse #${id} mise à jour (${a.topic}).`);
})();
