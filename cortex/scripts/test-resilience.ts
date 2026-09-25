/** Preuve RÉSILIENCE : un lot qui « timeout » est ignoré, le job livre l'examen partiel ;
 *  zéro question → erreur claire (jamais de crash total). Déterministe (stub, sans appel LLM). */
import { enterCourse } from "@/db/client";
import { generateExamViaClaudeCode } from "@/lib/exam";
import { examsDir } from "@/lib/paths";
import fs from "node:fs"; import path from "node:path";

enterCourse("ml");
try { fs.unlinkSync(path.join(examsDir(), ".gen-checkpoint.json")); } catch {}
process.env.CORTEX_TEST_STUB_BATCH = "1"; // lots déterministes, aucun appel LLM

(async () => {
  // (1) PARTIEL : on force le timeout des lots 1+ → seul le lot 0 survit. Le job doit CONTINUER.
  process.env.CORTEX_TEST_FAIL_BATCHES = "1,2,3,4,5,6,7";
  let partialOk = false, partialMsg = "";
  try {
    const res = await generateExamViaClaudeCode({ verify: false, onStep: (s) => { if (/PARTIEL|ignoré|timeout|Terminé/.test(s)) partialMsg += "   · " + s + "\n"; } });
    partialOk = !!res.id;
    console.log(`(1) PARTIEL → examen #${res.id} livré (url ${res.url}). Pas de crash. ✓`);
    console.log(partialMsg.trimEnd());
  } catch (e) { console.log("(1) ÉCHEC inattendu :", (e as Error).message); }

  try { fs.unlinkSync(path.join(examsDir(), ".gen-checkpoint.json")); } catch {}

  // (2) TOUT échoue : zéro question → erreur CLAIRE (pas un crash silencieux ni une page sèche).
  process.env.CORTEX_TEST_FAIL_BATCHES = "0,1,2,3,4,5,6,7,8,9";
  let cleanError = false;
  try {
    await generateExamViaClaudeCode({ verify: false });
    console.log("(2) ÉCHEC : aurait dû lever une erreur claire.");
  } catch (e) {
    cleanError = /Aucune question/.test((e as Error).message);
    console.log(`(2) TOUT échoue → erreur claire : « ${(e as Error).message.slice(0, 80)}… » ${cleanError ? "✓" : "✗"}`);
  }

  console.log(partialOk && cleanError ? "\n✅ OK : partiel livré sans crash ; échec total = erreur claire réessayable." : "\n❌ ÉCHEC");
  process.exit(partialOk && cleanError ? 0 : 1);
})();
