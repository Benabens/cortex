/**
 * Enregistre un examen rédigé (par Claude Code) : DB + HTML + répétition espacée.
 * Lancer : npm run exam:save -- <chemin/vers/exam.json>
 * Le JSON doit suivre le schéma ExamSpec ({ title, questions: [...] }).
 */
import fs from "node:fs";
import { persistExam } from "../lib/exam";

const file = process.argv[2];
if (!file) {
  console.error("usage: npm run exam:save -- <fichier.json>");
  process.exit(1);
}
const spec = JSON.parse(fs.readFileSync(file, "utf8"));
persistExam(spec)
  .then((res) => console.log(`✓ Examen #${res.id} enregistré → ${res.url}`))
  .catch((e) => {
    console.error("Échec :", e?.message ?? e);
    process.exit(1);
  });
