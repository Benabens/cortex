import { q, nowStr, nowPlusDays } from "@/db/q";
import { completeText, extractJson } from "@/lib/llm";
import { profile } from "@/lib/course-profile";
import { ensureIndexSchema, indexExamExercises } from "@/lib/exam-index";
import { createWeakness, ensureSchema as ensureWeaknessSchema } from "@/lib/weaknesses";
import { rebuildCoursePlan, getPlanChapters, ensurePlanSchema, type PlanChapter } from "@/lib/course-plan";
import { detectExamDna } from "@/lib/exam-dna";

/**
 * « Programme & Maîtrise » (NEXT STEP 12). PAR COURS, 100 % additif.
 *
 *  - `topics`  : taxonomie typée + pondérée des exercices de la matière (dérivée des VRAIS
 *                finals via Max + vision, complétée par les séries / le plan du cours).
 *  - `mastery` : ta maîtrise par type (score lissé 0-10) + répétition espacée (courbe de l'oubli).
 *
 * ⚠️ RÈGLE D'OR cs-202 : ces deux tables sont créées EN LAZY (CREATE TABLE IF NOT EXISTS,
 * jamais au chargement du module) dans la DB du cours COURANT. Le prompt de génération et le
 * rendu LaTeX de cs-202 ne sont pas touchés ; `data/cortex.db` committée reste byte-identique
 * tant que la fonctionnalité n'est pas utilisée+committée (la démo tourne sur un cours isolé).
 * On réutilise la MÊME mécanique SM-2 que `schedule.ts` (interval × ease), ici clé par TYPE.
 */

export type Topic = {
  id: number;
  label: string;
  method: string | null;
  exoType: string | null; // V5 : format réel de l'exo
  trap: string | null; // V5 : piège typique
  category: string | null;
  archetype: string | null;
  examWeight: number; // part d'emphase à l'examen (%)
  examCount: number; // nb d'occurrences repérées dans les past-exams
  source: string | null; // 'final' | 'serie' | 'cours'
  description: string | null;
  chapterId: number | null; // v2 — chapitre du plan de cours où la notion est traitée (null = non rattaché)
};

/** v2 — une occurrence RÉELLE d'une notion dans un final (pour l'accordéon : toutes visibles au dépli). */
export type Occurrence = {
  examId: number;
  examTitle: string | null;
  examYear: number | null;
  examPage: number | null;
  examHref: string | null;
  courseHref: string | null;
  points: number | null;
  statement: string | null;
};

export type MasteryRow = {
  topicId: number;
  score: number | null; // lissé 0-10 (null = jamais fait)
  attempts: number;
  lastScore: number | null;
  lastDoneAt: string | null;
  dueAt: string | null;
  ease: number;
  intervalDays: number;
};

export type TopicView = Topic & {
  mastery: number | null;
  attempts: number;
  lastScore: number | null;
  lastDoneAt: string | null;
  lastExamId: number | null; // dernier exo généré pour ce type (reprise du panneau de score au reload)
  dueAt: string | null;
  status: "never" | "due" | "ok"; // jamais vu / à revoir / à jour
  // ── Allégée — enrichissement depuis l'index exo-par-exo (exam_exercises). Absent (null/0) tant
  // qu'aucune Ré-analyse « index-based » n'a lié les exos au topic (topic_id). Aucune valeur inventée.
  pointsSum?: number | null; // somme des VRAIS barèmes des exos du topic (null si aucun barème imprimé)
  occurrences?: number; // nb d'exos indexés rattachés (≈ « tombé N fois », vérité terrain)
  examHref?: string | null; // deep-link PDF du final à la bonne page (occurrence la plus récente)
  examYear?: number | null; // année de cette occurrence représentative
  examPage?: number | null; // page de cette occurrence représentative
  courseHref?: string | null; // deep-link vers le passage de cours associé
  courseOrder?: number | null; // clé d'ordre « où la notion est traitée » (dérivée de course_href)
  // ── v2 — complétude accordéon : chapitre rattaché + TOUTES les occurrences (chaque final + page) ──
  chapterId?: number | null; // chapitre du plan de cours (topics.plan_chapter_id)
  occurrences_all?: Occurrence[]; // toutes les occurrences réelles (dépli d'une notion)
};

export const MASTERY_THRESHOLD = 7; // « maîtrisé » à partir de 7/10

export async function ensureProgramSchema(): Promise<void> {
  await q.ensureTable("topics");
  // V5 — blueprint approfondi : type d'exo (format réel) + piège type, ajoutés au fil de l'eau.
  await q.ensureColumns("topics", ["exo_type", "trap"]);
  await q.ensureTable("mastery");
}

// ---------------- PHASE 1 — Analyseur de blueprint ----------------

const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n) + " […]" : s);

/** Texte du corpus regroupé par usage pour l'analyse (past-exams = vérité terrain des poids). */
async function gatherForBlueprint() {
  const byTypes = async (types: string[], cap: number): Promise<string> => {
    const ph = types.map(() => "?").join(",");
    let rows: { text: string; title: string }[] = [];
    try {
      rows = await q.all<{ text: string; title: string }>(
        `SELECT i.text text, s.title title FROM items i JOIN sources s ON s.id = i.source_id
           WHERE s.type IN (${ph}) ORDER BY s.recency_weight DESC, s.id`,
        ...types
      );
    } catch {}
    let out = "";
    for (const r of rows) {
      const chunk = `\n— (${r.title}) —\n${r.text}\n`;
      if (out.length + chunk.length > cap) { out += trunc(chunk, cap - out.length); break; }
      out += chunk;
    }
    return out.trim();
  };
  return {
    finals: await byTypes(["final", "midterm"], 16000),
    series: await byTypes(["serie", "exercise"], 6000),
    plan: await byTypes(["note", "course_pdf", "course"], 4000),
  };
}

