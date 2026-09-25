import { currentCourse } from "@/db/client";
import { q } from "@/db/q";
import { completeText, extractJson } from "@/lib/llm";
import { profile } from "@/lib/course-profile";
import { sourceHref } from "@/lib/deeplink";

/**
 * PLAN DE COURS DU PROF (le cœur de l'analyse Programme).
 *
 * On dérive le chapitrage RÉEL du cours depuis le support du prof (les « Cours (PDF) » /
 * slides ingérés, type='course_pdf') : chaque lecture = un chapitre, dans SON ordre, avec le
 * titre EXACT que le prof lui a donné (lu sur la page de garde de la slide — jamais fabriqué).
 * Puis on rattache chaque notion examinée (topics, issues des vrais finals) au chapitre qui la
 * TRAITE réellement, par une passe de classification CONTRAINTE à la liste réelle des lectures.
 *
 * GARDE-FOU zéro invention :
 *  - Le titre d'un chapitre est validé mot-à-mot contre le texte source de la slide ; s'il ne
 *    l'est pas, on retombe sur une extraction déterministe du texte (jamais un titre inventé).
 *  - Un cours sans structure exploitable (< 3 lectures détectées, ex. cs-202) → { ok:false } :
 *    l'appelant retombe honnêtement sur le regroupement existant, aucun chapitre fabriqué.
 *  - Une notion sans chapitre plausible → plan_chapter_id = null (« Non rattaché »), pas forcée.
 */

export type PlanChapter = {
  id: number;
  seq: number;
  lectureNo: number | null;
  title: string;
  subtitle: string | null;
  summary: string | null;
  sourceHref: string | null;
};

export async function ensurePlanSchema(): Promise<void> {
  await q.ensureTable("plan_chapters");
  await q.ensureTable("topics"); // topics doit exister pour la colonne
  await q.ensureColumns("topics", ["plan_chapter_id"]);
}

// ---------------- Lecture des slides du prof ----------------

type LectureDoc = { sourceId: number; path: string; lectureId: string | null; fileNo: number | null; text: string };

/** normalise pour comparaison faithfulness : minuscules, sans accents, alphanumérique. */
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** n° de lecture porté par le nom de fichier (indice, ex. slides/lecture_7.pdf, Lecture16_without_anim.pdf). */
function fileLectureNo(path: string, lectureId: string | null): number | null {
  const m = (lectureId ?? "").match(/(\d+)/) || path.match(/lect(?:ure)?[ _-]?0*(\d+)/i);
  return m ? Number(m[1]) : null;
}

/** Récupère chaque document de cours du prof (course_pdf) avec le texte de ses 2 premières pages. */
async function gatherLectures(): Promise<LectureDoc[]> {
  const srcs = await q.all<{ id: number; path: string }>(
    `SELECT id, path FROM sources WHERE type = 'course_pdf' ORDER BY id`
  );
  const out: LectureDoc[] = [];
  for (const s of srcs) {
    // page de garde (page 1, + page 2 en secours) = là où le prof titre la lecture.
    // lecture_id vit sur items (pas sur sources) → on le lit ici.
    const rows = await q.all<{ text: string; lecture_id: string | null }>(
      `SELECT text, lecture_id FROM items WHERE source_id = ? ORDER BY id LIMIT 3`,
      s.id
    );
    const text = rows.map((r) => r.text).join(" ").replace(/\s+/g, " ").trim().slice(0, 700);
    if (!text) continue;
    const lectureId = rows.find((r) => r.lecture_id)?.lecture_id ?? null;
    out.push({ sourceId: s.id, path: s.path, lectureId, fileNo: fileLectureNo(s.path, lectureId), text });
  }
  return out;
}

// ---------------- Extraction déterministe (repli, 100 % fidèle) ----------------

