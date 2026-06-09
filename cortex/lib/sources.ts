import { ensureFts, sqlite } from "@/db/client";
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

export const REFS_DIR = path.join(process.cwd(), "data", "refs");

export function ensureRefsSchema() {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS exam_refs (
    path TEXT PRIMARY KEY,
    title TEXT,
    year INTEGER,
    kind TEXT,
    uploaded INTEGER NOT NULL DEFAULT 0,
    added_at TEXT DEFAULT (datetime('now'))
  );`);
}
ensureRefsSchema();

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

// ---- insertion bas niveau (mêmes tables que l'ingestion) ----
const insSource = sqlite.prepare(
  `INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`
);
const insItem = sqlite.prepare(
  `INSERT INTO items (source_id, type, lecture_id, title, text, html, images, tags, anchor)
   VALUES (@sourceId,@type,@lectureId,@title,@text,@html,@images,@tags,@anchor)`
);
const insFts = sqlite.prepare(
  `INSERT INTO fts_items (title, text, lecture_id, item_id, source_id) VALUES (?,?,?,?,?)`
);

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
  const filePath = path.join(REFS_DIR, path.basename(relPath));
  const { kind, year } = inferExamMeta(path.basename(relPath));
  const { title, pages } = await parseRefFile(filePath);

  // purge d'une éventuelle ingestion précédente du même chemin
  const old = sqlite.prepare(`SELECT id FROM sources WHERE path = ?`).all(relPath) as { id: number }[];
  for (const { id } of old) {
    sqlite.prepare(`DELETE FROM fts_items WHERE source_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM items WHERE source_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM sources WHERE id = ?`).run(id);
  }

  const sid = insSource.run(kind, title, relPath, year, recencyWeight(year)).lastInsertRowid as number;
  const chunks = pages.length ? pages : [""];
  chunks.forEach((text, i) => {
    if (text.length < 3) return;
    const label = chunks.length > 1 ? `${title} — p.${i + 1}` : title;
    const anchor = chunks.length > 1 ? `${relPath}#page=${i + 1}` : relPath;
    const itemId = insItem.run({
      sourceId: sid, type: "exercise", lectureId: null, title: label,
      text, html: null, images: null, tags: null, anchor,
    }).lastInsertRowid as number;
    insFts.run(label, text, "", String(itemId), String(sid));
  });

  // Tout fichier de data/refs/ EST un examen de référence (la sélection survit au ré-ingest).
  ensureRefsSchema();
  const wasUploaded = (sqlite.prepare(`SELECT uploaded FROM exam_refs WHERE path = ?`).get(relPath) as { uploaded: number } | undefined)?.uploaded ?? 1;
  sqlite
    .prepare(`INSERT OR REPLACE INTO exam_refs (path, title, year, kind, uploaded) VALUES (?,?,?,?,?)`)
    .run(relPath, title, year, kind, wasUploaded);
  return sid;
}

/** Réingère tous les fichiers de data/refs/ (appelé par scripts/ingest.ts). */
export async function ingestAllRefs(): Promise<number> {
  if (!fs.existsSync(REFS_DIR)) return 0;
  // uniquement des FICHIERS d'examen (ignore les sous-dossiers figref/ img/ et les fichiers cachés)
  const files = fs
    .readdirSync(REFS_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith(".") && /\.(pdf|html?|txt|md)$/i.test(e.name))
    .map((e) => e.name);
  for (const f of files) await ingestRefFile(`refs/${f}`);
  return files.length;
}

// ---------------- Sélection « référence » ----------------

