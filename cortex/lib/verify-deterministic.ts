import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

export type DetMethod = "mcq" | "numeric" | "symbolic" | "structural" | "none";
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
  const refN = isPlainNumber(reference) ? plainNum(reference) : NaN;
  if (!Number.isFinite(refN)) return NA("numeric", "réf non numérique simple");
  const nums = (candidate.match(/-?\d+(?:[.,]\d+)?/g) ?? []).map((x) => parseFloat(x.replace(",", ".")));
  if (!nums.length) return NA("numeric", "pas de nombre côté solveur");
  const tol = Math.max(1e-6, Math.abs(refN) * 1e-3);
  const hit = nums.some((y) => Math.abs(y - refN) <= tol);
  // prouvé true seulement si un nombre coïncide ; prouvé false seulement si le 1ᵉʳ nombre diffère nettement
  if (hit) return { verified: true, method: "numeric", detail: `≈ ${refN}` };
  return { verified: false, method: "numeric", detail: `attendu ${refN}, obtenu ${nums.join(",")}` };
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
function runPy(input: object): Promise<any | null> {
  return new Promise((resolve) => {
    if (!fs.existsSync(scriptPath())) return resolve(null);
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
export async function verifyDeterministic(candidate: string, reference: string, answerType: string, opts?: { options?: string }): Promise<DetResult> {
  const cand = (candidate ?? "").trim(), ref = (reference ?? "").trim();
  if (!cand || !ref) return NA();
  if (answerType === "open") return NA("none", "type ouvert → LLM");

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
  // short : structurel → symbolique → numérique
  const st = verifyStructural(cand, ref);
  if (st.verified !== "not_applicable") return st;
  const sy = await verifySymbolic(cand, ref);
  if (sy.verified !== "not_applicable") return sy;
  const n = verifyNumericPlain(cand, ref);
  return n;
}
