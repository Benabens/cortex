import crypto from "node:crypto";
import { currentCourse } from "@/db/client";
import { q } from "@/db/q";
import { LONG_OUTPUT_MAX_TOKENS, completeJson, llmFailureReason } from "@/lib/llm";
import { examLanguageFor } from "@/lib/exam-format";
import { languageName } from "@/lib/profiles/generic-directives";
import { DATA_RULE, dataBlock, sanitizeCorpus } from "@/lib/prompt-safety";
import { COURSE_MATTER_RULE, corpusWindows, coursePassages, isExamLogistics } from "@/lib/course-grounding";
import { commonStemRoots, contentRoots, notionBase, overlapRatio, sameNotionQuestion, sameSourceFact } from "@/lib/qcm-checks";
import { normalize } from "@/lib/text";
import type { StepCb } from "@/lib/exam";

/**
 * FAITS TESTABLES D'UN COURS — examen QCM #14 de HUM-285 (15/11/2026) : malgré #90 à #108, un
 * examen de 20 questions livrait encore deux ou trois paires qui testaient la même règle ou le
 * même fait sous deux scénarios (deux clés « la motivation va de pair avec le leadership », deux
 * souverainetés entamées par une loi étrangère, deux « option par défaut sans retirer le choix »).
 * Le programme avait une quinzaine de notions larges pour 20 questions, donc plusieurs questions
 * par notion, et le dédoublonnage reposait sur le seul jugement d'un modèle, après coup.
 *
 * Ici, AVANT la conception : la liste des faits testables du cours (une affirmation vérifiable du
 * cours = un fait, avec son passage source), extraite une fois par cours et gardée en base, les
 * faits quasi identiques fusionnés. Chaque question reçoit UN fait ; deux questions ne partagent
 * jamais un fait (contrôle par identifiant, sans modèle). Le contrôle des doublons par le modèle
 * reste, en filet.
 */

export type CourseFact = { id: string; notion: string; statement: string; passage: string };

/**
 * Version de l'extraction : la changer invalide les faits gardés en base (empreinte). 2 : un fait
 * rangé sous la notion dont il parle, pas sous celle dont les extraits le contenaient (examen #16).
 */
const FACTS_VERSION = 2;

/** Faits demandés par notion : de quoi tenir deux fois un examen de 20 questions, entre 2 et 5. */
export function factsPerNotion(notions: number, count: number): number {
  return Math.min(5, Math.max(2, Math.ceil((2 * Math.max(count, 20)) / Math.max(1, notions)) + 1));
}

/** Identifiant stable d'un fait : son énoncé normalisé. */
export function factId(statement: string): string {
  const flat = normalize(statement).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return `f-${crypto.createHash("sha1").update(flat).digest("hex").slice(0, 10)}`;
}

/**
 * Deux faits disent-ils la même chose ? Même proposition reformulée (recouvrement des mots
 * porteurs de l'énoncé), même passage source (le même exemple vu sous deux angles), ou énoncés
 * voisins appuyés sur des passages voisins. Seuils bas à dessein : fusionner deux faits proches
 * coûte un fait de réserve, en laisser deux coûte une paire de questions en doublon.
 */
export function sameFact(a: Pick<CourseFact, "statement" | "passage">, b: Pick<CourseFact, "statement" | "passage">): boolean {
  const sa = contentRoots(a.statement);
  const sb = contentRoots(b.statement);
  const statements = sa.size >= 3 && sb.size >= 3 ? overlapRatio(sa, sb) : 0;
  if (statements >= 0.6 || sameSourceFact(a.passage, b.passage)) return true;
  return statements >= 0.5 && overlapRatio(contentRoots(a.passage), contentRoots(b.passage)) >= 0.4;
}

