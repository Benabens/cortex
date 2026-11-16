import { ensureFts, currentCourse } from "@/db/client";
import { q } from "@/db/q";
import { indexItemForSearch, unindexSource } from "@/lib/search";
import { sourceHref } from "@/lib/deeplink";
import { contentRoot, refsDir } from "@/lib/paths";
import { getCourse } from "@/lib/courses";
import * as cheerio from "cheerio";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { extractOfficeText } from "@/lib/office-documents";
import { purgePdfPages } from "@/lib/page-cache";
import { storage } from "@/lib/storage";
import { failureStatus, readStatus, type IngestFileOutcome } from "@/lib/ingest-report";
import { examKind, examYear, withoutSolutions } from "@/lib/exam-names";

/**
 * Examens de référence : le « format » à imiter pour la génération.
 *
 * Deux origines possibles :
 *  - des examens déjà dans le corpus (sites de révision) que tu coches comme référence ;
 *  - des examens que tu UPLOADES (PDF/HTML/txt) → stockés dans data/refs/ (commités, donc
 *    synchronisés), parsés et indexés comme des sources final/midterm normales.
 *
 * La sélection vit dans une table à part `exam_refs`, indexée par CHEMIN (stable), pour
 * survivre à `npm run ingest` qui reconstruit sources/items à chaque fois.
 */

/** Dossier des examens de référence du cours COURANT (cs-202 → data/refs ; autres → data/<id>/refs). */
export const REFS_DIR = () => refsDir();

export async function ensureRefsSchema(): Promise<void> {
  await q.ensureTable("exam_refs");
}

const clean = (s: string) => s.replace(/\s+/g, " ").replace(/ /g, " ").trim();

function recencyWeight(year: number | null): number {
  if (!year) return 1.5;
  if (year >= 2025) return 3;
  if (year === 2024) return 2.5;
  if (year === 2023) return 2;
  if (year === 2022) return 1.6;
  if (year === 2021) return 1.3;
  return 1;
}

/** Devine type d'examen + année depuis un nom de fichier. */
export function inferExamMeta(filename: string): { kind: "final" | "midterm"; year: number | null } {
  return { kind: examKind(filename) ?? "final", year: examYear(filename) };
}

// ---- insertion bas niveau (mêmes tables que l'ingestion) via la façade q,
// qui met les statements en cache sur la DB du cours courant ----
const INS_SOURCE_SQL = `INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`;
const INS_ITEM_SQL = `INSERT INTO items (source_id, type, lecture_id, title, text, html, images, tags, anchor)
     VALUES (?,?,?,?,?,?,?,?,?)`;

/** Lit un fichier de référence et en extrait un titre + des pages de texte. */
async function parseRefFile(abs: string): Promise<{ title: string; pages: string[] }> {
  const ext = path.extname(abs).toLowerCase();
  const base = path.basename(abs);
  const buf = await storage().read(abs);
  if (!buf) throw new Error(`Fichier introuvable : ${base}`);
  if (ext === ".pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = (Array.isArray(text) ? text : [text]).map(clean).filter((t) => t.length > 3);
    return { title: base.replace(/\.pdf$/i, ""), pages };
  }
  if (ext === ".html" || ext === ".htm") {
    const $ = cheerio.load(buf.toString("utf8"));
    $("script, style").remove();
    const title = clean($("title").first().text()) || clean($("h1, h2").first().text()) || base;
    return { title, pages: [clean($("body").text())] };
  }
  if (ext === ".docx" || ext === ".pptx") {
    return { title: base.replace(/\.[^.]+$/, ""), pages: [await extractOfficeText(buf, ext)] };
  }
  // .txt / .md / autres : texte brut
  return { title: base.replace(/\.[^.]+$/, ""), pages: [clean(buf.toString("utf8"))] };
}

/** Une annale lue (titre, pages de texte), pas encore écrite dans le corpus. */
export type ParsedRef = { relPath: string; title: string; pages: string[] };

/** Passages indexables d'une annale lue : une page de moins de 3 caractères ne compte pas. */
const refChunks = (pages: string[]) => (pages.length ? pages : [""]);
const indexableCount = (pages: string[]) => refChunks(pages).filter((t) => t.length >= 3).length;

async function readRefFile(relPath: string): Promise<ParsedRef> {
  const { title, pages } = await parseRefFile(path.join(REFS_DIR(), path.basename(relPath)));
  return { relPath, title, pages };
}

