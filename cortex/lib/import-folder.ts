import { currentCourse } from "@/db/client";
import { coursePaths, DEFAULT_COURSE } from "@/lib/courses";
import fs from "node:fs";
import path from "node:path";

/**
 * Import d'un DOSSIER entier dans un cours.
 * Parcourt récursivement un dossier local, CLASSE chaque fichier (final/midterm/serie/cours/
 * site/note/image), et le copie au bon endroit du cours :
 *   - finals/midterms → data/<course>/refs/   (auto-marqués examens de référence à l'ingest)
 *   - le reste        → data/<course>/content/<bucket>/
 * Puis `scripts/ingest.ts` indexe l'ensemble. Additif et PAR COURS.
 *
 * ⚠️ INTERDIT pour cs-202 : son « contenu » = les sites de révision en LECTURE SEULE à la racine
 * du repo. On n'y importe jamais rien. L'import est réservé aux cours additionnels (algo, ml, …).
 */

export type ImportedFile = { src: string; rel: string; bucket: string; type: string; year: number | null };
export type ImportManifest = {
  course: string;
  total: number;
  byBucket: Record<string, number>;
  refs: { name: string; year: number | null; kind: string }[];
  recentRefs: { name: string; year: number | null }[];
  files: ImportedFile[];
  skipped: number;
};

const EXTS = new Set([".pdf", ".html", ".htm", ".md", ".txt", ".tex", ".c", ".h", ".png", ".jpg", ".jpeg", ".webp", ".pptx"]);
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "data", "__pycache__", ".obsidian", ".vscode"]);

/** Classe un fichier : bucket de destination + type d'ingestion + année éventuelle. */
export function classifyFile(rel: string): { bucket: "refs" | "lectures" | "series" | "notes" | "sites" | "images" | "misc"; type: string; year: number | null } {
  // underscore est un word-char → casse les \b ("final_2025" raté). On le traite comme séparateur.
  const f = rel.toLowerCase().replace(/_/g, "-");
  const ext = path.extname(f);
  const yearMatch = f.match(/(20\d{2})/);
  const year = yearMatch ? +yearMatch[1] : null;
  const isExam = /\b(final|midterm|mid-?term|exam|partiel)\b/.test(f);
  if (isExam && (year || /\bexam\b/.test(f))) {
    const kind = /midterm|mid-?term|partiel/.test(f) ? "midterm" : "final";
    return { bucket: "refs", type: kind, year };
  }
  if (/\.(png|jpe?g|webp)$/.test(f)) return { bucket: "images", type: "image", year };
  if (/\/notes?\/|study.?guide|hints|scope|conventions?|checklist|\bplan\b|syllabus|formula|cheat/.test(f)) return { bucket: "notes", type: "note", year: null };
  if (/s[ée]rie|exercise|\bexo\b|tutorial|homework|pset|problem.?set|\btd\b|\btp\b|solution|corrig/.test(f)) return { bucket: "series", type: "serie", year: null };
  if (/lecture|cours|slides?|chapter|chapitre|\bweek\b|\bcm\b|handout/.test(f) || ext === ".pptx") return { bucket: "lectures", type: "course_pdf", year: null };
  if (ext === ".html" || ext === ".htm") return { bucket: "sites", type: "site", year: null };
  if (ext === ".md" || ext === ".txt") return { bucket: "notes", type: "note", year: null };
  return { bucket: "misc", type: "exercise", year: null };
}

function walk(dir: string, base: string, out: string[]) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(abs, base, out);
    } else if (EXTS.has(path.extname(e.name).toLowerCase())) {
      out.push(abs);
    }
  }
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+/, "").slice(0, 100) || "file";
}

function uniqueDest(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  let dest = path.join(dir, name);
  let n = 1;
  while (fs.existsSync(dest)) {
    const ext = path.extname(name);
    dest = path.join(dir, `${path.basename(name, ext)}-${n++}${ext}`);
  }
  return dest;
}

/**
 * Copie+classe tous les fichiers d'un dossier dans le cours COURANT. Ne lance PAS l'ingestion
 * (le script s'en charge ensuite). Retourne un manifeste de ce qui a été importé.
 */
export function importFolder(srcDir: string): ImportManifest {
  const course = currentCourse();
  if (course === DEFAULT_COURSE) {
    throw new Error("Import de dossier réservé aux cours additionnels (algo, ml, …). CS-202 utilise les sites de révision en lecture seule à la racine du repo.");
  }
  const abs = path.resolve(srcDir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`Dossier introuvable : ${abs}`);
  }
  const cp = coursePaths(course);
  const files: string[] = [];
  walk(abs, abs, files);

  const manifest: ImportManifest = { course, total: 0, byBucket: {}, refs: [], recentRefs: [], files: [], skipped: 0 };
  for (const srcFile of files) {
    const rel = path.relative(abs, srcFile);
    const { bucket, type, year } = classifyFile(rel);
    const name = safeName(path.basename(srcFile));
    try {
      let destDir: string;
      if (bucket === "refs") destDir = cp.refsDir;
      else destDir = path.join(cp.contentRoot, bucket);
      const dest = uniqueDest(destDir, name);
      fs.copyFileSync(srcFile, dest);
      manifest.total++;
      manifest.byBucket[bucket] = (manifest.byBucket[bucket] ?? 0) + 1;
      manifest.files.push({ src: srcFile, rel: path.relative(cp.contentRoot, dest), bucket, type, year });
      if (bucket === "refs") manifest.refs.push({ name: path.basename(dest), year, kind: type });
    } catch {
      manifest.skipped++;
    }
  }
  // 2-3 examens de référence les plus récents (étalon de format/difficulté)
  manifest.recentRefs = [...manifest.refs]
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
    .slice(0, 3)
    .map((r) => ({ name: r.name, year: r.year }));
  return manifest;
}