/** Le terme qu'un énoncé de fait définit (« Un nudge est… », « Le X désigne… »), en racines, ou null. */
const DEFINES = /^(?:selon\s+[^,]{1,60},\s*)?(?:(?:un|une|le|la|les|des|the|an?)\s+|l['’]\s*)?(.{3,60}?)\s+(?:est|sont|désign\p{L}*|se\s+défini\p{L}*|consist\p{L}*|signifi\p{L}*|is|are|means?|refers?\s+to)\s/iu;
export function definedTerm(statement: string): Set<string> | null {
  const m = statement.trim().match(DEFINES);
  const roots = m ? contentRoots(m[1]) : null;
  return roots?.size ? roots : null;
}

/**
 * Deux faits d'une MÊME notion trop proches pour deux questions d'un même examen (examen #16,
 * Q3/Q12 : deux faits sur la définition du nudge — réorganiser sans retirer d'option — qui ne
 * fusionnent pas, `sameFact` exigeant une même proposition) : la définition du même terme, ou des
 * énoncés qui se recouvrent nettement (seuils plus bas qu'entre deux notions). Ils restent deux
 * faits du cours, pour des examens différents : seule la répartition d'un examen les sépare.
 */
export function closeFacts(a: CourseFact, b: CourseFact): boolean {
  if (notionBase(a.notion) !== notionBase(b.notion)) return false;
  const ta = definedTerm(a.statement);
  const tb = definedTerm(b.statement);
  if (ta && tb && overlapRatio(ta, tb) >= 0.6) return true;
  const sa = contentRoots(a.statement);
  const sb = contentRoots(b.statement);
  if (sa.size >= 3 && sb.size >= 3 && overlapRatio(sa, sb) >= 0.4) return true;
  return overlapRatio(contentRoots(`${a.statement} ${a.passage}`), contentRoots(`${b.statement} ${b.passage}`)) >= 0.5;
}

/** Faits fusionnés : le premier d'une même proposition reste (sa notion, son passage). */
export function mergeFacts(facts: CourseFact[]): CourseFact[] {
  const kept: CourseFact[] = [];
  for (const f of facts) if (!kept.some((k) => k.id === f.id || sameFact(k, f))) kept.push(f);
  return kept;
}

type TestedQuestion = { factId?: string | null; stem?: string; notion?: string | null; options?: string[]; correct?: number[]; focusSlot?: boolean };
type FullQuestion = TestedQuestion & { stem: string; options: string[]; correct: number[] };
const fullQuestion = (it: TestedQuestion): it is FullQuestion => typeof it.stem === "string" && Array.isArray(it.options) && Array.isArray(it.correct);

/**
 * Les indices des questions dont le fait est déjà testé par une question précédente : même
 * identifiant de fait, ou — examen #16, Q3/Q12 : deux faits distincts qui disaient la même chose —
 * deux questions bâties sur des faits, de même notion, au même scénario ou à la même bonne réponse
 * reformulée (lib/qcm-checks.sameNotionQuestion). Comparée aux seules questions gardées ; deux
 * questions de l'accent demandé ne se comparent pas. Sans faits (conception par notion), le
 * contrôle des doublons du modèle et les plafonds par notion décident, comme avant.
 */
export function factDuplicates(items: TestedQuestion[]): number[] {
  const seen = new Set<string>();
  const kept: FullQuestion[] = [];
  const out: number[] = [];
  const common = commonStemRoots(items.filter(fullQuestion).map((it) => it.stem));
  items.forEach((it, i) => {
    const twin = fullQuestion(it) && !!it.factId && kept.some((k) => !!k.factId && !(k.focusSlot && it.focusSlot) && sameNotionQuestion(k, it, common));
    if ((it.factId && seen.has(it.factId)) || twin) { out.push(i); return; }
    if (it.factId) seen.add(it.factId);
    if (fullQuestion(it)) kept.push(it);
  });
  return out;
}

/**
 * Le fait qu'une question teste réellement, d'après la preuve qu'elle cite (source_fact) : le
 * concepteur qui bâtit sa question sur le passage d'un AUTRE fait du cours (déjà donné à une autre
 * question) la voit rattachée à ce fait, et le contrôle par identifiant la retire. Gardé tel quel
 * si la preuve ne désigne nettement aucun autre fait.
 */
export function attributedFact(sourceFact: string | null | undefined, own: CourseFact | null, facts: CourseFact[]): CourseFact | null {
  if (!sourceFact?.trim() || !facts.length) return own;
  const roots = contentRoots(sourceFact);
  const score = (f: CourseFact) => overlapRatio(roots, contentRoots(`${f.passage} ${f.statement}`));
  const best = facts
    .filter((f) => f.id !== own?.id && sameSourceFact(sourceFact, f.passage))
    .sort((a, b) => score(b) - score(a))[0];
  if (!best) return own;
  return own && score(own) >= score(best) ? own : best;
}

/**
 * RÉPARTITION DES FAITS sur un examen : un tour par rang, chaque notion (dans l'ordre donné, celui
 * des chapitres) donne son meilleur fait pas encore pris, jusqu'au nombre demandé et au plus `cap`
 * questions par notion — le maximum de notions d'abord. Dans une notion, les faits jamais posés
 * aux examens précédents du cours passent avant les autres (`asked` : fait → dernier examen) ; à un
 * même rang, les notions dont le fait est neuf avant celles dont le fait a déjà été posé. Un fait
 * trop proche d'un fait déjà retenu de sa notion (`closeFacts`) n'est pas posé dans le même examen :
 * il passe en fin de réserve. La réserve suit le même ordre : elle remplace une question écartée
 * par un fait encore inutilisé.
 */
export function planFacts(
  facts: CourseFact[],
  opts: { order: string[]; count: number; cap: number; asked?: Map<string, number> },
): { picked: CourseFact[]; reserve: CourseFact[] } {
  const asked = opts.asked ?? new Map<string, number>();
  const byNotion = new Map<string, CourseFact[]>();
  for (const f of facts) {
    const b = notionBase(f.notion);
    byNotion.set(b, [...(byNotion.get(b) ?? []), f]);
  }
  const order = [...new Set([...opts.order.map(notionBase), ...facts.map((f) => notionBase(f.notion))])].filter((b) => byNotion.has(b));
  const lists = order.map((b) => byNotion.get(b)!
    .map((f, i) => ({ f, i }))
    .sort((x, y) => (asked.get(x.f.id) ?? -1) - (asked.get(y.f.id) ?? -1) || x.i - y.i)
    .map((x) => x.f));
  const depth = Math.max(0, ...lists.map((l) => l.length));
  const rank = (row: CourseFact[]) => [...row.filter((f) => !asked.has(f.id)), ...row.filter((f) => asked.has(f.id))];
  const picked: CourseFact[] = [];
  const close = new Set<string>();
  const perNotion = new Map<string, number>();
  for (let r = 0; r < depth && picked.length < opts.count; r++) {
    for (const f of rank(lists.map((l) => l[r]).filter(Boolean))) {
      if (picked.length >= opts.count) break;
      const b = notionBase(f.notion);
      if ((perNotion.get(b) ?? 0) >= opts.cap) continue;
      if (picked.some((p) => closeFacts(p, f))) { close.add(f.id); continue; }
      picked.push(f);
      perNotion.set(b, (perNotion.get(b) ?? 0) + 1);
    }
  }
  const taken = new Set(picked.map((f) => f.id));
  const reserve: CourseFact[] = [];
  for (let r = 0; r < depth; r++) reserve.push(...rank(lists.map((l) => l[r]).filter((f) => f && !taken.has(f.id) && !close.has(f.id))));
  for (let r = 0; r < depth; r++) reserve.push(...lists.map((l) => l[r]).filter((f) => f && close.has(f.id)));
  return { picked, reserve };
}

const FACTS_SCHEMA = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          notion: { type: "integer", description: "Le numéro (N…) de la notion dont relève le fait." },
          statement: { type: "string", description: "Le fait : UNE proposition vérifiable du cours, en une phrase courte et autonome (30 mots au plus)." },
          passage: { type: "string", description: "Une citation courte, VERBATIM, recopiée mot pour mot depuis les extraits de la notion, qui établit le fait." },
        },
        required: ["notion", "statement", "passage"],
        additionalProperties: false,
      },
    },
  },
  required: ["facts"],
  additionalProperties: false,
} as const;

