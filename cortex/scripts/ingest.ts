/**
 * Ingestion : parse les sites HTML statiques + les PDF de cours,
 * remplit `sources` + `items` + l'index FTS `fts_items`.
 *
 * Idempotent : vide et reconstruit sources/items/fts à chaque run.
 * NE TOUCHE PAS aux données utilisateur (weaknesses, schedule, exams).
 *
 * Lancer : npm run ingest
 */
import * as cheerio from "cheerio";
import fs from "node:fs";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { ensureFts, sqlite } from "../db/client";
import { ingestAllRefs } from "../lib/sources";
import { tokenize } from "../lib/text";

const CONTENT_ROOT = path.resolve(process.cwd(), ".."); // dossier Compsys-claude

const clean = (s: string) =>
  s.replace(/\s+/g, " ").replace(/ /g, " ").trim();

// Poids de récence : le récent compte beaucoup plus.
function recencyWeight(year?: number, type?: string): number {
  if (year) {
    if (year >= 2025) return 3;
    if (year === 2024) return 2.5;
    if (year === 2023) return 2;
    if (year === 2022) return 1.6;
    if (year === 2021) return 1.3;
    return 1; // <= 2020
  }
  // notes du staff (attendus prof) = priorité haute ; cours/reviews élevé ; labs/code moyen
  if (type === "note") return 2;
  if (type === "course_pdf" || type === "review") return 1.8;
  if (type === "lab" || type === "code") return 1.4;
  return 1.2;
}

// --- accès DB bas niveau (rapide, contrôle total) ---
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

type ItemRec = {
  type: string;
  lectureId: string | null;
  title: string | null;
  text: string;
  html?: string | null;
  images?: string[];
  tags?: string[];
  anchor: string;
};

function addSource(
  type: string,
  title: string,
  relPath: string,
  year: number | null,
  items: ItemRec[]
): number {
  const sid = insSource.run(
    type,
    title,
    relPath,
    year,
    recencyWeight(year ?? undefined, type)
  ).lastInsertRowid as number;
  for (const it of items) {
    if (!it.text || it.text.length < 3) continue;
    const itemId = insItem.run({
      sourceId: sid,
      type: it.type,
      lectureId: it.lectureId,
      title: it.title,
      text: it.text,
      html: it.html ?? null,
      images: it.images ? JSON.stringify(it.images) : null,
      tags: it.tags ? JSON.stringify(it.tags) : null,
      anchor: it.anchor,
    }).lastInsertRowid as number;
    insFts.run(it.title ?? "", it.text, it.lectureId ?? "", String(itemId), String(sid));
  }
  return items.length;
}

const read = (rel: string) => fs.readFileSync(path.join(CONTENT_ROOT, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(CONTENT_ROOT, rel));

// ---------- 1. reviews.html : cartes flip (active recall) ----------
function ingestReviews(): number {
  if (!exists("reviews.html")) return 0;
  const $ = cheerio.load(read("reviews.html"));
  const items: ItemRec[] = [];
  $("section.chapter[id]").each((_, sec) => {
    const lectureId = $(sec).attr("id")!;
    if (lectureId === "home") return;
    $(sec)
      .find("details.exo")
      .each((_, ex) => {
        const tag = clean($(ex).find(".exo-tag").first().text());
        const title = clean($(ex).find(".exo-title").first().text());
        const body = clean($(ex).find(".exo-body").text());
        const text = clean(`${title} ${body}`);
        items.push({
          type: "card",
          lectureId,
          title: title || tag || lectureId,
          text,
          tags: tag ? [tag] : [],
          anchor: `reviews.html#${lectureId}`,
        });
      });
  });
  return addSource("review", "Reviews — lectures & labs", "reviews.html", null, items);
}

// ---------- 2. index.html : définitions / méthodes / théorèmes ----------
function ingestIndex(): number {
  if (!exists("index.html")) return 0;
  const $ = cheerio.load(read("index.html"));
  const items: ItemRec[] = [];
  $("section.chapter[id]").each((_, sec) => {
    const chap = $(sec).attr("id")!;
    $(sec)
      .find(".panel-tagged, details.method")
      .each((_, el) => {
        const tag = clean($(el).find(".tag, summary").first().text());
        const text = clean($(el).text());
        const anchorId = $(el).attr("id");
        items.push({
          type: $(el).is("details.method") ? "method" : "definition",
          lectureId: chap,
          title: tag || chap,
          text,
          anchor: `index.html#${anchorId || chap}`,
        });
      });
  });
  return addSource("review", "Index — cours réseau/OS", "index.html", null, items);
}

// ---------- 3. exercices/*.html : un exo par fichier ----------
function inferExo(file: string): { type: string; year: number | null } {
  const f = file.toLowerCase();
  let m;
  if ((m = f.match(/final(\d{4})/))) return { type: "final", year: +m[1] };
  if ((m = f.match(/midterm(\d{4})/))) return { type: "midterm", year: +m[1] };
  if ((m = f.match(/mi[-_]?term(\d{4})/))) return { type: "midterm", year: +m[1] };
  if (f.includes("serie")) return { type: "serie", year: null };
  return { type: "exercise", year: null };
}

function ingestExercices(): number {
  const dir = path.join(CONTENT_ROOT, "exercices");
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".html")) continue;
    const $ = cheerio.load(read(`exercices/${file}`));
    $("script, style").remove();
    const title =
      clean($("title").first().text()) ||
      clean($("h1, h2").first().text()) ||
      file;
    const text = clean($("body").text());
    const images: string[] = [];
    $("img[src]").each((_, img) => {
      const src = $(img).attr("src")!;
      if (!/^https?:/.test(src)) images.push(`exercices/${src.replace(/^\.?\//, "")}`);
    });
    const { type, year } = inferExo(file);
    total += addSource(type, title, `exercices/${file}`, year, [
      {
        type: "exercise",
        lectureId: null,
        title,
        text,
        images,
        anchor: `exercices/${file}`,
      },
    ]);
  }
  return total;
}

