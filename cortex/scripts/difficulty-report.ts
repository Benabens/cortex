/**
 * Rapport A/B de difficulté (V3, preuve Phase 6) : compare proof/<slug>.avant.json et .apres.json
 * → écrit proof/<slug>.AB.md (métriques + journal d'audit adversarial). À lire avec les 2 PDFs.
 *
 *   npx tsx scripts/difficulty-report.ts <slug>
 */
import fs from "node:fs";
import path from "node:path";

const slug = process.argv[2];
if (!slug) { console.error("usage: difficulty-report.ts <slug>"); process.exit(1); }
const dir = path.join(process.cwd(), "data", "refs", "proof");
const load = (m: string) => JSON.parse(fs.readFileSync(path.join(dir, `${slug}.${m}.json`), "utf8"));

// titres avec \texttt{} imbriqués → on compte les \subq et on extrait les points (…}{N} final).
const RE_GRID = /\\(packetgrid|forwardgrid|diskgrid|statesim|rulelines|tcpladder)\{?([0-9]*)\}?/g;

function metrics(rec: any) {
  const st: string = rec.statement_tex ?? "";
  const subqCount = (st.match(/\\subq\{/g) ?? []).length;
  const pts = [...st.matchAll(/\}\{(\d{1,3})\}/g)].map((m) => +m[1]).filter((n) => n <= 60);
  const grids = [...st.matchAll(RE_GRID)].map((m) => `${m[1]}${m[2] ? `{${m[2]}}` : ""}`);
  const tf = (st.match(/True or False|True\\\/False|vrai\s*\/\s*faux/gi) ?? []).length;
  const awk = [...new Set((st.match(/\b\d{3,}\b/g) ?? []))].slice(0, 14);
  return { subqCount, pts, grids, tf, awk, lenS: st.length, lenSol: (rec.solution_tex ?? "").length, verified: rec.verified, seconds: rec.seconds, examId: rec.examId };
}

const a = load("avant"), b = load("apres");
const ma = metrics(a), mb = metrics(b);

const lines: string[] = [];
lines.push(`# Difficulté AVANT / APRÈS — « ${slug} »`, "");
lines.push(`Cible : ${a.target}`, "");
lines.push(`| | AVANT (mono-passe) | APRÈS (architecte) |`);
lines.push(`|---|---|---|`);
lines.push(`| exam id (PDF) | #${ma.examId} | #${mb.examId} |`);
lines.push(`| sous-questions | ${ma.subqCount} | ${mb.subqCount} |`);
lines.push(`| barèmes (pts) | ${ma.pts.join("+")} | ${mb.pts.join("+")} |`);
lines.push(`| grilles | ${ma.grids.join(" ") || "—"} | ${mb.grids.join(" ") || "—"} |`);
lines.push(`| sous-questions vrai/faux | ${ma.tf} | ${mb.tf} |`);
lines.push(`| nombres non ronds | ${ma.awk.join(", ")} | ${mb.awk.join(", ")} |`);
lines.push(`| longueur énoncé / corrigé | ${ma.lenS} / ${ma.lenSol} | ${mb.lenS} / ${mb.lenSol} |`);
lines.push(`| vérifié (justesse) | ${ma.verified} | ${mb.verified} |`);
lines.push(`| temps | ${ma.seconds}s | ${mb.seconds}s |`);
lines.push("");

if (Array.isArray(b.auditLog) && b.auditLog.length) {
  lines.push(`## Journal d'audit adversarial (APRÈS) — la preuve « ça discrimine »`, "");
  b.auditLog.forEach((au: any, i: number) => {
    lines.push(`### Passe ${i + 1} — verdict : **${au.verdict}**`);
    lines.push(`- Pattern-matcher répond : « ${au.pattern_matcher_answer} » → **${au.pattern_matcher_correct ? "JUSTE (trop facile !)" : "FAUX (la question discrimine ✓)"}**`);
    lines.push(`- Étudiant fort : ${au.strong_student_stuck ? "**CALE** (cassé)" : "résout"} — « ${(au.strong_student_answer ?? "").slice(0, 200)} »`);
    if (au.rubric_misses?.length) lines.push(`- Rubrique non cochée : ${au.rubric_misses.join(" ; ")}`);
    lines.push(`- Piège présent : ${au.trap_present ? "oui" : "non"}${au.verdict !== "good" ? ` · durcissement : ${au.hardening}` : ""}`);
    lines.push("");
  });
}

const outP = path.join(dir, `${slug}.AB.md`);
fs.writeFileSync(outP, lines.join("\n"));
console.log(`écrit : ${outP}`);
console.log(lines.join("\n"));
