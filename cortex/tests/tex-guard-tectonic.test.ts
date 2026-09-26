/**
 * LOT 2b-5 — PREUVE PAR COMPILATION RÉELLE (tectonic 0.16.x, sauté s'il est absent).
 *
 * Un fichier TÉMOIN vit HORS du dossier de compilation : `\message{WITNESS_<jeton>}`
 * (lu → le jeton apparaît dans la sortie/le log). Pour chaque vecteur :
 *  1. le garde le refuse ;
 *  2. le pipeline (garde PUIS tectonic, comme buildExamArtifact) ne compile donc
 *     rien : aucun log, aucun PDF, aucun jeton ;
 *  3. à titre de DIAGNOSTIC, le vecteur est aussi compilé BRUT avec les arguments
 *     de production (--untrusted) : le résultat est affiché, pas asserté — sur
 *     tectonic 0.16.9, --untrusted laisse lire des fichiers hors dossier, ce qui
 *     est exactement pourquoi le garde est la barrière.
 * Le mécanisme du témoin est lui-même prouvé par un \input LÉGITIME dans le dossier.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-tex-real-"));
process.env.CORTEX_DATA_DIR = tmp;
const TECTONIC = spawnSync("tectonic", ["--version"], { encoding: "utf8" });
const HAS_TECTONIC = TECTONIC.status === 0;
const OUT = path.join(tmp, "hors-dossier");
const WORK = path.join(tmp, "work");
const TOKEN = `WITNESS_${crypto.randomBytes(6).toString("hex")}`;

before(() => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(path.join(OUT, "witness.tex"), `\\message{^^J${TOKEN}^^J}\n`);
  fs.writeFileSync(path.join(OUT, "secret.txt"), `${TOKEN}\n`);
  fs.copyFileSync(path.join(__dirname, "..", "latex", "epfl-logo.png"), path.join(OUT, "witness.png"));
});
after(() => { delete process.env.CORTEX_DATA_DIR; fs.rmSync(tmp, { recursive: true, force: true }); });

type Compiled = { status: number | null; leaked: boolean; pdf: boolean; log: string };
let n = 0;
async function compileRaw(body: string, preamble = ""): Promise<Compiled> {
  const { tectonicArgs, tectonicSupportsUntrusted } = await import("../lib/exam-latex");
  const name = `v${++n}`;
  const dir = path.join(WORK, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.tex`), `\\documentclass{article}${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`);
  const r = spawnSync("tectonic", tectonicArgs(`${name}.tex`, { untrustedSupported: tectonicSupportsUntrusted("tectonic") }), { cwd: dir, encoding: "utf8", timeout: 120_000 });
  const logPath = path.join(dir, `${name}.log`);
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
  const all = `${r.stdout ?? ""}${r.stderr ?? ""}${log}`;
  // \filedump rend le fichier en HEXADÉCIMAL : on cherche aussi le jeton encodé.
  const hex = Buffer.from(TOKEN).toString("hex").toUpperCase();
  const leaked = all.includes(TOKEN) || all.toUpperCase().includes(hex) || /witness\.png/.test(all);
  return { status: r.status, leaked, pdf: fs.existsSync(path.join(dir, `${name}.pdf`)), log };
}

/** Le pipeline de production : garde, PUIS compilation. */
async function compileGuarded(body: string, preamble = ""): Promise<Compiled> {
  const { assertTexSafe } = await import("../lib/tex-guard");
  assertTexSafe(`\\begin{document}\n${body}\n\\end{document}`);
  return compileRaw(body, preamble);
}

