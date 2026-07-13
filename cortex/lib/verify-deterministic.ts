import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runSandboxed, sandboxAvailable, verifyCode, type CodeTest } from "@/lib/sandbox-exec";

/**
 * VÉRIFICATION DÉTERMINISTE (générique, additif, lecture seule). Pour une (réponse candidate,
 * réponse de référence, type), tente de PROUVER l'équivalence sans LLM :
 *   - mcq        : lettre(s) vs lettre(s)
 *   - numeric    : nombres normalisés avec tolérance, sinon équivalence symbolique
 *   - symbolic   : sympy (sous-process) — expressions, ordres de grandeur (Θ(n²) vs n^{log_3 9})
 *   - structural : séquences (Prim), ensembles (coupes/SCC — égalité stricte → prouvé ; sinon non concluant)
 * Renvoie `verified ∈ {true, false, "not_applicable"}`. JAMAIS de faux « prouvé » : le doute → not_applicable.
 * Sert la génération (corrigés prouvés) ET l'eval (juge sans complaisance). Si sympy/python absent →
 * la voie symbolique renvoie proprement not_applicable.
 */

export type DetMethod = "mcq" | "numeric" | "symbolic" | "structural" | "boolean" | "exec" | "none";
export type DetResult = { verified: true | false | "not_applicable"; method: DetMethod; detail: string };
const NA = (method: DetMethod = "none", detail = ""): DetResult => ({ verified: "not_applicable", method, detail });