// ---------- 4. cheatsheets : une box par item ----------
function ingestCheatsheets(): number {
  const files = [
    ["c_cheatsheet.html", "Cheat sheet C"],
    ["cheatsheet_v5_preview.html", "Cheat sheet v5"],
    ["c_errors_journal.html", "Journal des erreurs C"],
  ] as const;
  let total = 0;
  for (const [file, label] of files) {
    if (!exists(file)) continue;
    const $ = cheerio.load(read(file));
    const items: ItemRec[] = [];
    const boxes = $(".box");
    if (boxes.length) {
      boxes.each((_, b) => {
        const title = clean($(b).find(".box-h, .fn-name").first().text());
        const text = clean($(b).text());
        items.push({ type: "cheat", lectureId: null, title: title || label, text, anchor: file });
      });
    } else {
      $("script, style").remove();
      items.push({ type: "cheat", lectureId: null, title: label, text: clean($("body").text()), anchor: file });
    }
    total += addSource("cheatsheet", label, file, null, items);
  }
  return total;
}

// ---------- helper : liste récursive de fichiers par extension ----------
function listFiles(relDir: string, exts: string[]): string[] {
  const base = path.join(CONTENT_ROOT, relDir);
  if (!fs.existsSync(base)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (exts.some((x) => e.name.toLowerCase().endsWith(x))) out.push(path.relative(CONTENT_ROOT, abs));
    }
  };
  walk(base);
  return out;
}

function htmlToText(rel: string): { title: string; text: string } {
  const $ = cheerio.load(read(rel));
  $("script, style").remove();
  const title = clean($("title").first().text()) || clean($("h1, h2").first().text()) || path.basename(rel);
  return { title, text: clean($("body").text()) };
}

function labId(rel: string): string | null {
  const m = rel.toLowerCase().match(/lab\s*0*(\d+)/);
  return m ? `lab${m[1]}` : null;
}

// ---------- 5. labs/ : énoncés (html/md/tex) + CODE C (.c/.h) ----------
function ingestLabs(): number {
  let total = 0;
  for (const rel of listFiles("labs", [".html", ".md", ".c", ".h", ".tex"])) {
    const isCode = /\.(c|h)$/.test(rel);
    let title: string, text: string;
    if (rel.endsWith(".html")) ({ title, text } = htmlToText(rel));
    else {
      title = path.basename(rel);
      text = read(rel); // .md/.c/.h/.tex : contenu brut (le code reste lisible/cherchable)
    }
    const type = isCode ? "code" : "lab";
    total += addSource(type, title, rel, null, [
      { type, lectureId: labId(rel), title, text, anchor: rel },
    ]);
  }
  return total;
}

// ---------- 6. notes/ : checklists, plan, attendus du staff ----------
function ingestNotes(): number {
  let total = 0;
  for (const rel of listFiles("notes", [".md"])) {
    total += addSource("note", path.basename(rel, ".md"), rel, null, [
      { type: "note", lectureId: null, title: path.basename(rel, ".md"), text: read(rel), anchor: rel },
    ]);
  }
  return total;
}