/** Le passage cité se retrouve-t-il dans les extraits (mots porteurs, au moins 70 %) ? */
function supported(passage: string, extracts: Set<string>): boolean {
  const own = contentRoots(passage);
  if (own.size < 3) return false;
  return [...own].filter((r) => extracts.has(r)).length / own.size >= 0.7;
}

/** Extraits d'une notion pour l'extraction : passages indexés et fenêtres du corpus. */
async function notionPassages(label: string): Promise<{ src: string; text: string }[]> {
  const [fts, scan] = await Promise.all([
    coursePassages([label], 2, 900).catch(() => []),
    corpusWindows([label], { perQuery: 2, cap: 1500, budget: 3000 }).catch(() => []),
  ]);
  return [...fts, ...scan.filter((p) => !fts.some((x) => x.text.includes(p.text.slice(0, 200)) || p.text.includes(x.text.slice(0, 200))))];
}

/** Un appel : les faits d'un groupe de notions. */
async function extractGroup(group: string[], others: string[], k: number, lang: string): Promise<CourseFact[]> {
  const blocks = await Promise.all(group.map(async (label) => ({ label, passages: await notionPassages(label) })));
  const withText = blocks.filter((b) => b.passages.length);
  if (!withText.length) return [];
  const prompt = [
    `Tu es l'équipe enseignante du cours. Pour chaque NOTION du programme ci-dessous (N1, N2…), liste les FAITS TESTABLES que ses extraits du cours établissent. Un fait = UNE affirmation vérifiable du cours : une définition et sa condition, un mécanisme, un résultat d'étude, une distinction entre deux notions, un exemple précis et ce qu'il montre. Chaque fait permet d'écrire UNE question à choix, et une seule.`,
    `RÈGLES :`,
    `  - statement : une phrase courte et autonome (30 mots au plus) qui dit la PROPOSITION elle-même, jamais un simple thème (« le cours dit que X entraîne Y », pas « X »).`,
    `  - passage : une citation courte (une ou deux phrases), VERBATIM, recopiée mot pour mot depuis les extraits de CETTE notion, qui établit le fait.`,
    // Examen #16 (16/11) : la définition d'une composante d'un autre chapitre, présente dans les
    // extraits d'une notion trouvés par un mot commun (« données »), rangée sous cette notion — la
    // question qui la testait en portait l'étiquette.
    `  - notion : celle dont le fait PARLE, pas celle dont les extraits le contiennent. Les extraits d'une notion débordent parfois sur un autre sujet du cours : un tel passage ne donne aucun fait à cette notion — il va sous la notion de ce groupe dont il parle, ou il n'est pas listé.`,
    `  - DEUX FAITS NE DISENT JAMAIS LA MÊME CHOSE : la même proposition sous deux formulations, ou le même exemple, la même étude vus sous deux angles (ses chiffres d'un côté, ce qu'ils illustrent de l'autre), c'est UN SEUL fait. Une proposition qui concerne deux notions n'est donnée qu'une fois, sous la plus proche.`,
    `  - Au plus ${k} faits par notion, du plus central au plus secondaire ; moins si les extraits n'en établissent pas autant. Jamais un fait absent des extraits, jamais une connaissance extérieure au cours.`,
    COURSE_MATTER_RULE,
    `  - LANGUE : ${lang}.`,
    others.length ? `Les autres notions du programme sont traitées à part : ${others.map((o) => sanitizeCorpus(o).slice(0, 80)).join(" · ")}. Un fait qui relève mieux de l'une d'elles n'est pas listé ici.` : "",
    "",
    DATA_RULE,
    ...withText.map((b, i) => [`N${i + 1}. ${sanitizeCorpus(b.label)}`, dataBlock(`EXTRAITS DU COURS — N${i + 1}`, b.passages)].join("\n")),
    "",
    `Réponds UNIQUEMENT avec {"facts":[{"notion":1,"statement":"…","passage":"…"}]}.`,
  ].filter(Boolean).join("\n");
  const out = await completeJson<{ facts: { notion: number; statement: string; passage: string }[] }>(
    { prompt, model: "opus", maxTokens: LONG_OUTPUT_MAX_TOKENS, timeoutMs: 600_000, json: { schema: FACTS_SCHEMA } },
    { check: (v) => (Array.isArray(v?.facts) ? null : "le champ « facts » (tableau) manque") },
  );
  const facts: CourseFact[] = [];
  const perNotion = new Map<number, number>();
  for (const raw of out.facts) {
    const b = withText[(Number.isInteger(raw?.notion) ? raw.notion : 0) - 1];
    const statement = typeof raw?.statement === "string" ? raw.statement.replace(/\s+/g, " ").trim() : "";
    const passage = typeof raw?.passage === "string" ? raw.passage.replace(/\s+/g, " ").trim() : "";
    if (!b || contentRoots(statement).size < 3 || statement.length > 400 || isExamLogistics(statement)) continue;
    // Un passage introuvable dans les extraits : le fait n'est pas établi par le cours.
    if (!supported(passage, contentRoots(b.passages.map((p) => p.text).join(" ")))) continue;
    const n = perNotion.get(raw.notion) ?? 0;
    if (n >= k) continue;
    perNotion.set(raw.notion, n + 1);
    facts.push({ id: factId(statement), notion: b.label, statement, passage: passage.slice(0, 600) });
  }
  return facts;
}

