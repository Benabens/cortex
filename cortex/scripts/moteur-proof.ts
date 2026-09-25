/**
 * PREUVE par cours : compare le DERNIER examen généré à l'ADN détecté
 * (distribution des moules, figures, largeur des sujets) + liste les artefacts (PDF, vérifiés).
 *   npx tsx scripts/moteur-proof.ts <course>
 * Écrit data/refs/proof/moteur/mock-<course>.md. Générique (aucune matière).
 */
import fs from "node:fs";
import path from "node:path";
import { enterCourse } from "../db/client";
import { q } from "../db/q";
import { getExamDna } from "../lib/exam-dna";

const course = process.argv[2];
if (!course) { console.error("usage: tsx scripts/moteur-proof.ts <course>"); process.exit(1); }
enterCourse(course);

const PROOF_DIR = path.join(process.cwd(), "data", "refs", "proof", "moteur");

async function main() {
  const dna = await getExamDna();
  const exam = await q.get<{ id: number; created_at: string; verify_summary: string | null; html_path: string | null; format_template: string | null }>(
    `SELECT id, created_at, verify_summary, html_path, format_template FROM exams ORDER BY id DESC LIMIT 1`
  );
  if (!exam) { console.error("Aucun examen généré pour ce cours."); process.exit(1); }

  const items = await q.all<{ mold: string | null; topic: string; type: string; verified: number | null; figure_json: string | null }>(
    `SELECT mold, topic, type, verified, figure_json FROM qcm_items WHERE exam_id = ? ORDER BY idx`, exam.id
  ).catch(() => [] as { mold: string | null; topic: string; type: string; verified: number | null; figure_json: string | null }[]);
  const open = await q.all<{ concept: string }>(
    `SELECT concept FROM exam_questions WHERE exam_id = ? ORDER BY id`, exam.id
  ).catch(() => [] as { concept: string }[]);

  const lines: string[] = [];
  lines.push(`# Mock généré — ${course} · exam #${exam.id} (${exam.created_at})`);
  lines.push("");
  lines.push(`Artefact : ${exam.html_path ?? "(pas de PDF)"} · vérif : ${exam.verify_summary ?? "?"} · gabarit : ${exam.format_template ?? "?"}`);
  lines.push("");

  if (items.length) {
    const byMold = new Map<string, number>();
    for (const it of items) byMold.set(it.mold ?? "(sans)", (byMold.get(it.mold ?? "(sans)") ?? 0) + 1);
    const withFig = items.filter((i) => i.figure_json).length;
    const verified = items.filter((i) => i.verified === 1).length;
    lines.push(`## QCM générés : ${items.length} (${verified} vérifiés à l'aveugle · ${withFig} avec figure rendue)`);
    lines.push("");
    lines.push(`| Moule | générés | part générée | part ADN (annales) |`);
    lines.push(`|---|---|---|---|`);
    for (const [mold, n] of [...byMold.entries()].sort((a, b) => b[1] - a[1])) {
      const adnPart = dna?.molds.find((m) => m.mold === mold)?.share_pct;
      lines.push(`| ${mold} | ${n} | ${Math.round((n / items.length) * 1000) / 10} % | ${adnPart != null ? `${adnPart} %` : "—"} |`);
    }
    lines.push("");
    lines.push(`Sujets couverts (largeur) : ${[...new Set(items.map((i) => i.topic))].join(" · ")}`);
    lines.push("");
  }
  if (open.length) {
    lines.push(`## Questions ouvertes (architecte, moules ADN imposés) : ${open.length}`);
    for (const o of open) lines.push(`- ${o.concept}`);
    lines.push("");
  }
  if (dna) {
    lines.push(`## Rappel ADN (annales réelles) : ${dna.molds.map((m) => `${m.mold} ${m.share_pct} %`).join(" · ")}`);
    lines.push(`Figures dans les annales : ${dna.figures.figure_share_pct} % des pages · types dominants : ${dna.figures.kinds.slice(0, 4).map((k) => k.kind).join(", ")}`);
  }
  fs.mkdirSync(PROOF_DIR, { recursive: true });
  const out = path.join(PROOF_DIR, `mock-${course}.md`);
  fs.writeFileSync(out, lines.join("\n"));
  console.log(lines.join("\n"));
  console.log(`\nPreuve écrite : ${path.relative(process.cwd(), out)}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