// Objet enveloppe (pas un tableau nu) → compatible avec extractJson (qui isole {…}).
const TOPIC_SCHEMA = {
  type: "object",
  properties: {
    topics: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          method: { type: "string" },
          exo_type: { type: "string", description: "Le FORMAT/la forme réelle de l'exo tel qu'il tombe (ex. « remplir une échelle TCP », « tableau de comptage d'accès », « vrai/faux à justifier », « écrire une fonction C », « tracer un arbre de processus »)." },
          trap: { type: "string", description: "Le PIÈGE typique de ce type d'exo dans les vrais examens (l'idée fausse qu'il punit), en une phrase." },
          category: { type: "string" },
          archetype: { type: "string" },
          exam_weight: { type: "number" },
          exam_count: { type: "integer" },
          source: { type: "string" },
          description: { type: "string" },
        },
        required: ["label", "method", "category", "exam_weight", "source"],
        additionalProperties: false,
      },
    },
  },
  required: ["topics"],
  additionalProperties: false,
} as const;

type RawTopic = {
  label: string; method?: string; category?: string; archetype?: string;
  exam_weight?: number; exam_count?: number; source?: string; description?: string;
  exo_type?: string; trap?: string;
};

export type AnalyzeResult = { count: number; topics: TopicView[] };

/**
 * Classe chaque exercice des vrais finals en un TYPE/MÉTHODE et en compte la fréquence → un
 * profil d'examen pondéré, complété par les séries et le plan du cours. Une passe Max (+ vision
 * sur les vrais finals si le cours a des images-étalon). Persiste dans `topics` (UPSERT par label
 * → la maîtrise déjà accumulée est préservée).
 */
export async function analyzeBlueprint(opts: { onStep?: (m: string, p: number) => void } = {}): Promise<AnalyzeResult> {
  await ensureProgramSchema();
  const step = opts.onStep ?? (() => {});
  step("Lecture du corpus (finals + séries + plan du cours)…", 10);
  const corpus = await gatherForBlueprint();
  if (!corpus.finals && !corpus.series && !corpus.plan)
    throw new Error("Corpus vide : ingère d'abord le cours (cours + séries + finals) avec « npm run ingest ».");

  const p = profile();
  // Les archétypes du cours = la liste des types que le GÉNÉRATEUR sait produire. On demande à Max
  // de rattacher chaque type repéré à l'un d'eux (champ `archetype`) → la boucle d'entraînement
  // pourra régénérer un exo NEUF du bon type.
  const archetypeList = p.archetypes
    .map((a) => `  - id="${a.id}" · ${a.category} · ${a.concept} (mots-clés : ${a.topics.join(", ")})`)
    .join("\n");
  // Vision : si le cours a des images-étalon (vrais finals rendus), Max les REGARDE.
  const vision = p.visionBlock?.() ?? "";

  const prompt = [
    p.qaIntro(),
    `Tu dresses la CARTE D'EXAMEN de la matière : la taxonomie TYPÉE des exercices qui tombent, avec leur POIDS (emphase) à l'examen, dérivée des VRAIS finals — pas inventée.`,
    ``,
    vision ? vision : ``,
    vision ? `` : ``,
    `═══ EXERCICES DES VRAIS FINALS / MIDTERMS (vérité terrain pour les POIDS) ═══`,
    corpus.finals || "(aucun final ingéré — déduis alors les types du plan + des séries, poids estimés)",
    ``,
    `═══ SÉRIES D'EXERCICES (types au programme, même s'ils ne sont pas encore tombés) ═══`,
    corpus.series || "(aucune série)",
    ``,
    `═══ PLAN / SCOPE DU COURS (notes du staff) ═══`,
    corpus.plan || "(aucun plan)",
    ``,
    `═══ TYPES QUE LE GÉNÉRATEUR SAIT PRODUIRE (rattache chaque type à l'un d'eux via "archetype", ou "" si aucun) ═══`,
    archetypeList,
    ``,
    `═══ TA TÂCHE ═══`,
    `1) Classe CHAQUE exercice des past-exams en un TYPE/MÉTHODE précis (ex. « intégrale double — Fubini / changement de variable », « plus court chemin — Dijkstra / Bellman-Ford », « programmation dynamique — récurrence + table »…). Regroupe les exercices équivalents sous UN seul type.`,
    `2) Compte combien de fois chaque type apparaît dans les past-exams (exam_count) et déduis son POIDS exam_weight = part d'emphase en % (sur les past-exams ; la somme de TOUS les exam_weight ≈ 100).`,
    `3) Ajoute les types présents dans les SÉRIES ou le PLAN mais PAS (encore) tombés en final : source="serie" ou "cours", exam_count=0, exam_weight petit mais > 0.`,
    `4) Pour chaque type : un "label" COURT (EN ANGLAIS, comme sur l'examen), "method" = la méthode/technique testée, "exo_type" = le FORMAT réel de l'exo (échelle à remplir, tableau d'accès, vrai/faux à justifier, écrire une fonction C, arbre de processus…), "trap" = le PIÈGE typique (l'idée fausse punie), "category" (regroupement), "archetype" (id ci-dessus le plus proche ou ""), "source" ("final" si vu en final, sinon "serie"/"cours"), "description" (une phrase).`,
    `Vise 6 à 14 types — ni trop fin, ni trop grossier. Pas de doublon.`,
    ``,
    `Réponds UNIQUEMENT avec l'objet JSON { "topics": [ … ] } (aucun texte autour, aucun outil au-delà de Read d'images) :`,
    JSON.stringify(TOPIC_SCHEMA, null, 2),
  ].join("\n");

  step("Classification des exercices par type via Max (+ vision)…", 35);
  const text = await completeText({ prompt, model: "opus", timeoutMs: 360_000 });
  const parsed = extractJson<{ topics?: RawTopic[] } | RawTopic[]>(text);
  const raw: RawTopic[] = Array.isArray(parsed) ? parsed : parsed?.topics ?? [];
  const cleaned = raw.filter((t) => t && t.label && t.label.trim());
  if (!cleaned.length) throw new Error("L'analyse n'a renvoyé aucun type. Réessaie (corpus peut-être trop maigre).");

  step("Enregistrement de la taxonomie…", 80);
  // normalise les poids pour qu'ils somment ~100
  const sum = cleaned.reduce((s, t) => s + (Number(t.exam_weight) || 0), 0) || 1;
  const upSql = `INSERT INTO topics (label, method, exo_type, trap, category, archetype, exam_weight, exam_count, source, description)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(label) DO UPDATE SET
       method=excluded.method, exo_type=excluded.exo_type, trap=excluded.trap,
       category=excluded.category, archetype=excluded.archetype,
       exam_weight=excluded.exam_weight, exam_count=excluded.exam_count,
       source=excluded.source, description=excluded.description`;
  const knownArche = new Set(p.archetypes.map((a) => a.id));
  await q.tx(async () => {
    for (const t of cleaned) {
      await q.run(
        upSql,
        t.label.trim().slice(0, 160),
        (t.method ?? "").slice(0, 400) || null,
        (t.exo_type ?? "").slice(0, 200) || null,
        (t.trap ?? "").slice(0, 400) || null,
        (t.category ?? "").slice(0, 80) || null,
        t.archetype && knownArche.has(t.archetype) ? t.archetype : null,
        Math.round(((Number(t.exam_weight) || 0) / sum) * 1000) / 10,
        Math.max(0, Math.round(Number(t.exam_count) || 0)),
        (t.source ?? "final").slice(0, 20),
        (t.description ?? "").slice(0, 400) || null
      );
    }
  });
  step("Taxonomie prête ✓", 100);
  return { count: cleaned.length, topics: (await programOverview()).topics };
}