/** Groupes de notions d'un appel : de l'ordre de 24 faits par appel, entre 3 et 8 notions. */
function groups(labels: string[], k: number): string[][] {
  const size = Math.min(8, Math.max(3, Math.floor(24 / k)));
  const n = Math.max(1, Math.ceil(labels.length / size));
  const per = Math.ceil(labels.length / n);
  return Array.from({ length: n }, (_, i) => labels.slice(i * per, (i + 1) * per)).filter((g) => g.length);
}

/** Empreinte des faits gardés : notions du programme et corpus du cours. */
async function factsFingerprint(labels: string[]): Promise<string> {
  const c = await q.get<{ n: number | string; len: number | string; mx: number | string }>(
    `SELECT count(*) AS n, coalesce(sum(length(text)), 0) AS len, coalesce(max(id), 0) AS mx FROM items`,
  ).catch(() => null);
  const key = { v: FACTS_VERSION, notions: [...new Set(labels.map(notionBase))].sort(), corpus: [Number(c?.n ?? 0), Number(c?.len ?? 0), Number(c?.mx ?? 0)] };
  return crypto.createHash("sha1").update(JSON.stringify(key)).digest("hex").slice(0, 16);
}

export type CourseFactsResult = { facts: CourseFact[]; cached: boolean; calls: number };