/**
 * Écrit une annale lue dans sources/items/fts et exam_refs. Idempotent par chemin : purge
 * l'ancienne source de même path avant de réinsérer. Rend le nombre de passages indexés.
 */
export async function writeRef({ relPath, title, pages }: ParsedRef): Promise<number> {
  ensureFts();
  const { kind, year } = inferExamMeta(path.basename(relPath));
  const old = await q.all<{ id: number }>(`SELECT id FROM sources WHERE path = ?`, relPath);
  for (const { id } of old) {
    await unindexSource(id);
    await q.run(`DELETE FROM items WHERE source_id = ?`, id);
    await q.run(`DELETE FROM sources WHERE id = ?`, id);
  }

  const sid = await q.insert(INS_SOURCE_SQL, kind, title, relPath, year, recencyWeight(year));
  const chunks = refChunks(pages);
  for (const [i, text] of chunks.entries()) {
    if (text.length < 3) continue;
    const label = chunks.length > 1 ? `${title}, p. ${i + 1}` : title;
    const anchor = chunks.length > 1 ? `${relPath}#page=${i + 1}` : relPath;
    const itemId = await q.insert(
      INS_ITEM_SQL,
      sid, "exercise", null, label, text, null, null, null, anchor
    );
    await indexItemForSearch(itemId, sid, label, text);
  }

  // Tout fichier de data/refs/ EST un examen de référence (la sélection survit au ré-ingest).
  await ensureRefsSchema();
  const wasUploaded = (await q.get<{ uploaded: number }>(`SELECT uploaded FROM exam_refs WHERE path = ?`, relPath))?.uploaded ?? 1;
  await q.run(
    `INSERT INTO exam_refs (path, title, year, kind, uploaded) VALUES (?,?,?,?,?)
     ON CONFLICT(path) DO UPDATE SET title = excluded.title, year = excluded.year, kind = excluded.kind, uploaded = excluded.uploaded`,
    relPath, title, year, kind, wasUploaded
  );
  return indexableCount(pages);
}

/** Lit puis écrit UNE annale (dépôt depuis l'app) ; lève si elle ne se lit pas. */
export async function ingestRefFile(relPath: string): Promise<{ items: number }> {
  return { items: await writeRef(await readRefFile(relPath)) };
}

/**
 * Lit toutes les annales de data/refs/ SANS rien écrire (scripts/ingest.ts écrit ensuite tout le
 * corpus en une transaction). Un fichier qui ne se lit pas est isolé : les suivants sont lus
 * quand même, et son issue figure dans le rapport.
 */
export async function readAllRefs(): Promise<{ parsed: ParsedRef[]; outcomes: IngestFileOutcome[] }> {
  const dir = REFS_DIR();
  // uniquement des FICHIERS d'examen (ignore les sous-dossiers figref/ img/ et les fichiers cachés)
  const files = (await storage().list(dir))
    .filter((e) => path.dirname(e.path) === path.resolve(dir))
    .map((e) => path.basename(e.path))
    .filter((name) => !name.startsWith(".") && /\.(pdf|html?|txt|md|pptx|docx)$/i.test(name))
    .sort();
  const parsed: ParsedRef[] = [];
  const outcomes: IngestFileOutcome[] = [];
  for (const f of files) {
    const relPath = `refs/${f}`;
    try {
      const ref = await readRefFile(relPath);
      parsed.push(ref);
      const items = indexableCount(ref.pages);
      outcomes.push({ path: relPath, status: readStatus(items), items });
    } catch (e) {
      outcomes.push({ path: relPath, status: failureStatus(e), items: 0 });
    }
  }
  return { parsed, outcomes };
}

// ---------------- Sélection « référence » ----------------

export async function referencePaths(): Promise<string[]> {
  await ensureRefsSchema();
  return (await q.all<{ path: string }>(`SELECT path FROM exam_refs`)).map((r) => r.path);
}

export type ExamSource = {
  path: string;
  title: string;
  year: number | null;
  kind: string;
  items: number;
  uploaded: boolean;
  isReference: boolean;
};

/**
 * Une ligne par CHEMIN d'examen (une ré-ingestion peut dupliquer la source) :
 * la plus ancienne ligne fait foi. Portable sqlite/Postgres — un `GROUP BY path`
 * nu avec des colonnes non agrégées est accepté par sqlite et refusé par
 * Postgres (« must appear in the GROUP BY clause »).
 */
export const EXAM_SOURCE_DEDUP = `id IN (SELECT min(id) FROM sources WHERE type IN ('final','midterm') GROUP BY path)`;

