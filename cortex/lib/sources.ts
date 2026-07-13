import { ensureFts } from "@/db/client";
import { q } from "@/db/q";
import { indexItemForSearch, unindexSource } from "@/lib/search";
import { refsDir } from "@/lib/paths";
import * as cheerio from "cheerio";
import fs from "node:fs";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";

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
  const f = filename.toLowerCase();
  const kind = /midterm|mi[-_ ]?term/.test(f) ? "midterm" : "final";
  const m = f.match(/(20\d{2})/);
  return { kind, year: m ? +m[1] : null };
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
  if (ext === ".pdf") {
    const buf = fs.readFileSync(abs);
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = (Array.isArray(text) ? text : [text]).map(clean).filter((t) => t.length > 3);
    return { title: base.replace(/\.pdf$/i, ""), pages };
  }
  if (ext === ".html" || ext === ".htm") {
    const $ = cheerio.load(fs.readFileSync(abs, "utf8"));
    $("script, style").remove();
    const title = clean($("title").first().text()) || clean($("h1, h2").first().text()) || base;
    return { title, pages: [clean($("body").text())] };
  }
  // .txt / .md / autres : texte brut
  return { title: base.replace(/\.[^.]+$/, ""), pages: [clean(fs.readFileSync(abs, "utf8"))] };
}

/**
 * Ingestion d'UN fichier de référence (data/refs/<file>) dans sources/items/fts.
 * Idempotent par chemin : purge l'ancienne source de même path avant de réinsérer.
 * Réutilisé par l'upload (immédiat) ET par scripts/ingest.ts (après wipe).
 */
export async function ingestRefFile(relPath: string): Promise<number> {
  ensureFts();
  const filePath = path.join(REFS_DIR(), path.basename(relPath));
  const { kind, year } = inferExamMeta(path.basename(relPath));
  const { title, pages } = await parseRefFile(filePath);

  // purge d'une éventuelle ingestion précédente du même chemin
  const old = await q.all<{ id: number }>(`SELECT id FROM sources WHERE path = ?`, relPath);
  for (const { id } of old) {
    await unindexSource(id);
    await q.run(`DELETE FROM items WHERE source_id = ?`, id);
    await q.run(`DELETE FROM sources WHERE id = ?`, id);
  }

  const sid = await q.insert(INS_SOURCE_SQL, kind, title, relPath, year, recencyWeight(year));
  const chunks = pages.length ? pages : [""];
  for (const [i, text] of chunks.entries()) {
    if (text.length < 3) continue;
    const label = chunks.length > 1 ? `${title} — p.${i + 1}` : title;
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
  return sid;
}

/** Réingère tous les fichiers de data/refs/ (appelé par scripts/ingest.ts). */
export async function ingestAllRefs(): Promise<number> {
  const dir = REFS_DIR();
  if (!fs.existsSync(dir)) return 0;
  // uniquement des FICHIERS d'examen (ignore les sous-dossiers figref/ img/ et les fichiers cachés)
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith(".") && /\.(pdf|html?|txt|md)$/i.test(e.name))
    .map((e) => e.name);
  for (const f of files) await ingestRefFile(`refs/${f}`);
  return files.length;
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

/** Tous les examens (finals/midterms) du corpus + flag « référence ». */
export async function listExamSources(): Promise<ExamSource[]> {
  await ensureRefsSchema();
  const refRows = await q.all<{ path: string; uploaded: number }>(`SELECT path, uploaded FROM exam_refs`);
  const refSet = new Set(refRows.map((r) => r.path));
  const uploadedSet = new Set(refRows.filter((r) => r.uploaded).map((r) => r.path));
  const rows = await q.all<Omit<ExamSource, "uploaded" | "isReference">>(
    `SELECT s.path, s.title, s.year, s.type kind,
            (SELECT count(*) FROM items i WHERE i.source_id = s.id) items
     FROM sources s WHERE s.type IN ('final','midterm')
     GROUP BY s.path
     ORDER BY (s.year IS NULL), s.year DESC, s.title`
  );
  return rows.map((r) => ({
    ...r,
    uploaded: uploadedSet.has(r.path),
    isReference: refSet.has(r.path),
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
  fs.mkdirSync(dir, { recursive: true });
  let name = safeName(filename);
  let abs = path.join(dir, name);
  let n = 1;
  while (fs.existsSync(abs)) {
    const ext = path.extname(name);
    name = `${path.basename(name, ext)}-${n++}${ext}`;
    abs = path.join(dir, name);
  }
  fs.writeFileSync(abs, buffer);

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

/** Supprime un examen uploadé (fichier + source + sélection). */
export async function removeUploadedRef(srcPath: string): Promise<void> {
  await ensureRefsSchema();
  const row = await q.get<{ uploaded: number }>(`SELECT uploaded FROM exam_refs WHERE path = ?`, srcPath);
  // purge corpus
  const srcs = await q.all<{ id: number }>(`SELECT id FROM sources WHERE path = ?`, srcPath);
  for (const { id } of srcs) {
    await unindexSource(id);
    await q.run(`DELETE FROM items WHERE source_id = ?`, id);
    await q.run(`DELETE FROM sources WHERE id = ?`, id);
  }
  await q.run(`DELETE FROM exam_refs WHERE path = ?`, srcPath);
  if (row?.uploaded) {
    const abs = path.join(REFS_DIR(), path.basename(srcPath));
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  }
}
