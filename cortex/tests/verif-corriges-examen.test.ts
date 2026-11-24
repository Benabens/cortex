/**
 * VÉRIFICATION DES CORRIGÉS D'EXAMEN (lib/verify verifyAndHarden) — banc du 23/11/2026, CS-202
 * huit exercices : résolu ET comparé dans le même appel, le vérificateur lisait le corrigé avant de
 * répondre et validait « ok » 5 corrigés faux sur 6 (Sonnet 5) ; un énoncé sous-déterminé (cache
 * ARP, MSS, égalité de métriques) passait ; un exercice faux sans réparation était livré « gardé
 * (faible) » ; une erreur trouvée était jetée au profit d'une régénération.
 * Nouvelle chaîne derrière CORTEX_VERIFY_V2=1 (posé par chaque test) ; sans lui, la chaîne historique
 * reste en place (tests « interrupteur » en fin de fichier).
 * Faux /v1/messages Anthropic (aucune dépense) ; la régénération est injectée.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-verif-corriges-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.LLM_PROVIDER = "anthropic";
process.env.LLM_API_KEY = "sk-ant-test";
process.env.LLM_MAX_RETRIES = "0";

const STATEMENT = String.raw`\textbf{Contexte.} Un hôte envoie une trame à une machine du même sous-réseau.
\subq{1.1}{Trames émises}{3} Combien de trames l'hôte émet-il avant la première trame de données ?
\subq{1.2}{Délai}{3} Calculez le délai total si chaque trame prend 0,4 ms.`;

const SOLUTION = String.raw`\subq{1.1}{Trames émises}{3} Une requête ARP : 1 trame.
\subq{1.2}{Délai}{3} Requête, réponse et données : $3 \times 0{,}4 = 1{,}3$ ms.`;

const FIXED = String.raw`\subq{1.1}{Trames émises}{3} Une requête ARP : 1 trame.
\subq{1.2}{Délai}{3} Requête, réponse et données : $3 \times 0{,}4 = 1{,}2$ ms.`;

const STATEMENT_FIXED = STATEMENT.replace("même sous-réseau.", "même sous-réseau ; son cache ARP est vide.");

/** Réponse du faux modèle selon l'appel : re-résolution, comparaison ou régénération. */
type Reply = { solve?: string | null; compare?: (prompt: string, n: number) => object | null; regen?: string };
let reply: Reply = {};
let prompts: string[] = [];
let compares = 0;
let llm: http.Server;

function sse(res: http.ServerResponse, text: string) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event: string, data: object) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", { type: "message_start", message: { id: "msg_t", type: "message", role: "assistant", model: "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
  send("message_stop", { type: "message_stop" });
  res.end();
}