// ── helpers ──────────────────────────────────────────────────────────────────
const lettersIn = (s: string) => Array.from(new Set((s.match(/\b[A-E]\b/g) ?? []))).sort();
function mcqLetters(s: string): string[] {
  const head = s.trim().match(/^[\s(]*([A-E](?:\s*(?:[,&]|and|et|ou|or)\s*[A-E])*)/i);
  if (head) return Array.from(new Set(head[1].toUpperCase().match(/[A-E]/g) ?? [])).sort();
  const all = Array.from(new Set(s.match(/\b[A-E]\b/g) ?? [])).sort();
  return all.length === 1 ? all : [];
}
const numSeq = (s: string) => (s.match(/-?\d+/g) ?? []).join(",");
const isPlainNumber = (s: string) => /^[-+]?\s*\d+(?:[.,]\d+)?\s*%?$/.test(s.trim());
const plainNum = (s: string) => parseFloat(s.replace("%", "").replace(",", ".").replace(/\s/g, ""));
// fraction simple « a/b » (Phase D) — évite le détour sympy pour les cas triviaux
const fracNum = (s: string): number => {
  const m = s.trim().match(/^[-+]?\s*(\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)$/);
  if (!m) return NaN;
  const b = plainNum(m[2]);
  return b === 0 ? NaN : plainNum(m[1]) / b * (s.trim().startsWith("-") ? -1 : 1);
};
const refNumber = (s: string): number => (isPlainNumber(s) ? plainNum(s) : fracNum(s));

// ── MCQ ──
export function verifyMcq(candidate: string, reference: string): DetResult {
  const lo = lettersIn(reference), lc = mcqLetters(candidate);
  if (!lo.length || !lc.length) return NA("mcq", "lettre absente");
  return JSON.stringify(lo) === JSON.stringify(lc)
    ? { verified: true, method: "mcq", detail: `${lc.join("")} = ${lo.join("")}` }
    : { verified: false, method: "mcq", detail: `${lc.join("")} ≠ ${lo.join("")}` };
}

// ── NUMERIC (nombres simples) ──
export function verifyNumericPlain(candidate: string, reference: string): DetResult {
  // candidate peut contenir des mots ; on isole un nombre simple s'il est clairement la réponse.
  const refN = refNumber(reference);
  if (!Number.isFinite(refN)) return NA("numeric", "réf non numérique simple");
  const nums = (candidate.match(/-?\d+(?:[.,]\d+)?(?:\s*\/\s*\d+(?:[.,]\d+)?)?/g) ?? [])
    .map((x) => (x.includes("/") ? fracNum(x) : parseFloat(x.replace(",", "."))))
    .filter((y) => Number.isFinite(y));
  if (!nums.length) return NA("numeric", "pas de nombre côté solveur");
  const tol = Math.max(1e-6, Math.abs(refN) * 1e-3);
  // Phase D — resserré : c'est le DERNIER nombre du candidat (position de la réponse finale)
  // qui fait foi. Avant : « n'importe quel nombre du texte » → un intermédiaire coïncidant
  // produisait un faux « prouvé » (seul point qui violait l'invariant).
  const last = nums[nums.length - 1];
  if (Math.abs(last - refN) <= tol) return { verified: true, method: "numeric", detail: `≈ ${refN}` };
  const someHit = nums.some((y) => Math.abs(y - refN) <= tol);
  if (someHit) return NA("numeric", `dernier nombre ${last} ≠ ${refN} mais un intermédiaire coïncide — ambigu`);
  return { verified: false, method: "numeric", detail: `attendu ${refN}, obtenu ${nums.join(",")}` };
}

// ── BOOLEAN (vrai/faux — Phase D) ──
const boolOf = (s: string): boolean | null => {
  const t = s.trim().toLowerCase().replace(/[.!]/g, "");
  if (/^(vrai|true|oui|yes)\b/.test(t)) return true;
  if (/^(faux|false|non|no)\b/.test(t)) return false;
  return null;
};
export function verifyBoolean(candidate: string, reference: string): DetResult {
  const rb = boolOf(reference);
  if (rb === null) return NA("boolean", "réf non booléenne");
  const cb = boolOf(candidate);
  if (cb === null) return NA("boolean", "réponse candidate non booléenne franche");
  return cb === rb
    ? { verified: true, method: "boolean", detail: `${cb} = ${rb}` }
    : { verified: false, method: "boolean", detail: `${cb} ≠ ${rb}` };
}

// ── STRUCTURAL (séquences / ensembles) ──
export function verifyStructural(candidate: string, reference: string): DetResult {
  const ref = reference.trim();
  // séquence de nombres (≥3) : ordre de Prim, parcours…
  const refSeq = numSeq(ref);
  if (refSeq && (ref.match(/\d/g) ?? []).length >= 3 && /^[\s\d,;.\-—]+$/.test(ref)) {
    const candSeq = numSeq(candidate);
    if (!candSeq) return NA("structural", "pas de séquence côté solveur");
    return refSeq === candSeq
      ? { verified: true, method: "structural", detail: `séquence ${refSeq}` }
      : { verified: false, method: "structural", detail: `attendu ${refSeq}, obtenu ${candSeq}` };
  }
  // ensemble { … } : égalité STRICTE → prouvé ; sinon NON CONCLUANT (plusieurs réponses possibles).
  const setOf = (s: string) => { const m = s.match(/\{([^}]*)\}/); return m ? Array.from(new Set(m[1].split(/[,;]/).map((x) => x.trim().replace(/\s+/g, "")).filter(Boolean))).sort() : null; };
  const ro = setOf(ref), co = setOf(candidate);
  if (ro && ro.length) {
    if (!co) return NA("structural", "pas d'ensemble côté solveur");
    if (JSON.stringify(ro) === JSON.stringify(co)) return { verified: true, method: "structural", detail: `ensemble {${ro.join(",")}}` };
    return NA("structural", `ensembles ≠ ({${co.join(",")}} vs {${ro.join(",")}}) — plusieurs réponses valides possibles`);
  }
  return NA("structural", "ni séquence ni ensemble");
}

