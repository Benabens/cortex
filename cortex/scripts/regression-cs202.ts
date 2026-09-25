/**
 * Régression CS-202 : capture déterministe des empreintes qui DOIVENT rester byte-identiques
 * (invariant de non-régression). Lance-le AVANT de toucher au cœur, puis APRÈS, et compare les sha.
 *
 *   npx tsx scripts/regression-cs202.ts /tmp/cs202-before
 *   ... modifs ...
 *   npx tsx scripts/regression-cs202.ts /tmp/cs202-after
 *   diff /tmp/cs202-before.prompt.txt /tmp/cs202-after.prompt.txt
 *
 * Empreintes : prompt de génération (full + batch, ctx FIXE → pas de RANDOM) et rendu .tex.
 */
import { runWithCourse } from "../db/client";
import { ensureCoursesLoaded } from "../lib/courses";
import { buildBatchPrompt, buildPrompt } from "../lib/exam";
import { renderExamTex } from "../lib/exam-latex";
import { profile } from "../lib/course-profile";
import crypto from "node:crypto";
import fs from "node:fs";

const out = process.argv[2] || "/tmp/cs202";
const FIXED: any = { weaknesses: [], due: ["fork", "tcp reno"], style: [], exercises: [], reviews: [], cheats: [], course: [] };
const SLOTS = [
  { category: "Networking", points: 50, brief: "B1" },
  { category: "OS", points: 25, brief: "B2" },
  { category: "Labs", points: 15, brief: "B3" },
];
const SPEC: any = {
  title: "CS-202 Computer Systems — Final Exam",
  duration_min: 180,
  questions: [
    { category: "Networking", concept: "Subnets and packets", points: 50, statement_tex: "\\subq{1.1}{X}{10} Body $R_1$.\\packetgrid{12}", solution_tex: "Sol A." },
    { category: "OS", concept: "Inodes", points: 25, statement_tex: "\\subq{3.1}{Y}{8} Body.\\diskgrid{8}", solution_tex: "Sol B." },
  ],
};

ensureCoursesLoaded().then(() => runWithCourse("cs-202", async () => {
  const prompt = (await buildPrompt(FIXED)) + "\n========\n" + buildBatchPrompt(FIXED, await profile().examSlots());
  const tex = renderExamTex(SPEC, "2026-06-11", true);
  fs.writeFileSync(`${out}.prompt.txt`, prompt);
  fs.writeFileSync(`${out}.tex`, tex);
  const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
  console.log(`prompt sha: ${sha(prompt)}  (${prompt.length} chars)`);
  console.log(`tex    sha: ${sha(tex)}  (${tex.length} chars)`);
}));