// ---------------- V11 — Agrégation de la partition DEPUIS l'index exo-par-exo ----------------

// clé de regroupement : minuscule, sans accents (NFD), réduite à l'alphanumérique.
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, " ").trim();

const CLUSTER_SCHEMA = {
  type: "object",
  properties: {
    types: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string", description: "Label canonique COURT (EN) du type d'exercice." },
          method: { type: "string" },
          category: { type: "string" },
          archetype: { type: "string", description: "id d'archétype le plus proche, ou \"\"." },
          members: { type: "array", items: { type: "string" }, description: "Les labels BRUTS (exactement tels que fournis) regroupés sous ce type." },
        },
        required: ["label", "members"],
        additionalProperties: false,
      },
    },
  },
  required: ["types"],
  additionalProperties: false,
} as const;

type RawCluster = { label: string; method?: string; category?: string; archetype?: string; members: string[] };

/**
 * V11 — reconstruit `topics` À PARTIR de l'index `exam_exercises` : regroupe les exos par type
 * (clustering Max des labels bruts ; repli déterministe par label normalisé), `exam_count` = compte
 * RÉEL des exos (doublons inclus → Strassen ×2), `exam_weight` = vraie proportion. Rattache chaque
 * exo à son `topic_id`. La forme de `topics` reste identique (génération non touchée).
 */