/**
 * Une annale ne compte que si elle a du texte : un scan sans couche texte (0 passage) ne peut
 * pas servir de base au format, sinon il l'emportait sur les questions d'exemple et les
 * consignes avec un texte d'annales vide (audit ingestion du 16/11/2026).
 */
export const EXAM_HAS_TEXT = `EXISTS (SELECT 1 FROM items i WHERE i.source_id = sources.id)`;

/**
 * Nombre d'annales (finals, partiels) lisibles ingérées dans le cours courant ; 0 pour un cours
 * neuf. Un corrigé à côté de son énoncé ne compte pas comme une annale de plus.
 */
export async function pastExamCount(): Promise<number> {
  await q.ensureTable("sources");
  const rows = await q.all<{ path: string; title: string }>(`SELECT path, title FROM sources WHERE type IN ('final','midterm') AND ${EXAM_SOURCE_DEDUP} AND ${EXAM_HAS_TEXT}`);
  return withoutSolutions(rows, (r) => `${r.path} ${r.title}`).length;
}

/** Examens (finals/midterms) dédoublonnés par chemin, triés par année croissante (sans année en dernier). */
export async function listExamSourceRows(): Promise<{ path: string; title: string; year: number | null }[]> {
  return q.all<{ path: string; title: string; year: number | null }>(
    `SELECT path, title, year FROM sources WHERE type IN ('final','midterm') AND ${EXAM_SOURCE_DEDUP}
     ORDER BY (year IS NULL), year, title`,
  );
}

/** Tous les examens (finals/midterms) du corpus + flag « référence ». */
export async function listExamSources(): Promise<ExamSource[]> {
  await ensureRefsSchema();
  const refRows = await q.all<{ path: string; uploaded: number }>(`SELECT path, uploaded FROM exam_refs`);
  const refSet = new Set(refRows.map((r) => r.path));
  const uploadedSet = new Set(refRows.filter((r) => r.uploaded).map((r) => r.path));
  const rows = await q.all<Omit<ExamSource, "uploaded" | "isReference">>(
    `SELECT s.path, s.title, s.year, s.type kind,
            (SELECT count(*) FROM items i WHERE i.source_id = s.id) items
     FROM sources s WHERE s.type IN ('final','midterm') AND s.${EXAM_SOURCE_DEDUP}
     ORDER BY (s.year IS NULL), s.year DESC, s.title`
  );
  return rows.map((r) => ({
    ...r,
    uploaded: uploadedSet.has(r.path),
    isReference: refSet.has(r.path),
  }));
}

export type CorpusSource = {
  type: string;
  title: string;
  path: string;
  year: number | null;
  items: number;
  href: string | null; // deep-link « voir » (ouvre la source à sa 1re page/ancre)
};

/**
 * Toutes les sources du corpus (tous types) avec un deep-link « voir » — pour rendre les facettes
 * cliquables (filtrer + ouvrir un cours / une série / un exercice). Zéro lien mort : href dérivé de
 * l'ancre RÉELLE du 1er item (ou du chemin) via la logique unifiée sourceHref.
 */
export async function listCorpusSources(): Promise<CorpusSource[]> {
  const course = currentCourse();
  const rows = await q.all<{ type: string; title: string; path: string; year: number | null; items: number; anchor: string | null }>(
    `SELECT s.type, s.title, s.path, s.year,
            (SELECT count(*) FROM items i WHERE i.source_id = s.id) items,
            (SELECT i2.anchor FROM items i2 WHERE i2.source_id = s.id ORDER BY i2.id LIMIT 1) anchor
       FROM sources s
      WHERE s.id IN (SELECT min(id) FROM sources GROUP BY path)
      ORDER BY s.type, (s.year IS NULL), s.year DESC, s.title`
  );
  return rows.map((r) => ({
    type: r.type,
    title: r.title,
    path: r.path,
    year: r.year,
    items: r.items,
    href: sourceHref(course, r.path, r.anchor ?? r.path),
  }));
}

/** Compte le corpus par type (pour situer l'utilisateur). */
export async function corpusSummary(): Promise<{ type: string; sources: number; items: number }[]> {
  return q.all<{ type: string; sources: number; items: number }>(
    `SELECT s.type, count(DISTINCT s.id) sources, count(i.id) items
     FROM sources s LEFT JOIN items i ON i.source_id = s.id
     GROUP BY s.type ORDER BY items DESC`
  );
}