const abs = (f: string) => path.join(OUT, f);
const rel = (f: string) => path.relative(path.join(WORK, "vX"), path.join(OUT, f)); // ../../hors-dossier/f
const VECTORS: Array<{ label: string; body: string; preamble?: string }> = [
  { label: "\\input absolu", body: `\\input{${abs("witness.tex")}}` },
  { label: "\\input relatif", body: `\\input{${rel("witness.tex")}}` },
  { label: "\\begin{@@input}", body: `\\begin{@@input}{${abs("witness.tex")}}` },
  { label: "\\UseName{@@input}", body: `\\UseName{@@input}{${abs("witness.tex")}}` },
  { label: "\\def\\x{@@input}\\begin\\x", body: `\\def\\x{@@input}\\begin\\x{${abs("witness.tex")}}` },
  { label: "\\csname input\\endcsname", body: `\\csname input\\endcsname{${abs("witness.tex")}}` },
  { label: "\\openin + \\read", body: `\\newread\\f\\openin\\f=${abs("secret.txt")} \\read\\f to\\x \\message{^^J\\x^^J}` },
  { label: "expl3 \\file_input:n", body: `\\ExplSyntaxOn \\file_input:n{${abs("witness.tex")}} \\ExplSyntaxOff` },
  { label: "\\includegraphics absolu", body: `\\includegraphics{${abs("witness.png")}}`, preamble: "\\usepackage{graphicx}" },
  { label: "\\includegraphics* relatif", body: `\\includegraphics*{${rel("witness.png")}}`, preamble: "\\usepackage{graphicx}" },
  { label: "\\includegraphics\\p", body: `\\def\\p{{${abs("witness.png")}}}\\includegraphics\\p`, preamble: "\\usepackage{graphicx}" },
  { label: "\\pgfimage", body: `\\pgfimage{${abs("witness.png")}}`, preamble: "\\usepackage{pgf}" },
  { label: "\\XeTeXpicfile", body: `\\XeTeXpicfile "${abs("witness.png")}"` },
  // \filedump exige une longueur ≤ taille du fichier (sinon « read failed », rien de lu).
  { label: "\\filedump (hexadécimal)", body: `\\message{^^J\\filedump length ${TOKEN.length + 1} {${abs("secret.txt")}}^^J}` },
  { label: "\\filedump relatif", body: `\\message{^^J\\filedump length ${TOKEN.length + 1} {${rel("secret.txt")}}^^J}` },
];

test("le témoin fonctionne : un \\input LÉGITIME dans le dossier fait apparaître le jeton", { skip: !HAS_TECTONIC && "tectonic absent" }, async () => {
  const dir = path.join(WORK, "v0"); fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(OUT, "witness.tex"), path.join(dir, "local.tex"));
  fs.writeFileSync(path.join(dir, "v0.tex"), "\\documentclass{article}\\begin{document}\\input{local.tex} x\\end{document}\n");
  const r = spawnSync("tectonic", ["--untrusted", "--chatter", "minimal", "--keep-logs", "v0.tex"], { cwd: dir, encoding: "utf8", timeout: 120_000 });
  const log = fs.readFileSync(path.join(dir, "v0.log"), "utf8");
  assert.ok(`${r.stdout}${r.stderr}${log}`.includes(TOKEN), "le \\message du témoin doit se voir dans la sortie ou le log");
});

test("chaque vecteur est refusé par le garde et ne produit ni log, ni PDF, ni fuite via le pipeline", { skip: !HAS_TECTONIC && "tectonic absent", timeout: 600_000 }, async () => {
  const { findTexHazards, TexHazardError } = await import("../lib/tex-guard");
  const diag: string[] = [];
  for (const v of VECTORS) {
    assert.ok(findTexHazards(`\\begin{document}\n${v.body}\n\\end{document}`).length > 0, `garde : non détecté — ${v.label}`);
    const before = fs.readdirSync(WORK).length;
    await assert.rejects(compileGuarded(v.body, v.preamble), TexHazardError, `pipeline : ${v.label}`);
    assert.equal(fs.readdirSync(WORK).length, before, `pipeline : rien ne doit être écrit — ${v.label}`);
    // Diagnostic (non asserté) : que ferait tectonic seul, avec les arguments de prod ?
    const raw = await compileRaw(v.body, v.preamble);
    diag.push(`${raw.leaked ? "FUITE" : "ok   "}  status=${raw.status}  ${v.label}`);
  }
  console.log(`[tex-guard-tectonic] ${TECTONIC.stdout.trim()} — compilation BRUTE (sans garde), --untrusted :\n  ${diag.join("\n  ")}`);
});

test("un document légitime (figure relative dans le dossier) passe le garde et compile", { skip: !HAS_TECTONIC && "tectonic absent", timeout: 240_000 }, async () => {
  const dir = path.join(WORK, `v${n + 1}`); fs.mkdirSync(dir, { recursive: true }); // dossier que compileRaw va utiliser
  fs.copyFileSync(path.join(OUT, "witness.png"), path.join(dir, "fig-ok.png"));
  const r = await compileGuarded("Texte \\begin{center}\\includegraphics[width=2cm]{fig-ok.png}\\end{center} $x^2$", "\\usepackage{graphicx}");
  assert.equal(r.status, 0, r.log.slice(-800));
  assert.equal(r.pdf, true);
});