export async function aggregateTopicsFromIndex(opts: { onStep?: (m: string, p: number) => void } = {}): Promise<{ count: number; exercises: number }> {
  await ensureProgramSchema();
  await ensureIndexSchema();
  const step = opts.onStep ?? (() => {});
  const exos = await q.all<{ id: number; topic: string; method: string | null; exo_type: string | null; trap: string | null; archetype: string | null }>(`SELECT id, topic, method, exo_type, trap, archetype FROM exam_exercises`);
  if (!exos.length) throw new Error("Index vide : lance d'abord l'indexation exo-par-exo des finals.");

  // labels bruts distincts + comptes
  const rawCount = new Map<string, number>();
  for (const e of exos) rawCount.set(e.topic, (rawCount.get(e.topic) ?? 0) + 1);
  const rawLabels = [...rawCount.keys()];

  // clustering Max (résilient → repli : chaque label distinct = un type)
  step(`Agrégation : regroupement de ${rawLabels.length} libellés en types…`, 94);
  let clusters: RawCluster[] = [];
  if (rawLabels.length > 1) {
    try {
      const p0 = profile();
      const prompt = [
        p0.qaIntro?.() ?? "Tu es l'équipe enseignante du cours.",
        `Voici les libellés BRUTS des exercices extraits des vrais finals (avec leur nombre d'occurrences). Regroupe les ÉQUIVALENTS sous un même TYPE canonique (ex. « Strassen / matrix multiplication » et « Strassen's algorithm » → un seul type « Divide & Conquer — Strassen »). Ne fusionne PAS des techniques différentes.`,
        ...rawLabels.map((l) => `  - "${l}" (×${rawCount.get(l)})`),
        ``,
        `═══ ARCHÉTYPES (rattache via "archetype", "" si aucun) ═══`,
        p0.archetypes.map((a) => `  - id="${a.id}" · ${a.concept}`).join("\n"),
        ``,
        `Vise 15 à 30 types canoniques (regroupement par GRANDE technique : Divide & Conquer, Greedy, Dynamic Programming, Graphes/plus courts chemins, Flots/coupes, Arbres couvrants, Tris/sélection, Structures de données, Hachage, Récurrences/asymptotique, NP/réductions, Preuves…). Chaque label BRUT doit apparaître dans EXACTEMENT un type (members = labels bruts exacts, copiés tels quels). Réponds UNIQUEMENT avec { "types": [ … ] } :`,
        JSON.stringify(CLUSTER_SCHEMA, null, 2),
      ].join("\n");
      const parsed = extractJson<{ types?: RawCluster[] }>(await completeText({ prompt, model: "opus", timeoutMs: 600_000 }));
      clusters = (parsed?.types ?? []).filter((t) => t?.label && Array.isArray(t.members) && t.members.length);
    } catch (e) { step(`Clustering Max indisponible (${(e as Error).message.slice(0, 40)}) → repli par label`, 95); }
  }

  // map label brut → cluster ; les labels non couverts deviennent leur propre type (repli)
  const labelToCluster = new Map<string, RawCluster>();
  for (const c of clusters) for (const m of c.members) if (rawCount.has(m)) labelToCluster.set(m, c);
  for (const l of rawLabels) if (!labelToCluster.has(l)) labelToCluster.set(l, { label: l, members: [l] });

  // un représentant (méthode/format/piège/archétype les plus complets) par cluster
  const repByLabel = new Map<string, { exo_type: string | null; trap: string | null; method: string | null; archetype: string | null }>();
  for (const e of exos) {
    const cur = repByLabel.get(e.topic);
    if (!cur || ((e.exo_type ? 1 : 0) + (e.trap ? 1 : 0)) > ((cur.exo_type ? 1 : 0) + (cur.trap ? 1 : 0)))
      repByLabel.set(e.topic, { exo_type: e.exo_type, trap: e.trap, method: e.method, archetype: e.archetype });
  }

  // agrège par type canonique
  const knownArche = new Set(profile().archetypes.map((a) => a.id));
  type Agg = { label: string; method: string | null; exo_type: string | null; trap: string | null; category: string | null; archetype: string | null; count: number; rawLabels: Set<string> };
  const byKey = new Map<string, Agg>();
  for (const l of rawLabels) {
    const c = labelToCluster.get(l)!;
    const key = norm(c.label) || norm(l);
    const rep = repByLabel.get(l);
    let a = byKey.get(key);
    if (!a) { a = { label: c.label.slice(0, 160), method: c.method || rep?.method || null, exo_type: rep?.exo_type ?? null, trap: rep?.trap ?? null, category: c.category || null, archetype: (c.archetype && knownArche.has(c.archetype) ? c.archetype : rep?.archetype) || null, count: 0, rawLabels: new Set() }; byKey.set(key, a); }
    a.count += rawCount.get(l) ?? 0;
    a.rawLabels.add(l);
    if (!a.exo_type && rep?.exo_type) a.exo_type = rep.exo_type;
    if (!a.trap && rep?.trap) a.trap = rep.trap;
  }

  const aggs = [...byKey.values()];
  const total = aggs.reduce((s, a) => s + a.count, 0) || 1;

  // reconstruit `topics` (depuis l'index) — on remplace les types d'index, on PRÉSERVE la maîtrise
  // (mastery est par topic_id ; on ré-UPSERT par label → l'id et donc la maîtrise restent si le label est stable).
  step("Écriture de la partition (poids réels)…", 97);
  const upSql = `INSERT INTO topics (label, method, exo_type, trap, category, archetype, exam_weight, exam_count, source, description)
     VALUES (?,?,?,?,?,?,?,?,'final',?)
     ON CONFLICT(label) DO UPDATE SET method=excluded.method, exo_type=excluded.exo_type, trap=excluded.trap,
       category=excluded.category, archetype=excluded.archetype, exam_weight=excluded.exam_weight,
       exam_count=excluded.exam_count, source='final', description=excluded.description`;
  const newLabels = new Set(aggs.map((a) => a.label));
  await q.tx(async () => {
    // table rase des types DÉRIVÉS DE L'INDEX (source='final') qui ne sont plus dans la partition
    // (évite les types périmés d'un run précédent). Les types séries/cours sont préservés ;
    // la maîtrise des types supprimés cascade (sur cold-start il n'y en a pas).
    for (const r of await q.all<{ label: string }>(`SELECT label FROM topics WHERE source='final'`))
      if (!newLabels.has(r.label)) await q.run(`DELETE FROM topics WHERE label = ?`, r.label);
    for (const a of aggs) {
      await q.run(
        upSql,
        a.label, a.method?.slice(0, 400) ?? null, a.exo_type?.slice(0, 200) ?? null,
        a.trap?.slice(0, 400) ?? null, a.category?.slice(0, 80) ?? null, a.archetype,
        Math.round((a.count / total) * 1000) / 10, a.count,
        `${a.count} occurrence(s) dans les vrais finals.`
      );
      const row = await q.get<{ id: number }>(`SELECT id FROM topics WHERE label = ?`, a.label);
      if (row) for (const rl of a.rawLabels) await q.run(`UPDATE exam_exercises SET topic_id = ? WHERE topic = ?`, row.id, rl);
    }
  });
  // v2 — dé-doublonnage « à la source » : retire les notions EMPILÉES (analyses passées, FR/EN,
  // séries/cours SANS exos) qui font DOUBLON d'une notion réellement tombée. Zéro perte de signal :
  // on ne touche qu'aux notions jamais tombées (exam_count=0) subsumées par une notion tombée.
  const removed = await dedupeStackedTopics();
  step(`Partition : ${aggs.length} types sur ${exos.length} exos indexés${removed ? ` (+${removed} doublons empilés retirés)` : ""} ✓`, 100);
  return { count: aggs.length - removed, exercises: exos.length };
}

