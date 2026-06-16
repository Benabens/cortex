import { enterCourse, sqlite } from "@/db/client";
import { buildQcmArtifact } from "@/lib/qcm-latex";

enterCourse(process.env.CORTEX_COURSE || "ml");
const examId = Number(process.argv[2] || 2);
const dateLabel = process.argv[3] || "June 16, 2026";

const items = (sqlite.prepare(`SELECT * FROM qcm_items WHERE exam_id=? ORDER BY idx`).all(examId) as any[]).map((r) => ({
  idx: r.idx, topic: r.topic, type: r.type, stem: r.stem,
  options: JSON.parse(r.options_json), correct: JSON.parse(r.correct_json),
  misconceptions: JSON.parse(r.misconceptions_json), explanation: r.explanation, verified: r.verified,
}));
const open = (sqlite.prepare(`SELECT * FROM exam_questions WHERE exam_id=?`).all(examId) as any[]).map((r) => ({
  concept: r.concept, statement_tex: r.statement_html, solution_tex: r.solution_html,
}));
console.log(`exam #${examId}: ${items.length} QCM (scq=${items.filter(i=>i.type==='scq').length}, mcq=${items.filter(i=>i.type==='mcq').length}) + ${open.length} open`);
(async () => {
  const out = await buildQcmArtifact(examId, { items: items as any, open: open as any }, dateLabel);
  console.log("rendered:", JSON.stringify(out));
})();