// ── SYMBOLIC (sympy) ──
let _sympyOK: boolean | null = null;
function pyBin(): string { return process.env.CORTEX_PYTHON || "python3"; }
function scriptPath(): string { return path.join(process.cwd(), "scripts", "sympy_check.py"); }
async function runPy(input: object): Promise<any | null> {
  if (!fs.existsSync(scriptPath())) return null;
  // Phase D — DURCI : les expressions viennent d'une sortie de modèle et sympy
  // parse via eval() interne → exécution DANS la sandbox (réseau coupé, écriture
  // bornée) dès qu'elle est disponible. Repli legacy (execFile direct, timeout
  // seul) uniquement si aucune isolation n'existe sur la machine — entrée
  // semi-fiable interne, jamais du code utilisateur (celui-ci passe par
  // verifyCode qui REFUSE de tourner sans sandbox).
  if (sandboxAvailable()) {
    const r = await runSandboxed({
      cmd: pyBin(),
      args: ["sympy_check.py"],
      files: { "sympy_check.py": fs.readFileSync(scriptPath(), "utf8") },
      stdin: JSON.stringify(input),
      timeoutMs: 12_000,
    });
    if (!r.ok && !r.stdout) return null;
    try { return JSON.parse(r.stdout.trim().split("\n").pop() || "{}"); } catch { return null; }
  }
  return new Promise((resolve) => {
    let done = false;
    const child = execFile(pyBin(), [scriptPath()], { timeout: 12_000 }, (err, stdout) => {
      if (done) return; done = true;
      if (err && !stdout) return resolve(null);
      try { resolve(JSON.parse(String(stdout).trim().split("\n").pop() || "{}")); } catch { resolve(null); }
    });
    try { child.stdin?.end(JSON.stringify(input)); } catch { /* ignore */ }
  });
}
export async function sympyAvailable(): Promise<boolean> {
  if (_sympyOK !== null) return _sympyOK;
  const r = await runPy({ a: "n+1", b: "1+n", mode: "exact" });
  _sympyOK = !!(r && r.equal === true);
  return _sympyOK;
}
const looksAsymptotic = (s: string) => /[ΘOΩθω]\s*\(|\btheta\b|\bbig-?o\b|\bomega\b/i.test(s);
export async function verifySymbolic(candidate: string, reference: string, opts?: { asymptotic?: boolean }): Promise<DetResult> {
  if (!(await sympyAvailable())) return NA("symbolic", "sympy indisponible");
  const mode = (opts?.asymptotic ?? (looksAsymptotic(candidate) || looksAsymptotic(reference))) ? "asymptotic" : "exact";
  const r = await runPy({ a: candidate, b: reference, mode });
  if (!r || r.error) return NA("symbolic", r?.error ? `sympy: ${r.error}` : "sympy: pas de résultat");
  return r.equal === true
    ? { verified: true, method: "symbolic", detail: `${mode}: ${r.reason}` }
    : { verified: false, method: "symbolic", detail: `${mode}: ${r.reason}` };
}

// ── DISPATCH ──────────────────────────────────────────────────────────────────
/** Tente de PROUVER (réponse candidate == référence) sans LLM, selon le type. */
export async function verifyDeterministic(
  candidate: string,
  reference: string,
  answerType: string,
  opts?: { options?: string; tests?: CodeTest[]; language?: "c" | "python" }
): Promise<DetResult> {
  const cand = (candidate ?? "").trim(), ref = (reference ?? "").trim();
  if (!cand || !ref) return NA();
  if (answerType === "open") return NA("none", "type ouvert → LLM");

  // Phase D — type « code » : le candidat est un PROGRAMME, la preuve = exécution
  // sandboxée contre des cas de test (stdin→stdout). Sans sandbox → refus (NA).
  if (answerType === "code") {
    const lang = opts?.language ?? (/#include|\bint\s+main\s*\(/.test(cand) ? "c" : "python");
    const r = await verifyCode(lang, cand, opts?.tests ?? []);
    return { verified: r.verified, method: "exec", detail: r.detail };
  }

  if (answerType === "mcq") {
    const m = verifyMcq(cand, ref);
    if (m.verified !== "not_applicable") return m;
    // un QCM sans lettre claire peut être une formule → tente le symbolique
    const s = await verifySymbolic(cand, ref);
    return s;
  }
  if (answerType === "numeric") {
    const n = verifyNumericPlain(cand, ref);
    if (n.verified !== "not_applicable") return n;
    return await verifySymbolic(cand, ref); // C(n,2), 1/m^ℓ, %…
  }
  // short : booléen → structurel → symbolique → numérique
  const b = verifyBoolean(cand, ref);
  if (b.verified !== "not_applicable") return b;
  const st = verifyStructural(cand, ref);
  if (st.verified !== "not_applicable") return st;
  const sy = await verifySymbolic(cand, ref);
  if (sy.verified !== "not_applicable") return sy;
  const n = verifyNumericPlain(cand, ref);
  return n;
}