/** Coche/décoche un examen du corpus comme référence de format. */
export async function toggleReference(srcPath: string, on: boolean): Promise<void> {
  await ensureRefsSchema();
  if (on) {
    const s = await q.get<{ title: string; year: number | null; type: string }>(
      `SELECT title, year, type FROM sources WHERE path = ?`,
      srcPath
    );
    await q.run(
      `INSERT INTO exam_refs (path, title, year, kind, uploaded) VALUES (?,?,?,?,COALESCE((SELECT uploaded FROM exam_refs WHERE path=?),0))
       ON CONFLICT(path) DO UPDATE SET title = excluded.title, year = excluded.year, kind = excluded.kind, uploaded = excluded.uploaded`,
      srcPath, s?.title ?? srcPath, s?.year ?? null, s?.type ?? "final", srcPath
    );
  } else {
    await q.run(`DELETE FROM exam_refs WHERE path = ?`, srcPath);
  }
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+/, "").slice(0, 80) || "exam";
}

/** Enregistre un examen uploadé : fichier → data/refs/, indexation, marqué référence. */
export async function addUploadedRef(buffer: Buffer, filename: string): Promise<ExamSource> {
  const dir = REFS_DIR();
  const base = safeName(filename);
  let name = base;
  // Écriture exclusive : deux envois du même nom ne s'écrasent jamais.
  for (let n = 1; !(await storage().put(path.join(dir, name), buffer, { exclusive: true })); n++) {
    const ext = path.extname(base);
    name = `${path.basename(base, ext)}-${n}${ext}`;
  }

  const relPath = `refs/${name}`;
  await ingestRefFile(relPath);
  const { kind, year } = inferExamMeta(name);
  await q.run(
    `INSERT INTO exam_refs (path, title, year, kind, uploaded) VALUES (?,?,?,?,1)
     ON CONFLICT(path) DO UPDATE SET title = excluded.title, year = excluded.year, kind = excluded.kind, uploaded = excluded.uploaded`,
    relPath, name, year, kind
  );

  return (await listExamSources()).find((e) => e.path === relPath)!;
}

/**
 * Fichier du cours que l'ingestion n'a jamais lu (abîmé, chiffré : rapport d'ingestion) : son
 * chemin absolu, confiné au cours, ou null. Jamais dans un contenu en lecture seule (cs-202 lit
 * la racine du dépôt).
 */
function unreadFileAbsolute(srcPath: string): string | null {
  const course = currentCourse();
  if (getCourse(course).paths?.contentRel === "..") return null;
  // Les annales sont rangées à plat : « refs/x/final.pdf » ne désigne jamais « refs/final.pdf ».
  if (srcPath.startsWith("refs/")) return srcPath === `refs/${path.basename(srcPath)}` ? path.join(REFS_DIR(), path.basename(srcPath)) : null;
  const root = path.resolve(contentRoot());
  const abs = path.resolve(root, srcPath);
  return abs.startsWith(root + path.sep) ? abs : null;
}

/** Supprime un examen uploadé (fichier + source + sélection), ou un fichier que l'ingestion n'a pas pu lire. */
export async function removeUploadedRef(srcPath: string): Promise<void> {
  await ensureRefsSchema();
  const row = await q.get<{ uploaded: number }>(`SELECT uploaded FROM exam_refs WHERE path = ?`, srcPath);
  const srcs = await q.all<{ id: number }>(`SELECT id FROM sources WHERE path = ?`, srcPath);
  // Non lu : jamais ingéré (abîmé, chiffré) ou ingéré sans aucun passage (scan sans texte).
  const indexed = srcs.length
    ? Number((await q.get<{ n: number }>(`SELECT count(*) n FROM items WHERE source_id IN (${srcs.map(() => "?").join(",")})`, ...srcs.map((s) => s.id)))?.n ?? 0)
    : 0;
  // purge corpus
  for (const { id } of srcs) {
    await unindexSource(id);
    await q.run(`DELETE FROM items WHERE source_id = ?`, id);
    await q.run(`DELETE FROM sources WHERE id = ?`, id);
  }
  await q.run(`DELETE FROM exam_refs WHERE path = ?`, srcPath);
  if (row?.uploaded) {
    await storage().remove(path.join(REFS_DIR(), path.basename(srcPath)));
  } else if (!indexed) {
    // Il ne compte nulle part : sans suppression du fichier, il reviendrait à l'ingestion suivante.
    const abs = unreadFileAbsolute(srcPath);
    if (abs) await storage().remove(abs);
  }
  // Ses images de pages (lib/page-cache) : rendues de nouveau à la demande si le PDF reste.
  purgePdfPages(currentCourse(), path.basename(srcPath));
}