/** Tokens signifiants d'un label (≥ 3 lettres, sans accents), pour comparer deux notions. */
function labelTokens(label: string): Set<string> {
  return new Set(norm(label).split(" ").filter((w) => w.length >= 3));
}

/**
 * Retire les notions JAMAIS TOMBÉES (exam_count = 0, typiquement source série/cours issue d'analyses
 * empilées) qui DOUBLONNENT une notion réellement tombée (recouvrement de tokens ≥ 50 % du plus petit).
 * Conservateur : une notion série UNIQUE (aucun recouvrement fort avec une notion tombée) est gardée
 * — c'est un vrai « au programme, pas encore tombé ». Renvoie le nombre de doublons supprimés.
 */
export async function dedupeStackedTopics(): Promise<number> {
  await ensureProgramSchema();
  const rows = await q.all<{ id: number; label: string; exam_count: number }>(`SELECT id, label, exam_count FROM topics`);
  const fallen = rows.filter((r) => (r.exam_count ?? 0) > 0).map((r) => ({ ...r, toks: labelTokens(r.label) }));
  if (!fallen.length) return 0;
  let removed = 0;
  for (const r of rows) {
    if ((r.exam_count ?? 0) > 0) continue; // jamais toucher une notion tombée
    const t = labelTokens(r.label);
    if (!t.size) continue;
    const dup = fallen.some((f) => {
      if (f.id === r.id) return false;
      let inter = 0;
      for (const w of t) if (f.toks.has(w)) inter++;
      const denom = Math.min(t.size, f.toks.size) || 1;
      return inter / denom >= 0.5;
    });
    if (dup) { await q.run(`DELETE FROM topics WHERE id = ?`, r.id); removed++; }
  }
  return removed;
}

/**
 * V11 — construit le blueprint EXHAUSTIF : index exo-par-exo des finals → agrégation en partition
 * typée à vrais poids. Repli sur l'ancien résumé (analyzeBlueprint) si aucun final indexable.
 */
export async function rebuildBlueprintFromIndex(opts: { onStep?: (m: string, p: number) => void } = {}): Promise<{ exams: number; exercises: number; types: number; chapters: number; mapped: number }> {
  const step = opts.onStep ?? (() => {});
  const idx = await indexExamExercises({ onStep: (s, p) => step(s, Math.round(p * 0.65)) });
  let types: number;
  if (!idx.exercises) {
    step("Aucun final indexable → repli sur l'analyse résumée…", 66);
    const r = await analyzeBlueprint({ onStep: (s, p) => step(s, 66 + Math.round(p * 0.08)) });
    types = r.count;
  } else {
    const agg = await aggregateTopicsFromIndex({ onStep: (s, p) => step(s, 65 + Math.round(p * 0.09)) });
    types = agg.count;
  }
  // v2 — plan de cours du prof + rattachement des notions (repli propre si non dérivable).
  const plan = await rebuildCoursePlan({ onStep: (s, p) => step(`Plan de cours : ${s}`, 74 + Math.round(p * 0.12)) });
  step(plan.plan.ok ? `Plan : ${plan.plan.chapters} chapitres, ${plan.map.mapped}/${plan.map.total} notions rattachées ✓` : `Plan de cours non dérivé (${plan.plan.reason ?? "structure insuffisante"}) — regroupement existant conservé.`, 86);
  // moteur-v2 (P0) — ADN d'examen (moules + figures + texture) détecté depuis les annales.
  // Ré-entrant ; jamais bloquant : un échec laisse l'ADN partiel, repris au prochain run / npm run dna.
  try {
    await detectExamDna({ onStep: (s, p) => step(`ADN : ${s}`, 86 + Math.round(p * 0.14)) });
  } catch (e) {
    step(`ADN d'examen incomplet (${(e as Error).message.slice(0, 50)}) — relance « npm run dna »`, 100);
  }
  return { exams: idx.exams, exercises: idx.exercises, types, chapters: plan.plan.chapters, mapped: plan.map.mapped };
}

// ---------------- PHASE 2 — Vue « Couverture & Maîtrise » ----------------

async function topicRows(): Promise<Topic[]> {
  await ensurePlanSchema(); // garantit topics.plan_chapter_id (rattrapage DB existantes)
  return (
    await q.all<any>(
      `SELECT id, label, method, exo_type exoType, trap, category, archetype, exam_weight examWeight, exam_count examCount, source, description, plan_chapter_id chapterId
         FROM topics ORDER BY exam_weight DESC, exam_count DESC, label`
    )
  ).map((r) => ({ ...r }));
}

/** v2 — TOUTES les occurrences réelles par topic_id (chaque final + page), pour l'accordéon. */
async function occurrencesByTopic(): Promise<Map<number, Occurrence[]>> {
  const out = new Map<number, Occurrence[]>();
  let rows: (Occurrence & { topicId: number })[] = [];
  try {
    await ensureIndexSchema();
    rows = await q.all(
      `SELECT id examId, topic_id topicId, exam_title examTitle, exam_year examYear, exam_page examPage,
              exam_href examHref, course_href courseHref, points, statement
         FROM exam_exercises WHERE topic_id IS NOT NULL
        ORDER BY (exam_year IS NULL), exam_year DESC, exam_page`
    );
  } catch { return out; }
  for (const r of rows) {
    const { topicId, ...occ } = r;
    if (!out.has(topicId)) out.set(topicId, []);
    out.get(topicId)!.push(occ);
  }
  return out;
}