// ---------- 7. autres HTML à la racine (finals d'énoncé, packets, lab walk…) ----------
function ingestRootDocs(): number {
  const handled = new Set([
    "reviews.html", "index.html", "c_cheatsheet.html", "cheatsheet_v5_preview.html", "c_errors_journal.html",
  ]);
  let total = 0;
  for (const f of fs.readdirSync(CONTENT_ROOT)) {
    if (!f.endsWith(".html") || handled.has(f)) continue;
    const { title, text } = htmlToText(f);
    const ym = f.match(/(\d{4})/);
    const type = /final/i.test(f) ? "final" : /midterm|mi.?term/i.test(f) ? "midterm" : "doc";
    total += addSource(type, title, f, ym ? +ym[1] : null, [
      { type: "exercise", lectureId: labId(f), title, text, anchor: f },
    ]);
  }
  return total;
}

// ---------- 8. PDF du cours (les 2 PDF principaux) ----------
async function ingestPdfs(): Promise<number> {
  const pdfs = [
    ["cours/CS202_Lectures_Part1_Networks_L1-L10.pdf", "Cours — Part 1 Networks (L1-L10)"],
    ["cours/CS202_Lectures_Part2_OS_L11-L18.pdf", "Cours — Part 2 OS (L11-L18)"],
  ] as const;
  let total = 0;
  for (const [rel, title] of pdfs) {
    if (!exists(rel)) continue;
    const buf = fs.readFileSync(path.join(CONTENT_ROOT, rel));
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [text];
    const items: ItemRec[] = pages.map((pageText, i) => ({
      type: "course",
      lectureId: null,
      title: `${title} — p.${i + 1}`,
      text: clean(pageText),
      anchor: `${rel}#page=${i + 1}`,
    }));
    total += addSource("course_pdf", title, rel, null, items);
  }
  return total;
}

// ---------- Vocabulaire : termes distincts + fréquence documentaire ----------
function buildVocab(): number {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS vocab (term TEXT PRIMARY KEY, df INTEGER NOT NULL);
    DELETE FROM vocab;
  `);
  const df = new Map<string, number>();
  const rows = sqlite.prepare("SELECT text FROM items").all() as { text: string }[];
  for (const { text } of rows) {
    const seen = new Set<string>();
    for (const t of tokenize(text, 3)) {
      if (t.length > 24 || /^\d+$/.test(t)) continue; // pas les très longs / purs nombres
      seen.add(t);
    }
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const ins = sqlite.prepare("INSERT OR REPLACE INTO vocab (term, df) VALUES (?,?)");
  const tx = sqlite.transaction(() => {
    for (const [term, n] of df) ins.run(term, n);
  });
  tx();
  return df.size;
}

async function main() {
  ensureFts();
  console.log("Nettoyage des données dérivées (sources/items/fts)…");
  sqlite.exec("DELETE FROM items; DELETE FROM sources; DELETE FROM fts_items;");

  const tx = sqlite.transaction(() => {
    console.log("• reviews.html :", ingestReviews(), "cartes");
    console.log("• index.html   :", ingestIndex(), "définitions/méthodes");
    console.log("• exercices/   :", ingestExercices(), "exos");
    console.log("• cheatsheets  :", ingestCheatsheets(), "boxes");
    console.log("• labs/        :", ingestLabs(), "fichiers (énoncés + code C)");
    console.log("• notes/       :", ingestNotes(), "notes (dont attendus staff)");
    console.log("• docs racine  :", ingestRootDocs(), "HTML (finals/énoncés)");
  });
  tx();

  // PDF : hors transaction (async)
  console.log("• PDF cours    :", await ingestPdfs(), "pages");

  // Examens de référence uploadés (data/refs/) : hors transaction (async, parse PDF/HTML)
  console.log("• refs uploadés:", await ingestAllRefs(), "examen(s) de référence");

  // Vocabulaire (pour la recherche tolérante aux fautes)
  console.log("• vocabulaire  :", buildVocab(), "termes");

  const counts = sqlite.prepare("SELECT (SELECT count(*) FROM sources) s, (SELECT count(*) FROM items) i, (SELECT count(*) FROM fts_items) f").get() as any;
  console.log(`\n✓ Ingestion terminée : ${counts.s} sources, ${counts.i} items, ${counts.f} indexés (FTS).`);
}

main().catch((e) => {
  console.error("Échec ingestion :", e);
  process.exit(1);
});