/** Titre extrait SANS LLM depuis le texte de garde. Deux formats connus + nettoyage prudent. */
function deterministicTitle(text: string, fileNo: number | null): { no: number | null; title: string | null } {
  const t = text.replace(/\s+/g, " ").trim();
  const no = Number(t.match(/Lecture\s+0*(\d+)\b/i)?.[1] ?? "") || fileNo || null;
  let title: string | null = null;
  // Format « … Lecture N: <Titre> » (ex. ML : « Lecture 7: Kernel Methods »)
  const a = t.match(/Lecture\s+\d+\s*[:.–\-]\s*(.+)$/i);
  if (a) title = a[1];
  // Format « Algorithms: <Titre> <Auteur> School of … » (ex. CS-250)
  if (!title) {
    const b = t.match(/^[A-Za-z ]*?:\s*(.+?)\s+(?:School of|Ola|Miltiadis|Miltos|Neel|Michael)\b/);
    if (b) title = b[1];
  }
  if (title) {
    title = title
      .replace(/\bSchool of.*$/i, "")
      .replace(/\bLecture\s+\d+.*$/i, "")
      .replace(/\bSlides? in.*$/i, "")
      .replace(/\s*\(?\d{1,2}[./]\d{1,2}[./]\d{2,4}\)?.*$/, "") // dates
      .replace(/\s*\b\d+\s*$/, "") // n° de slide résiduel
      .replace(/[–\-•·|,\s]+$/g, "")
      .trim();
  }
  return { no, title: title && title.length >= 2 ? title.slice(0, 120) : null };
}

/** Le titre proposé est-il ancré dans le texte de la slide ? (≥ 60 % de ses mots signifiants présents). */
function titleIsFaithful(title: string, sourceText: string): boolean {
  const src = " " + norm(sourceText) + " ";
  const words = norm(title).split(" ").filter((w) => w.length >= 3);
  if (!words.length) return false;
  const hit = words.filter((w) => src.includes(" " + w + " ") || src.includes(" " + w)).length;
  return hit / words.length >= 0.6;
}

// ---------------- Dérivation du plan ----------------

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    chapters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          lecture_no: { type: "integer", description: "Le numéro de lecture du prof (tel qu'écrit sur la page de garde)." },
          title: { type: "string", description: "Le titre EXACT du chapitre tel que le prof l'a écrit sur la slide (verbatim, sans le code du cours, sans l'auteur, sans la date). N'invente jamais." },
        },
        required: ["lecture_no", "title"],
        additionalProperties: false,
      },
    },
  },
  required: ["chapters"],
  additionalProperties: false,
} as const;

type RawChapter = { lecture_no?: number; title?: string };

export type DerivePlanResult = { ok: boolean; chapters: number; reason?: string };

/**
 * Extrait et PERSISTE le plan de cours du prof pour le cours courant. LLM d'extraction (titres
 * verbatim) validé contre le texte source ; repli déterministe par item ; { ok:false } si le
 * cours n'expose pas de structure de lectures exploitable.
 */