/**
 * Les faits testables du cours pour ces notions : ceux gardés en base s'ils ont la même empreinte
 * (mêmes notions, même corpus), sinon extraits — un appel par groupe de notions, en parallèle —,
 * fusionnés et gardés pour les examens suivants. Un fait ré-extrait qui redit un fait d'avant garde
 * son identifiant (les examens précédents qui l'ont posé restent reconnus). Extraction en échec :
 * aucun fait, l'examen se conçoit par notion comme avant.
 */
export async function courseFacts(labels: string[], opts: { count: number; step?: StepCb; language?: string }): Promise<CourseFactsResult> {
  const step = opts.step ?? (() => {});
  if (!labels.length) return { facts: [], cached: false, calls: 0 };
  await q.ensureTable("course_facts");
  const fp = await factsFingerprint(labels);
  const rows = await q.all<CourseFact & { fingerprint: string }>(`SELECT id, notion, statement, passage, fingerprint FROM course_facts ORDER BY seq`).catch(() => []);
  if (rows.length && rows.every((r) => r.fingerprint === fp)) {
    return { facts: rows.map(({ id, notion, statement, passage }) => ({ id, notion, statement, passage })), cached: true, calls: 0 };
  }
  const k = factsPerNotion(labels.length, opts.count);
  const lang = languageName(opts.language ?? examLanguageFor(currentCourse()))[1];
  const parts = groups(labels, k);
  step(`Faits testables du cours : extraction sur ${labels.length} notions (${parts.length} appel(s))…`, 8);
  let failed = 0;
  const got = await Promise.all(parts.map((g) => extractGroup(g, labels.filter((l) => !g.includes(l)), k, lang).catch((e) => {
    failed++;
    step(`Faits testables : un groupe de notions ignoré (${llmFailureReason(e).slice(0, 80)})`, 8);
    return [] as CourseFact[];
  })));
  const merged = mergeFacts(got.flat()).map((f) => {
    const before = rows.find((r) => sameFact(r, f));
    return before ? { ...f, id: before.id } : f;
  });
  // Deux faits ramenés au même identifiant d'avant : le premier seul.
  const facts = merged.filter((f, i) => merged.findIndex((x) => x.id === f.id) === i);
  if (!facts.length) return { facts: [], cached: false, calls: parts.length };
  // Un groupe en échec : les faits servent à cet examen, mais ne sont pas gardés (le suivant réessaie).
  if (failed) return { facts, cached: false, calls: parts.length };
  await q.tx(async () => {
    await q.run(`DELETE FROM course_facts`);
    for (let i = 0; i < facts.length; i++) {
      const f = facts[i];
      await q.run(`INSERT INTO course_facts (id, seq, notion, statement, passage, fingerprint) VALUES (?,?,?,?,?,?)`, f.id, i, f.notion, f.statement, f.passage, fp);
    }
  }).catch((e) => step(`Faits testables non gardés en base (${(e as Error).message.slice(0, 80)}) : utilisés pour cet examen seulement`, 8));
  return { facts, cached: false, calls: parts.length };
}