/** v2 — chapitre du plan enrichi des compteurs (tête d'accordéon : nb notions / nb tombées). */
export type PlanChapterView = PlanChapter & {
  notionCount: number; // notions rattachées à ce chapitre
  fallenCount: number; // parmi elles, combien sont déjà tombées (≥ 1 occurrence)
  occurrenceCount: number; // total d'occurrences dans les finals sous ce chapitre
};

export type ProgramOverview = {
  topics: TopicView[];
  chapters: PlanChapterView[]; // v2 — plan de cours du prof (vide si non dérivable pour ce cours)
  planOk: boolean; // le plan a-t-il été dérivé pour ce cours ?
  stats: {
    total: number;
    covered: number; // ≥1 tentative
    mastered: number; // score ≥ seuil
    due: number; // à revoir maintenant (dont jamais vu)
    coveragePct: number; // % du poids examen au moins abordé
    masteryPct: number; // % du poids examen maîtrisé (pondéré par score/10)
  };
};

// ---------------- Allégée — enrichissement par-topic (deep-links + ordre de cours + points réels) ----------------

/**
 * Dérive une CLÉ D'ORDRE DE COURS depuis un `course_href` (deep-link vers le passage de cours,
 * = « là où la notion est traitée », pas la 1re mention : courseHrefFor vise le meilleur hit de
 * matériel de cours). Signal principal = n° de lecture ; signal fin = page. Formats gérés :
 *   - ML / algo : /csrc?course=…&p=slides%2Flecture_12.pdf#page=31  → lecture 12, page 31
 *   - algo      : …p=…Lecture10withoutanim.pdf                      → lecture 10
 *   - cs-202    : …CS202_Lectures_Part2…#page=N (offset) ou index.html#chapN
 * Renvoie null si aucun signal (le topic finit en bas du tri « Par section »).
 */