export async function deriveCoursePlan(opts: { onStep?: (m: string, p: number) => void } = {}): Promise<DerivePlanResult> {
  await ensurePlanSchema();
  const step = opts.onStep ?? (() => {});
  const course = currentCourse();
  const lectures = await gatherLectures();
  step(`Lecture du support du prof : ${lectures.length} document(s) de cours…`, 10);
  if (lectures.length < 3) {
    return { ok: false, chapters: 0, reason: `Seulement ${lectures.length} document(s) de cours ingéré(s) — pas de plan structuré exploitable pour ce cours.` };
  }

  // Seed déterministe (fidèle par construction) — sert de repli item par item.
  const seed = new Map<number, { no: number | null; title: string | null; text: string; path: string }>();
  for (const l of lectures) {
    const d = deterministicTitle(l.text, l.fileNo);
    seed.set(l.sourceId, { ...d, text: l.text, path: l.path });
  }

  // Passe LLM : titres verbatim (plus robuste aux formats variés que le regex).
  let llm: RawChapter[] = [];
  try {
    const p = profile();
    const prompt = [
      p.qaIntro?.() ?? "Tu es l'équipe enseignante du cours.",
      `Voici les PAGES DE GARDE des lectures du cours (le support du prof), dans le désordre. Reconstruis le PLAN DU COURS = la liste ORDONNÉE des chapitres, un par lecture, avec le TITRE EXACT que le prof a donné à chaque lecture (verbatim, tel qu'écrit sur la slide). N'invente AUCUN chapitre ni titre : recopie le titre réel, sans le code du cours, sans le nom de l'enseignant, sans la date, sans le numéro de slide.`,
      ``,
      ...lectures.map((l, i) => `  [${i}] fichier=${l.path}${l.fileNo ? ` (lecture ${l.fileNo} ?)` : ""} — garde : « ${l.text.slice(0, 240)} »`),
      ``,
      `Réponds UNIQUEMENT avec l'objet JSON { "chapters": [ { "lecture_no", "title" }, … ] } trié par lecture_no croissant.`,
      JSON.stringify(PLAN_SCHEMA, null, 2),
    ].join("\n");
    step("Extraction du plan (titres du prof, verbatim)…", 45);
    const parsed = extractJson<{ chapters?: RawChapter[] }>(await completeText({ prompt, model: "opus", timeoutMs: 240_000 }));
    llm = (parsed?.chapters ?? []).filter((c) => c && c.title && c.title.trim());
  } catch (e) {
    step(`Extraction LLM indisponible (${(e as Error).message.slice(0, 40)}) → repli déterministe`, 60);
  }

  // Fusion : pour chaque lecture réelle (indexée par son n° de fichier/texte), on prend le titre
  // LLM s'il est FIDÈLE au texte source, sinon le titre déterministe, sinon on passe (jamais inventé).
  const llmByNo = new Map<number, string>();
  for (const c of llm) if (typeof c.lecture_no === "number" && c.title) llmByNo.set(c.lecture_no, c.title.trim());

  type Built = { no: number; title: string; path: string };
  const built: Built[] = [];
  const usedNo = new Set<number>();
  for (const l of lectures) {
    const s = seed.get(l.sourceId)!;
    const no = s.no ?? l.fileNo;
    if (no == null || usedNo.has(no)) continue;
    const cand = llmByNo.get(no);
    let title: string | null = null;
    if (cand && titleIsFaithful(cand, s.text)) title = cand.replace(/[–\-•·|,\s]+$/g, "").trim();
    if (!title) title = s.title; // repli déterministe fidèle
    if (!title) continue; // aucune source fiable → on n'invente pas
    usedNo.add(no);
    built.push({ no, title: title.slice(0, 120), path: l.path });
  }
  built.sort((a, b) => a.no - b.no);

  if (built.length < 3) {
    return { ok: false, chapters: built.length, reason: "Structure de lectures illisible — repli sur le regroupement existant." };
  }

  step("Enregistrement du plan de cours…", 80);
  await q.tx(async () => {
    await q.exec(`DELETE FROM plan_chapters`); // plan reconstruit à chaque passe
    let seq = 0;
    for (const b of built) {
      await q.run(
        `INSERT INTO plan_chapters (seq, lecture_no, title, subtitle, summary, source_href) VALUES (?,?,?,?,?,?)`,
        seq++, b.no, b.title, `Lecture ${b.no}`, null, sourceHref(course, b.path, `${b.path}#page=1`)
      );
    }
  });
  step(`Plan de cours : ${built.length} chapitres ✓`, 100);
  return { ok: true, chapters: built.length };
}

// ---------------- Rattachement des notions aux chapitres ----------------

const MAP_SCHEMA = {
  type: "object",
  properties: {
    mapping: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "integer", description: "id de la notion." },
          lecture_no: { type: ["integer", "null"], description: "Numéro de la lecture qui TRAITE substantiellement cette notion (dans la liste fournie), ou null si aucune ne convient. N'invente pas de numéro." },
        },
        required: ["id", "lecture_no"],
        additionalProperties: false,
      },
    },
  },
  required: ["mapping"],
  additionalProperties: false,
} as const;

export type MapNotionsResult = { ok: boolean; mapped: number; total: number; reason?: string };

/**
 * Rattache chaque notion (topics) au chapitre du plan qui la traite, par classification CONTRAINTE
 * à la liste réelle des lectures (jamais une taxonomie inventée, jamais un n° hors liste). Persiste
 * topics.plan_chapter_id. Les notions non classables restent null (« Non rattaché »).
 */