/**
 * Faits déjà posés aux examens précédents du cours : fait → dernier examen qui l'a posé. Une
 * question d'avant les faits (sans fact_id) est rattachée au fait dont l'énoncé recouvre le plus
 * ce qu'elle teste (bonne réponse, explication), s'il le recouvre nettement ; celles qui restent,
 * ouvertes comprises, sont rattachées par le modèle, en un appel (banc rs-qcm15 du 17/11 : le
 * paradoxe de Simpson posé sous un décor d'embauche ne partageait pas assez de mots avec son fait,
 * cru jamais posé, et la reprise revenait au comblement). Modèle indisponible : les mots seuls.
 */
export async function askedFacts(facts: CourseFact[]): Promise<Map<string, number>> {
  const rows = await q.all<{ exam_id: number | string; stem: string; options_json: string | null; correct_json: string | null; explanation: string | null; fact_id: string | null }>(
    `SELECT exam_id, stem, options_json, correct_json, explanation, fact_id FROM qcm_items ORDER BY exam_id DESC, idx LIMIT 400`,
  ).catch(() => []);
  const open = await q.all<{ exam_id: number | string; concept: string | null; statement_html: string | null }>(
    `SELECT exam_id, concept, statement_html FROM exam_questions ORDER BY exam_id DESC, id LIMIT 100`,
  ).catch(() => []);
  const known = new Set(facts.map((f) => f.id));
  const roots = facts.map((f) => ({ f, r: contentRoots(f.statement) }));
  const out = new Map<string, number>();
  const mark = (id: string, exam: number) => { if (!out.has(id) || out.get(id)! < exam) out.set(id, exam); };
  const unmatched: { exam: number; text: string }[] = [];
  const byWords = (exam: number, text: string) => {
    const tested = contentRoots(text);
    let best: { id: string; score: number } | null = null;
    for (const { f, r } of roots) {
      if (r.size < 3) continue;
      const score = [...r].filter((x) => tested.has(x)).length / r.size;
      if (score >= 0.6 && (!best || score > best.score)) best = { id: f.id, score };
    }
    if (best) mark(best.id, exam);
    else unmatched.push({ exam, text });
  };
  for (const row of rows) {
    const exam = Number(row.exam_id);
    if (row.fact_id) { if (known.has(row.fact_id)) mark(row.fact_id, exam); continue; }
    let key = "";
    try {
      const options = JSON.parse(row.options_json ?? "[]") as string[];
      key = (JSON.parse(row.correct_json ?? "[]") as number[]).map((k) => options[k] ?? "").join(" ");
    } catch { /* question illisible : l'énoncé seul */ }
    byWords(exam, `${row.stem} ${key} ${row.explanation ?? ""}`);
  }
  if (open.length) {
    const { dropSectionCallouts } = await import("@/lib/exam-latex");
    for (const o of open) {
      const text = dropSectionCallouts(o.statement_html ?? "").replace(/<\/?[a-zA-Z][^>]*>/g, " ").replace(/\\[a-zA-Z]+\*?/g, " ").replace(/[{}$\\]/g, "").replace(/\s+/g, " ").trim();
      if (text) byWords(Number(o.exam_id), `${o.concept ? `${o.concept} : ` : ""}${text}`);
    }
  }
  if (unmatched.length && facts.length) {
    // Les plus récentes d'abord, bornées : un seul appel, de taille connue.
    const asked = unmatched.sort((a, b) => b.exam - a.exam).slice(0, ASKED_BY_MODEL);
    try {
      for (const [i, f] of await factsTestedBy(facts, asked.map((a) => a.text))) mark(facts[f].id, asked[i].exam);
    } catch { /* modèle indisponible : les rattachements par les mots seuls */ }
  }
  return out;
}

