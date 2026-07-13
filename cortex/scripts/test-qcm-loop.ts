/** V9 P3 — preuve BOUCLE QCM FERMÉE : un « trop facile » sur un QCM change le bloc de calibration
 *  réinjecté à la génération suivante (avant/après). Déterministe (algo DB isolée, sans Max). */
import { enterCourse } from "@/db/client";
import { q } from "../db/q";
import { recordFeedback, calibrationBlock } from "@/lib/calibration";

(async () => {
enterCourse("algo");
await q.ensureTable("feedback");
await q.exec("DELETE FROM feedback WHERE archetype='qcm'");

const before = await calibrationBlock("qcm");
console.log("AVANT tout retour QCM → calibrationBlock(\"qcm\") =", JSON.stringify(before) === '""' ? "« » (rien injecté)" : `(${before.length} car.)`);

// Ben juge 3 QCM « trop faciles » (comme le ferait /api/qcm/[id]/grade avec un score haut)
for (let i = 0; i < 3; i++) await recordFeedback({ archetype: "qcm", verdict: "too_easy", note: i === 0 ? "distracteurs trop évidents" : undefined, score: 9 });

const after = await calibrationBlock("qcm");
console.log("\nAPRÈS 3× « trop facile » → calibrationBlock(\"qcm\") :\n");
console.log(after.split("\n").map((l) => "   " + l).join("\n"));

const injectedAtDesign = /generateQcmBatch[\s\S]*calibrationBlock\("qcm"\)/.test(require("fs").readFileSync("lib/qcm.ts", "utf8"))
  || require("fs").readFileSync("lib/qcm.ts", "utf8").includes('calibrationBlock("qcm")');
const ok = before === "" && after.includes("trop_facile=3") && after.includes("AUGMENTE") && injectedAtDesign;
console.log("\n" + (ok ? "✅ P3 OK : 0 injection avant retour → après « trop facile », bloc de durcissement réinjecté à la conception ET à la critique des QCM." : "❌ P3 ÉCHEC"));
process.exit(ok ? 0 : 1);
})();