export async function mapNotionsToChapters(opts: { onStep?: (m: string, p: number) => void } = {}): Promise<MapNotionsResult> {
  await ensurePlanSchema();
  const step = opts.onStep ?? (() => {});
  const chapters = await q.all<{ id: number; lecture_no: number | null; title: string }>(
    `SELECT id, lecture_no, title FROM plan_chapters ORDER BY seq`
  );
  const topics = await q.all<{ id: number; label: string; method: string | null; category: string | null; description: string | null }>(
    `SELECT id, label, method, category, description FROM topics ORDER BY id`
  );
  if (!chapters.length) return { ok: false, mapped: 0, total: topics.length, reason: "Aucun plan de cours dérivé — rattachement impossible." };
  if (!topics.length) return { ok: true, mapped: 0, total: 0 };

  const byNo = new Map<number, number>(); // lecture_no → chapter id
  for (const c of chapters) if (c.lecture_no != null) byNo.set(c.lecture_no, c.id);

  step(`Rattachement de ${topics.length} notions au plan (${chapters.length} chapitres)…`, 40);
  let mapping: { id: number; lecture_no: number | null }[] = [];
  try {
    const p = profile();
    const prompt = [
      p.qaIntro?.() ?? "Tu es l'équipe enseignante du cours.",
      `Voici le PLAN DU COURS (chapitres du prof, dans l'ordre) puis les NOTIONS qui tombent aux finals. Pour CHAQUE notion, indique le numéro de la lecture qui la TRAITE substantiellement (là où un étudiant l'apprend), en te limitant STRICTEMENT à la liste de lectures ci-dessous. Si aucune lecture ne traite vraiment la notion, réponds null. N'invente jamais un numéro absent de la liste.`,
      ``,
      `═══ PLAN DU COURS (lecture_no · titre) ═══`,
      ...chapters.map((c) => `  - ${c.lecture_no ?? "?"} · ${c.title}`),
      ``,
      `═══ NOTIONS À RATTACHER (id · notion · méthode · thème) ═══`,
      ...topics.map((t) => `  - ${t.id} · ${t.label}${t.method ? ` — ${t.method}` : ""}${t.category ? ` [${t.category}]` : ""}`),
      ``,
      `Réponds UNIQUEMENT avec { "mapping": [ { "id", "lecture_no" }, … ] } couvrant TOUTES les notions.`,
      JSON.stringify(MAP_SCHEMA, null, 2),
    ].join("\n");
    const parsed = extractJson<{ mapping?: { id: number; lecture_no: number | null }[] }>(
      await completeText({ prompt, model: "opus", timeoutMs: 600_000 })
    );
    mapping = parsed?.mapping ?? [];
  } catch (e) {
    return { ok: false, mapped: 0, total: topics.length, reason: `Classification indisponible (${(e as Error).message.slice(0, 60)}).` };
  }

  const topicIds = new Set(topics.map((t) => t.id));
  step("Enregistrement des rattachements…", 85);
  let mapped = 0;
  await q.tx(async () => {
    // repli propre : tout non couvert → null (pas de rattachement forcé)
    await q.run(`UPDATE topics SET plan_chapter_id = NULL`);
    for (const m of mapping) {
      if (!topicIds.has(m.id)) continue;
      const chId = m.lecture_no != null ? byNo.get(m.lecture_no) : undefined;
      if (chId == null) continue; // lecture_no hors liste ou null → non rattaché
      await q.run(`UPDATE topics SET plan_chapter_id = ? WHERE id = ?`, chId, m.id);
      mapped++;
    }
  });
  step(`Rattachement : ${mapped}/${topics.length} notions placées ✓`, 100);
  return { ok: true, mapped, total: topics.length };
}

/** Dérive le plan PUIS rattache les notions, en une passe (utilisé par « Ré-analyser » et le script). */
export async function rebuildCoursePlan(opts: { onStep?: (m: string, p: number) => void } = {}): Promise<{ plan: DerivePlanResult; map: MapNotionsResult }> {
  const step = opts.onStep ?? (() => {});
  const plan = await deriveCoursePlan({ onStep: (s, p) => step(s, Math.round(p * 0.5)) });
  if (!plan.ok) return { plan, map: { ok: false, mapped: 0, total: 0, reason: plan.reason } };
  const map = await mapNotionsToChapters({ onStep: (s, p) => step(s, 50 + Math.round(p * 0.5)) });
  return { plan, map };
}

// ---------------- Lecture (pour l'API) ----------------

export async function getPlanChapters(): Promise<PlanChapter[]> {
  await ensurePlanSchema();
  const rows = await q.all<{ id: number; seq: number; lecture_no: number | null; title: string; subtitle: string | null; summary: string | null; source_href: string | null }>(
    `SELECT id, seq, lecture_no, title, subtitle, summary, source_href FROM plan_chapters ORDER BY seq`
  );
  return rows.map((r) => ({ id: r.id, seq: r.seq, lectureNo: r.lecture_no, title: r.title, subtitle: r.subtitle, summary: r.summary, sourceHref: r.source_href }));
}