before(async () => {
  delete process.env.CORTEX_USER;
  llm = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const prompt = (JSON.parse(raw).messages ?? []).map((m: { content: unknown }) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
      prompts.push(prompt);
      if (/RÉSOLUTION INDÉPENDANTE d'un exercice/.test(prompt)) {
        const s = reply.solve === undefined ? "RÉPONSE 1.1 : 1 trame. RÉPONSE 1.2 : 1,2 ms.\nHYPOTHÈSES : aucune" : reply.solve;
        if (s === null) { res.writeHead(500); res.end("{}"); return; }
        sse(res, s);
        return;
      }
      if (/CORRIGÉ PROPOSÉ/.test(prompt)) {
        const r = reply.compare ? reply.compare(prompt, compares++) : (compares++, { verdict: "ok", too_easy: false, violates_exclusion: false });
        sse(res, JSON.stringify(r ?? {}));
        return;
      }
      sse(res, "{}");
    });
  });
  await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}`;
  const { ensureCoursesLoaded } = await import("../lib/courses");
  await ensureCoursesLoaded();
});

beforeEach(() => { reply = {}; prompts = []; compares = 0; process.env.CORTEX_VERIFY_V2 = "1"; delete process.env.CORTEX_VERIFY_CONFIRM; });

after(async () => {
  await new Promise((r) => llm.close(r));
  for (const k of ["CORTEX_DATA_DIR", "LLM_PROVIDER", "LLM_API_KEY", "LLM_MAX_RETRIES", "LLM_BASE_URL", "CORTEX_VERIFY_V2", "CORTEX_VERIFY_CONFIRM"]) delete process.env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

const exercise = () => ({ category: "Réseaux", concept: "ARP", statement_tex: STATEMENT, solution_tex: SOLUTION, points: 6 });
let regenerations = 0;
const regenerate = async (q: { statement_tex: string }) => { regenerations++; return { ...exercise(), statement_tex: q.statement_tex, solution_tex: SOLUTION }; };
beforeEach(() => { regenerations = 0; });

async function harden(maxAttempts = 2, opts?: { dropUnfixed?: boolean }) {
  const { runWithCourse } = await import("../db/client");
  const { verifyAndHarden } = await import("../lib/verify");
  return runWithCourse("ml", () => verifyAndHarden({ title: "", questions: [exercise()] }, regenerate, maxAttempts, undefined, opts));
}

test("la re-résolution ne voit jamais le corrigé proposé ; la comparaison voit les deux", async () => {
  await harden();
  const solve = prompts.find((p) => /RÉSOLUTION INDÉPENDANTE d'un exercice/.test(p)) ?? "";
  const compare = prompts.find((p) => /CORRIGÉ PROPOSÉ/.test(p)) ?? "";
  assert.match(solve, /Combien de trames/, "la re-résolution reçoit l'énoncé");
  assert.doesNotMatch(solve, /Une requête ARP : 1 trame/, "ni le corrigé proposé");
  assert.match(solve, /HYPOTHÈSES/, "et doit lister les hypothèses que l'énoncé ne donne pas");
  assert.match(compare, /Une requête ARP : 1 trame/);
  assert.match(compare, /RÉPONSE 1\.2 : 1,2 ms/, "la comparaison reçoit la résolution indépendante");
});

test("une égalité fausse du corrigé est recalculée et signalée à la comparaison", async () => {
  await harden();
  const compare = prompts.find((p) => /CORRIGÉ PROPOSÉ/.test(p)) ?? "";
  assert.match(compare, /égalité fausse dans le corrigé : « 3 \\\\times 0\{,\}4 = 1\{,\}3 » \(le recalcul donne 1\.2\)/);
});

test("corrigé faux avec réparation complète : la réparation est appliquée et revérifiée, sans régénération", async () => {
  reply.compare = (p) => (/= 1\{,\}3/.test(p) ? { verdict: "wrong", issue: "1.2 : 3 × 0,4 = 1,2", corrected_solution_tex: FIXED } : { verdict: "ok" });
  const { spec, report } = await harden(2, { dropUnfixed: true });
  assert.equal(regenerations, 0, "l'erreur trouvée n'est pas jetée au profit d'une régénération");
  assert.equal(compares, 2, "la réparation est revérifiée");
  assert.equal(spec.questions[0].solution_tex, FIXED);
  assert.equal(report.results[0].verified, 1);
  assert.equal(report.fixed, 1);
});

test("énoncé ambigu : l'hypothèse manquante est écrite dans l'énoncé, avec le corrigé qui va avec", async () => {
  reply.solve = "RÉPONSE 1.1 : 0 ou 1 trame. HYPOTHÈSES : l'énoncé ne dit pas si le cache ARP est vide.";
  reply.compare = (p) => (/cache ARP est vide/.test(p.split("CORRIGÉ PROPOSÉ")[0]) ? { verdict: "ok" } : {
    verdict: "ambiguous", issue: "1.1 dépend de l'état du cache ARP", corrected_statement_tex: STATEMENT_FIXED, corrected_solution_tex: FIXED,
  });
  const { spec, report } = await harden(2, { dropUnfixed: true });
  assert.equal(spec.questions[0].statement_tex, STATEMENT_FIXED);
  assert.equal(spec.questions[0].solution_tex, FIXED);
  assert.equal(report.results[0].verified, 1);
  assert.equal(regenerations, 0);
});

test("une réparation d'énoncé qui perd une sous-question n'est pas appliquée", async () => {
  const truncated = STATEMENT_FIXED.replace(/\\subq\{1\.2\}[^\n]*/, "");
  reply.compare = () => ({ verdict: "ambiguous", issue: "1.1 ambiguë", corrected_statement_tex: truncated + " (énoncé réparé, assez long pour passer le seuil de taille)", corrected_solution_tex: FIXED });
  const { spec } = await harden(1);
  assert.equal(spec.questions[0].statement_tex, STATEMENT, "l'énoncé d'origine est gardé");
});

test("clé fausse sans réparation au bout des tentatives : retirée dans un examen en lots, gardée sinon", async () => {
  reply.compare = () => ({ verdict: "wrong", issue: "1.2 faux", corrected_solution_tex: "" });
  const batch = await harden(2, { dropUnfixed: true });
  assert.equal(batch.spec.questions.length, 0, "jamais livrée : son slot part au comblement");
  assert.equal(batch.report.removed, 1);
  assert.equal(regenerations, 2, "régénérée avant d'être retirée");
  const single = await harden(1);
  assert.equal(single.spec.questions.length, 1, "voie à un seul exercice : l'appelant garde l'original");
  assert.equal(single.report.results[0].verified, 0);
});

test("une vérification qui n'aboutit pas est relancée une fois avant « non vérifié »", async () => {
  reply.compare = (_p, n) => (n === 0 ? null : { verdict: "ok" });
  // null → la comparaison rend « {} » sans verdict : le premier contrôle n'aboutit pas.
  const { report } = await harden();
  assert.equal(compares, 2);
  assert.equal(report.results[0].verified, 1);
  assert.equal(report.unverified, 0);
});

test("interrupteur : sans CORTEX_VERIFY_V2, la chaîne historique — un seul appel qui résout puis voit le corrigé", async () => {
  delete process.env.CORTEX_VERIFY_V2;
  const { report } = await harden();
  assert.equal(prompts.length, 1, "aucune re-résolution séparée");
  assert.match(prompts[0], /ÉTAPE 1 —/);
  assert.match(prompts[0], /CORRIGÉ PROPOSÉ/);
  assert.doesNotMatch(prompts[0], /RÉSOLUTION INDÉPENDANTE|CONTRÔLES AUTOMATIQUES/, "ni re-résolution ni égalités recalculées");
  assert.equal(report.results[0].verified, 1);
});

test("interrupteur : sans CORTEX_VERIFY_V2, faux sans réparation régénéré puis gardé (faible), même en lot ; énoncé jamais réécrit", async () => {
  delete process.env.CORTEX_VERIFY_V2;
  reply.compare = () => ({ verdict: "wrong", issue: "1.2 faux", corrected_solution_tex: "" });
  const batch = await harden(2, { dropUnfixed: true });
  assert.equal(regenerations, 2, "régénération d'abord, comme avant");
  assert.equal(batch.spec.questions.length, 1, "gardé : le retrait des clés fausses est réservé à la nouvelle chaîne");
  assert.equal(batch.report.results[0].verified, 0);
  regenerations = 0;
  reply.compare = () => ({ verdict: "ambiguous", issue: "cache ARP", corrected_statement_tex: STATEMENT_FIXED, corrected_solution_tex: FIXED });
  const amb = await harden(1);
  assert.equal(amb.spec.questions[0].statement_tex, STATEMENT, "l'énoncé n'est pas réparé");
  assert.equal(regenerations, 1);
});

test("interrupteur : sans CORTEX_VERIFY_V2, une vérification qui n'aboutit pas n'est pas relancée", async () => {
  delete process.env.CORTEX_VERIFY_V2;
  reply.compare = () => null;
  const { report } = await harden();
  assert.equal(compares, 1);
  assert.equal(report.unverified, 1);
});

test("interrupteur : CORTEX_VERIFY_V2 ne s'active qu'avec « 1 »", async () => {
  for (const v of ["0", "true", ""]) {
    prompts = [];
    process.env.CORTEX_VERIFY_V2 = v;
    await harden();
    assert.ok(!prompts.some((p) => /RÉSOLUTION INDÉPENDANTE/.test(p)), `CORTEX_VERIFY_V2=${JSON.stringify(v)}`);
  }
});

// CORTEX_VERIFY_CONFIRM=1 — banc du 24/11/2026 (CS-202, Opus 5.5) : les 4 clés fausses livrées étaient des
// réparations d'énoncé trop faibles, acceptées par le contrôle qui suivait ; une autre, réparée au
// dernier tour, partait sans aucun contrôle.
const confirming = (p: string) => /CONFIRMATION D'UNE RÉPARATION/.test(p);
const ambiguousThenFixed = (p: string) => (/cache ARP est vide/.test(p.split("CORRIGÉ PROPOSÉ")[0]) ? null : {
  verdict: "ambiguous", issue: "1.1 dépend de l'état du cache ARP", corrected_statement_tex: STATEMENT_FIXED, corrected_solution_tex: FIXED,
});

test("confirmation : une réparation est revérifiée en mode confirmation et livrée si elle tient", async () => {
  process.env.CORTEX_VERIFY_CONFIRM = "1";
  reply.compare = (p) => ambiguousThenFixed(p) ?? { verdict: "ok" };
  const { spec, report } = await harden(2, { dropUnfixed: true });
  const compareds = prompts.filter((p) => /CORRIGÉ PROPOSÉ/.test(p));
  assert.equal(compareds.length, 2);
  assert.ok(!confirming(compareds[0]) && confirming(compareds[1]), "seul le contrôle de l'exercice réparé est en mode confirmation");
  assert.equal(spec.questions[0].statement_tex, STATEMENT_FIXED);
  assert.equal(report.results[0].verified, 1);
  assert.equal(report.fixed, 1);
});

test("confirmation : une réparation que la 2e résolution ne confirme pas retire l'exercice, sans nouvelle réparation ni régénération", async () => {
  process.env.CORTEX_VERIFY_CONFIRM = "1";
  // Le contrôle de confirmation trouve encore une ambiguïté (hypothèse trop faible) et propose une autre réparation.
  reply.compare = (p) => ambiguousThenFixed(p) ?? { verdict: "ambiguous", issue: "1.2 : délai de la réponse ARP non donné", corrected_statement_tex: STATEMENT_FIXED + " Chaque réponse arrive après 0,4 ms.", corrected_solution_tex: FIXED };
  const batch = await harden(2, { dropUnfixed: true });
  assert.equal(batch.spec.questions.length, 0, "retiré : le slot part au comblement");
  assert.equal(batch.report.removed, 1);
  assert.equal(compares, 2, "aucun troisième contrôle");
  assert.equal(regenerations, 0);
  compares = 0;
  const single = await harden(2);
  assert.equal(single.spec.questions.length, 1, "voie à un seul exercice : gardé");
  assert.equal(single.report.results[0].verified, 0, "mais jamais compté vérifié");
});

test("confirmation : la réparation du dernier tour est contrôlée au lieu d'être acceptée telle quelle", async () => {
  process.env.CORTEX_VERIFY_CONFIRM = "1";
  reply.compare = (p) => ambiguousThenFixed(p) ?? { verdict: "wrong", issue: "1.2 encore faux" };
  const { spec, report } = await harden(0, { dropUnfixed: true });
  assert.equal(compares, 2, "contrôle de la réparation du dernier tour");
  assert.ok(confirming(prompts.filter((p) => /CORRIGÉ PROPOSÉ/.test(p))[1]));
  assert.equal(spec.questions.length, 0);
  assert.equal(report.removed, 1);
});

test("sans CORTEX_VERIFY_CONFIRM, la réparation du dernier tour est acceptée sans contrôle (comportement de la nouvelle chaîne)", async () => {
  reply.compare = (p) => ambiguousThenFixed(p) ?? { verdict: "wrong", issue: "1.2 encore faux" };
  const { spec, report } = await harden(0, { dropUnfixed: true });
  assert.equal(compares, 1);
  assert.ok(!prompts.some(confirming));
  assert.equal(spec.questions[0].statement_tex, STATEMENT_FIXED);
  assert.equal(report.results[0].verified, 1);
});