export function referencePaths(): string[] {
  ensureRefsSchema();
  return (sqlite.prepare(`SELECT path FROM exam_refs`).all() as { path: string }[]).map((r) => r.path);
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
export function listExamSources(): ExamSource[] {
  ensureRefsSchema();
  const refRows = sqlite.prepare(`SELECT path, uploaded FROM exam_refs`).all() as { path: string; uploaded: number }[];
  const refSet = new Set(refRows.map((r) => r.path));
  const uploadedSet = new Set(refRows.filter((r) => r.uploaded).map((r) => r.path));
  const rows = sqlite
    .prepare(
      `SELECT s.path, s.title, s.year, s.type kind,
              (SELECT count(*) FROM items i WHERE i.source_id = s.id) items
       FROM sources s WHERE s.type IN ('final','midterm')
       GROUP BY s.path
       ORDER BY (s.year IS NULL), s.year DESC, s.title`
    )
    .all() as Omit<ExamSource, "uploaded" | "isReference">[];
  return rows.map((r) => ({
    ...r,
    uploaded: uploadedSet.has(r.path),
    isReference: refSet.has(r.path),
  }));
}

/** Compte le corpus par type (pour situer l'utilisateur). */
export function corpusSummary(): { type: string; sources: number; items: number }[] {
  return sqlite
    .prepare(
      `SELECT s.type, count(DISTINCT s.id) sources, count(i.id) items
       FROM sources s LEFT JOIN items i ON i.source_id = s.id
       GROUP BY s.type ORDER BY items DESC`
    )
    .all() as any[];
}

/** Coche/décoche un examen du corpus comme référence de format. */
export function toggleReference(srcPath: string, on: boolean) {
  ensureRefsSchema();
  if (on) {
    const s = sqlite.prepare(`SELECT title, year, type FROM sources WHERE path = ?`).get(srcPath) as
      | { title: string; year: number | null; type: string }
      | undefined;
    sqlite
      .prepare(`INSERT OR REPLACE INTO exam_refs (path, title, year, kind, uploaded) VALUES (?,?,?,?,COALESCE((SELECT uploaded FROM exam_refs WHERE path=?),0))`)
      .run(srcPath, s?.title ?? srcPath, s?.year ?? null, s?.type ?? "final", srcPath);
  } else {
    sqlite.prepare(`DELETE FROM exam_refs WHERE path = ?`).run(srcPath);
  }
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+/, "").slice(0, 80) || "exam";
}

/** Enregistre un examen uploadé : fichier → data/refs/, indexation, marqué référence. */
export async function addUploadedRef(buffer: Buffer, filename: string): Promise<ExamSource> {
  fs.mkdirSync(REFS_DIR, { recursive: true });
  let name = safeName(filename);
  let abs = path.join(REFS_DIR, name);
  let n = 1;
  while (fs.existsSync(abs)) {
    const ext = path.extname(name);
    name = `${path.basename(name, ext)}-${n++}${ext}`;
    abs = path.join(REFS_DIR, name);
  }
  fs.writeFileSync(abs, buffer);

  const relPath = `refs/${name}`;
  await ingestRefFile(relPath);
  const { kind, year } = inferExamMeta(name);
  sqlite
    .prepare(`INSERT OR REPLACE INTO exam_refs (path, title, year, kind, uploaded) VALUES (?,?,?,?,1)`)
    .run(relPath, name, year, kind);

  return listExamSources().find((e) => e.path === relPath)!;
}

/** Supprime un examen uploadé (fichier + source + sélection). */
export function removeUploadedRef(srcPath: string) {
  ensureRefsSchema();
  const row = sqlite.prepare(`SELECT uploaded FROM exam_refs WHERE path = ?`).get(srcPath) as
    | { uploaded: number }
    | undefined;
  // purge corpus
  const srcs = sqlite.prepare(`SELECT id FROM sources WHERE path = ?`).all(srcPath) as { id: number }[];
  for (const { id } of srcs) {
    sqlite.prepare(`DELETE FROM fts_items WHERE source_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM items WHERE source_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM sources WHERE id = ?`).run(id);
  }
  sqlite.prepare(`DELETE FROM exam_refs WHERE path = ?`).run(srcPath);
  if (row?.uploaded) {
    const abs = path.join(REFS_DIR, path.basename(srcPath));
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  }
}