/** Questions précédentes non rattachées par leurs mots que le modèle relit, au plus. */
const ASKED_BY_MODEL = 60;

/** Pour chaque question (son rang), le rang du fait qu'elle teste, si le modèle en nomme un. */
async function factsTestedBy(facts: CourseFact[], questions: string[]): Promise<[number, number][]> {
  const out = await completeJson<{ matches: { question: number; fact: number }[] }>({
    model: "opus", timeoutMs: 300_000,
    json: { schema: { type: "object", properties: { matches: { type: "array", items: { type: "object", properties: { question: { type: "integer" }, fact: { type: "integer" } }, required: ["question", "fact"], additionalProperties: false } } }, required: ["matches"], additionalProperties: false } },
    prompt: [
      `Voici les FAITS du cours (F0, F1…) et des questions déjà posées aux examens précédents (Q0, Q1…). Pour chaque question, donne le fait qu'elle teste : la même proposition, la même règle ou le même résultat, même sous un autre décor, d'autres chiffres ou une autre langue. -1 si elle n'en teste aucun nettement.`,
      DATA_RULE,
      dataBlock("FAITS", facts.map((f, i) => ({ src: `F${i}`, text: f.statement.slice(0, 240) }))),
      dataBlock("QUESTIONS DÉJÀ POSÉES", questions.map((t, i) => ({ src: `Q${i}`, text: t.replace(/\s+/g, " ").slice(0, 400) }))),
      `Réponds UNIQUEMENT avec {"matches":[{"question":0,"fact":2}]}.`,
    ].join("\n"),
  }, { check: (v) => (Array.isArray(v?.matches) ? null : "le champ « matches » (tableau) manque") });
  return out.matches
    .filter((m) => Number.isInteger(m?.question) && Number.isInteger(m?.fact) && m.question >= 0 && m.question < questions.length && m.fact >= 0 && m.fact < facts.length)
    .map((m) => [m.question, m.fact]);
}