export function courseOrderKey(courseHref: string | null | undefined): number | null {
  if (!courseHref) return null;
  const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };
  const mP = courseHref.match(/[?&](?:p|src)=([^&#]+)/);
  const p = mP ? dec(mP[1]) : courseHref;
  const page = Number(courseHref.match(/#page=(\d+)/)?.[1] ?? 0) || 0;
  const mLec = p.match(/lect(?:ure)?[ _-]?0*(\d+)/i); // lecture_12 / Lecture10 / lecture 3
  if (mLec) return Number(mLec[1]) * 100000 + page;
  const mPart = p.match(/part[ _-]?0*(\d+)/i); // cs-202 : Part1 (L1-10) / Part2 (L11-18)
  if (mPart) return (Number(mPart[1]) <= 1 ? 1 : 11) * 100000 + page;
  const mChap = courseHref.match(/#(?:chap(?:ter)?[-_]?)?0*(\d+)/i); // index.html#chapN
  if (mChap) return Number(mChap[1]) * 100000 + page;
  return page > 0 ? 9_000_000 + page : null; // page seule = signal faible → en fin
}

type TopicExamAgg = {
  pointsSum: number | null; occurrences: number;
  examHref: string | null; examYear: number | null; examPage: number | null;
  courseHref: string | null; courseOrder: number | null;
};

/** Agrège l'index `exam_exercises` par topic_id : vrais points, occurrences, deep-links représentatifs
 *  (occurrence la plus récente pour l'examen ; 1er non-nul pour le cours), et clé d'ordre de cours (médiane). */
async function topicExamAggregates(): Promise<Map<number, TopicExamAgg>> {
  const out = new Map<number, TopicExamAgg>();
  let rows: { topicId: number; examYear: number | null; examPage: number | null; points: number | null; examHref: string | null; courseHref: string | null }[] = [];
  try {
    await ensureIndexSchema();
    rows = await q.all(`SELECT topic_id topicId, exam_year examYear, exam_page examPage, points, exam_href examHref, course_href courseHref FROM exam_exercises WHERE topic_id IS NOT NULL`);
  } catch { return out; }
  const byTopic = new Map<number, typeof rows>();
  for (const r of rows) { if (!byTopic.has(r.topicId)) byTopic.set(r.topicId, []); byTopic.get(r.topicId)!.push(r); }
  for (const [tid, exos] of byTopic) {
    // Lien EXAMEN = occurrence la plus récente (année desc, puis page asc).
    const rep = [...exos].sort((a, b) => (b.examYear ?? 0) - (a.examYear ?? 0) || (a.examPage ?? 0) - (b.examPage ?? 0))[0];
    const pts = exos.reduce((s, e) => s + (Number(e.points) > 0 ? Number(e.points) : 0), 0);
    // Lien COURS + ordre = la LECTURE MODALE (celle où le plus d'occurrences pointent = le passage
    // où la notion est le plus souvent traitée), robuste au bruit de la recherche ; à l'intérieur,
    // la page médiane. Le lien affiché et le tri « Par section » sont donc cohérents et stables.
    const all = exos
      .map((e) => ({ href: e.courseHref, key: courseOrderKey(e.courseHref) }))
      .filter((x): x is { href: string | null; key: number } => x.key != null);
    // si un signal de LECTURE existe (key < 9M), on ignore les liens « page seule » (fallback bruité).
    const entries = all.some((e) => e.key < 9_000_000) ? all.filter((e) => e.key < 9_000_000) : all;
    const lecOf = (k: number) => Math.floor(k / 100000);
    const buckets = new Map<number, { href: string | null; key: number }[]>();
    for (const e of entries) { const L = lecOf(e.key); if (!buckets.has(L)) buckets.set(L, []); buckets.get(L)!.push(e); }
    // lecture modale : plus d'occurrences, puis la lecture la plus précoce
    const mode = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0])[0];
    let courseOrder: number | null = null, courseHref: string | null = null;
    if (mode) {
      const group = mode[1].sort((a, b) => a.key - b.key);
      const medKey = group[Math.floor((group.length - 1) / 2)].key;
      courseOrder = medKey;
      courseHref = (group.find((e) => e.key === medKey) ?? group[0]).href;
    }
    out.set(tid, {
      pointsSum: pts > 0 ? pts : null, occurrences: exos.length,
      examHref: rep?.examHref ?? null, examYear: rep?.examYear ?? null, examPage: rep?.examPage ?? null,
      courseHref: courseHref ?? exos.map((e) => e.courseHref).find((h) => h) ?? null,
      courseOrder,
    });
  }
  return out;
}

/** Tableau de bord : chaque type + maîtrise + couverture + statut révision, et stats globales pondérées. */
export async function programOverview(): Promise<ProgramOverview> {
  await ensureProgramSchema();
  const topics = await topicRows();
  const exAgg = await topicExamAggregates();
  const occ = await occurrencesByTopic();
  const mast = new Map<number, MasteryRow & { lastExamId: number | null }>();
  for (const m of await q.all<MasteryRow & { lastExamId: number | null }>(
    `SELECT topic_id topicId, score, attempts, last_score lastScore, last_done_at lastDoneAt, due_at dueAt, ease, interval_days intervalDays, last_exam_id lastExamId FROM mastery`
  ))
    mast.set(m.topicId, m);

  const now = Date.now();
  const views: TopicView[] = topics.map((t) => {
    const m = mast.get(t.id);
    const attempts = m?.attempts ?? 0;
    const score = m?.score ?? null;
    const dueAt = m?.dueAt ?? null;
    const status: TopicView["status"] =
      attempts === 0 ? "never" : dueAt && new Date(dueAt).getTime() <= now ? "due" : "ok";
    const ex = exAgg.get(t.id);
    return {
      ...t,
      mastery: score == null ? null : Math.round(score * 10) / 10,
      attempts,
      lastScore: m?.lastScore ?? null,
      lastDoneAt: m?.lastDoneAt ?? null,
      lastExamId: m?.lastExamId ?? null,
      dueAt,
      status,
      pointsSum: ex?.pointsSum ?? null,
      occurrences: ex?.occurrences ?? 0,
      examHref: ex?.examHref ?? null,
      examYear: ex?.examYear ?? null,
      examPage: ex?.examPage ?? null,
      courseHref: ex?.courseHref ?? null,
      courseOrder: ex?.courseOrder ?? null,
      chapterId: t.chapterId ?? null,
      occurrences_all: occ.get(t.id) ?? [],
    };
  });

  const totalW = views.reduce((s, t) => s + t.examWeight, 0) || 1;
  const coveredW = views.filter((t) => t.attempts > 0).reduce((s, t) => s + t.examWeight, 0);
  const masteryW = views.reduce((s, t) => s + t.examWeight * ((t.mastery ?? 0) / 10), 0);
  const stats = {
    total: views.length,
    covered: views.filter((t) => t.attempts > 0).length,
    mastered: views.filter((t) => (t.mastery ?? 0) >= MASTERY_THRESHOLD).length,
    due: views.filter((t) => t.status !== "ok").length,
    coveragePct: Math.round((coveredW / totalW) * 100),
    masteryPct: Math.round((masteryW / totalW) * 100),
  };

  // v2 — plan de cours du prof + compteurs de tête de chapitre (dérivés des notions rattachées).
  const chapters0 = await getPlanChapters();
  const chapters: PlanChapterView[] = chapters0.map((c) => {
    const inCh = views.filter((t) => t.chapterId === c.id);
    return {
      ...c,
      notionCount: inCh.length,
      fallenCount: inCh.filter((t) => (t.occurrences ?? 0) > 0 || t.examCount > 0).length,
      occurrenceCount: inCh.reduce((s, t) => s + ((t.occurrences ?? 0) > 0 ? t.occurrences! : t.examCount), 0),
    };
  });

  return { topics: views, chapters, planOk: chapters.length > 0, stats };
}

export async function getTopic(id: number): Promise<Topic | null> {
  await ensureProgramSchema();
  await ensurePlanSchema();
  const r = (await q.get<any>(
    `SELECT id, label, method, exo_type exoType, trap, category, archetype, exam_weight examWeight, exam_count examCount, source, description, plan_chapter_id chapterId FROM topics WHERE id = ?`,
    id
  )) as any;
  return r ?? null;
}

// ---------------- PHASE 3 — Boucle score 0-10 → courbe de l'oubli ----------------

/**
 * Prochain type à travailler : priorise (poids examen × faible maîtrise × dû). Jamais-vu et
 * en-retard d'abord ; un type à jour (pas encore dû) est dépriorisé. Renvoie le type le plus rentable.
 */
export async function nextTopic(): Promise<TopicView | null> {
  const { topics } = await programOverview();
  if (!topics.length) return null;
  const now = Date.now();
  const score = (t: TopicView) => {
    const gap = (10 - (t.mastery ?? 0)) / 10; // jamais vu → 1 (max)
    const dueFactor = t.attempts === 0 ? 1 : t.dueAt && new Date(t.dueAt).getTime() <= now ? 1 : 0.3;
    return t.examWeight * gap * dueFactor;
  };
  return [...topics].sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** PHASE 4 — parcours « couvrir tout le programme » : le type le plus LOURD encore sous le seuil. */
export async function coverageNext(threshold = MASTERY_THRESHOLD): Promise<TopicView | null> {
  const { topics } = await programOverview();
  const now = Date.now();
  const remaining = topics.filter((t) => (t.mastery ?? 0) < threshold);
  if (!remaining.length) return null;
  // le plus lourd d'abord ; à poids égal, ce qui est dû / jamais vu passe devant
  return [...remaining].sort((a, b) => {
    if (b.examWeight !== a.examWeight) return b.examWeight - a.examWeight;
    const da = a.attempts === 0 ? 0 : a.dueAt && new Date(a.dueAt).getTime() <= now ? 1 : 2;
    const db = b.attempts === 0 ? 0 : b.dueAt && new Date(b.dueAt).getTime() <= now ? 1 : 2;
    return da - db;
  })[0];
}

/** Sujet d'ancrage passé au générateur d'exo ciblé pour rester sur CE type. */
export function topicTarget(t: Topic): string {
  // V5 — la cible de génération porte la méthode, le FORMAT réel de l'exo et le piège typique
  // (dérivés des vrais finals) → l'architecte produit le bon type, pas une version générique.
  return [
    t.label,
    t.method ? `Méthode : ${t.method}.` : "",
    t.exoType ? `Format réel de l'exo : ${t.exoType}.` : "",
    t.trap ? `Piège typique à punir : ${t.trap}.` : "",
  ].filter(Boolean).join(" ");
}

/**
 * SM-2 (même mécanique que schedule.ts : interval × ease), mappé depuis un score 0-10.
 * Score bas → intervalle court (le type revient bientôt) ; score haut → intervalle long.
 */
function sm2Step(prev: { ease: number; intervalDays: number; attempts: number } | null, score: number) {
  const q = Math.max(0, Math.min(5, Math.round(score / 2))); // 0-10 → qualité 0-5
  const ease0 = prev?.ease ?? 2.5;
  const ease = Math.max(1.3, Math.min(3.0, ease0 + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))));
  let interval: number;
  if (score <= 3) interval = 1; // raté → revient demain
  else if (!prev || prev.attempts <= 0) interval = 2;
  else if (prev.attempts === 1) interval = 4;
  else interval = Math.max(1, Math.round(prev.intervalDays * ease));
  interval = Math.min(interval, 120);
  return { ease: Math.round(ease * 100) / 100, interval };
}

export type ScoreResult = { topic: TopicView; stats: ProgramOverview["stats"]; weaknessId?: number };

/**
 * Enregistre un score 0-10 sur un type : met à jour la maîtrise LISSÉE et la répétition espacée.
 * Score ≤ 3 → crée/renforce une faiblesse (réutilise le système faiblesses → pilote aussi les examens).
 */
export async function recordScore(topicId: number, rawScore: number, lastExamId?: number): Promise<ScoreResult> {
  await ensureProgramSchema();
  const topic = await getTopic(topicId);
  if (!topic) throw new Error("Type introuvable.");
  const score = Math.max(0, Math.min(10, Math.round(rawScore)));
  const prev = await q.get<{ score: number | null; attempts: number; ease: number; intervalDays: number }>(
    `SELECT score, attempts, ease, interval_days intervalDays FROM mastery WHERE topic_id = ?`,
    topicId
  );

  const smoothed = prev?.score == null ? score : Math.round((0.5 * prev.score + 0.5 * score) * 10) / 10;
  const { ease, interval } = sm2Step(prev ? { ease: prev.ease, intervalDays: prev.intervalDays, attempts: prev.attempts } : null, score);
  const attempts = (prev?.attempts ?? 0) + 1;

  await q.run(
    `INSERT INTO mastery (topic_id, score, attempts, last_score, last_done_at, due_at, ease, interval_days, last_exam_id)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(topic_id) DO UPDATE SET
         score=excluded.score, attempts=excluded.attempts, last_score=excluded.last_score,
         last_done_at=excluded.last_done_at, due_at=excluded.due_at, ease=excluded.ease,
         interval_days=excluded.interval_days,
         last_exam_id=COALESCE(excluded.last_exam_id, mastery.last_exam_id)`,
    topicId, smoothed, attempts, score, nowStr(), nowPlusDays(interval), ease, interval, lastExamId ?? null
  );

  // Score bas → renforce une faiblesse (réutilise le système faiblesses → pilote aussi les examens).
  // Jamais bloquant : une erreur ici ne doit pas faire échouer l'enregistrement du score.
  let weaknessId: number | undefined;
  if (score <= 3) {
    try {
      await ensureWeaknessSchema(); // garantit les colonnes source/theme (no-op si déjà là, ex. cs-202)
      // ne pas spammer : une seule faiblesse 'program' par type
      const exists = await q.get<{ id: number }>(
        `SELECT id FROM weaknesses WHERE source = 'program' AND topic = ? LIMIT 1`,
        topic.label
      );
      if (!exists) {
        weaknessId = await createWeakness({
          topic: topic.label,
          description: `Score ${score}/10 en entraînement « Programme ». Méthode à retravailler : ${topic.method ?? topic.label}.`,
          severity: score <= 1 ? 3 : 2,
          source: "program",
          theme: topic.category ?? undefined,
          analyzed: true,
        });
      }
    } catch (e) {
      console.error("[program] création de faiblesse ignorée :", (e as Error).message);
    }
  }

  const ov = await programOverview();
  const view = ov.topics.find((t) => t.id === topicId)!;
  return { topic: view, stats: ov.stats, weaknessId };
}
