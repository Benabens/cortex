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
import { currentCourse, enterCourse, ensureFts } from "../db/client";
import { q } from "../db/q";
import { coursePaths, DEFAULT_COURSE } from "../lib/courses";
import { importFolder } from "../lib/import-folder";
import { ingestAllRefs } from "../lib/sources";
import { tokenize } from "../lib/text";

// Args : `npm run ingest -- --course=algo --from "<dossier>"` (défaut cs-202, pas d'import).
function argVal(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=").slice(1).join("=");
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  return undefined;
}
const courseArg = argVal("course");
const fromDir = argVal("from");
if (courseArg) process.env.CORTEX_COURSE = courseArg;
enterCourse(courseArg);
const COURSE = currentCourse();
const CONTENT_ROOT = coursePaths(COURSE).contentRoot; // cs-202 → racine du repo ; autres → data/<id>/content
// La table FTS doit exister AVANT toute insertion dans fts_items (DB neuve d'un
// nouveau cours : le schéma de base ne crée pas fts_items). No-op pour cs-202 (déjà présente).
ensureFts();

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

// --- accès DB via la façade q (les statements sont mis en cache par le driver) ---
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

async function addSource(
  type: string,
  title: string,
  relPath: string,
  year: number | null,
  items: ItemRec[]
): Promise<number> {
  const sid = await q.insert(
    `INSERT INTO sources (type, title, path, year, recency_weight) VALUES (?,?,?,?,?)`,
    type,
    title,
    relPath,
    year,
    recencyWeight(year ?? undefined, type)
  );
  for (const it of items) {
    if (!it.text || it.text.length < 3) continue;
    const itemId = await q.insert(
      `INSERT INTO items (source_id, type, lecture_id, title, text, html, images, tags, anchor)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      sid,
      it.type,
      it.lectureId,
      it.title,
      it.text,
      it.html ?? null,
      it.images ? JSON.stringify(it.images) : null,
      it.tags ? JSON.stringify(it.tags) : null,
      it.anchor
    );
    await q.run(
      `INSERT INTO fts_items (title, text, lecture_id, item_id, source_id) VALUES (?,?,?,?,?)`,
      it.title ?? "", it.text, it.lectureId ?? "", String(itemId), String(sid)
    );
  }
  return items.length;
}

const read = (rel: string) => fs.readFileSync(path.join(CONTENT_ROOT, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(CONTENT_ROOT, rel));

// ---------- 1. reviews.html : cartes flip (active recall) ----------
async function ingestReviews(): Promise<number> {
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
  return await addSource("review", "Reviews — lectures & labs", "reviews.html", null, items);
}

// ---------- 2. index.html : définitions / méthodes / théorèmes ----------
async function ingestIndex(): Promise<number> {
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
  return await addSource("review", "Index — cours réseau/OS", "index.html", null, items);
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

async function ingestExercices(): Promise<number> {
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
    total += await addSource(type, title, `exercices/${file}`, year, [
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
async function ingestCheatsheets(): Promise<number> {
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
    total += await addSource("cheatsheet", label, file, null, items);
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
async function ingestLabs(): Promise<number> {
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
    total += await addSource(type, title, rel, null, [
      { type, lectureId: labId(rel), title, text, anchor: rel },
    ]);
  }
  return total;
}

// ---------- 5b. data/cs-202/labs/ : le VRAI code des labs 2026 déposé par Ben (NS13) ----------
// Repo « grilledcheese » (provided/ + done/ = solutions de Ben) + dossiers lab1_entrainement,
// lab5, lab5_upload. Indexé par lab → le générateur d'exos Labs connaît chaque lab ligne par ligne.
const DEPOSITED_LABS_REL = path.join("data", "cs-202", "labs"); // relatif au cwd (cortex/), PAS à CONTENT_ROOT

/** lab id d'un fichier déposé : motif labN n'importe où, sinon warmup grilledcheese → lab1. */
function depositedLabId(rel: string): string | null {
  const direct = labId(rel);
  if (direct) return direct;
  // le repo grilledcheese est le warmup (Lab 1) : ex_single / ex_multiple / bigprj / README
  if (/grilledcheese\/(README|provided\/(ex_single|ex_multiple|bigprj|ex\d))/i.test(rel)) return "lab1";
  return null;
}

async function ingestDepositedLabs(): Promise<number> {
  const base = path.join(process.cwd(), DEPOSITED_LABS_REL);
  if (!fs.existsSync(base)) return 0;
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if ([".c", ".h", ".md", ".html", ".tex"].some((x) => e.name.toLowerCase().endsWith(x)))
        files.push(path.relative(base, abs));
    }
  };
  walk(base);
  let total = 0;
  for (const rel of files) {
    const isCode = /\.(c|h)$/.test(rel);
    const lab = depositedLabId(rel);
    let title: string, text: string;
    if (rel.endsWith(".html")) {
      const $ = cheerio.load(fs.readFileSync(path.join(base, rel), "utf8"));
      $("script, style").remove();
      title = clean($("title").first().text()) || clean($("h1, h2").first().text()) || path.basename(rel);
      text = clean($("body").text());
    } else {
      title = `${lab ? lab + " — " : ""}${path.basename(rel)}`;
      text = fs.readFileSync(path.join(base, rel), "utf8");
    }
    const type = isCode ? "code" : "lab";
    total += await addSource(type, title, path.join(DEPOSITED_LABS_REL, rel), null, [
      { type, lectureId: lab, title, text, anchor: path.join(DEPOSITED_LABS_REL, rel) },
    ]);
  }
  return total;
}

// ---------- 6. notes/ : checklists, plan, attendus du staff ----------
async function ingestNotes(): Promise<number> {
  let total = 0;
  for (const rel of listFiles("notes", [".md"])) {
    total += await addSource("note", path.basename(rel, ".md"), rel, null, [
      { type: "note", lectureId: null, title: path.basename(rel, ".md"), text: read(rel), anchor: rel },
    ]);
  }
  return total;
}

// ---------- 7. autres HTML à la racine (finals d'énoncé, packets, lab walk…) ----------
async function ingestRootDocs(): Promise<number> {
  const handled = new Set([
    "reviews.html", "index.html", "c_cheatsheet.html", "cheatsheet_v5_preview.html", "c_errors_journal.html",
  ]);
  let total = 0;
  for (const f of fs.readdirSync(CONTENT_ROOT)) {
    if (!f.endsWith(".html") || handled.has(f)) continue;
    const { title, text } = htmlToText(f);
    const ym = f.match(/(\d{4})/);
    const type = /final/i.test(f) ? "final" : /midterm|mi.?term/i.test(f) ? "midterm" : "doc";
    total += await addSource(type, title, f, ym ? +ym[1] : null, [
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
    total += await addSource("course_pdf", title, rel, null, items);
  }
  return total;
}

// ---------- Vocabulaire : termes distincts + fréquence documentaire ----------
async function buildVocab(): Promise<number> {
  await q.ensureTable("vocab");
  await q.run("DELETE FROM vocab");
  const df = new Map<string, number>();
  const rows = await q.all<{ text: string }>("SELECT text FROM items");
  for (const { text } of rows) {
    const seen = new Set<string>();
    for (const t of tokenize(text, 3)) {
      if (t.length > 24 || /^\d+$/.test(t)) continue; // pas les très longs / purs nombres
      seen.add(t);
    }
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  await q.tx(async () => {
    for (const [term, n] of df)
      await q.run("INSERT INTO vocab (term, df) VALUES (?,?) ON CONFLICT(term) DO UPDATE SET df = excluded.df", term, n);
  });
  return df.size;
}

// ---------- Ingestion GÉNÉRIQUE (cours ≠ cs-202) : tout le contenu de data/<id>/content ----------
function inferGenericType(rel: string): { type: string; year: number | null } {
  const f = rel.toLowerCase();
  let m;
  if ((m = f.match(/final.*?(\d{4})|(\d{4}).*?final/))) return { type: "final", year: +(m[1] || m[2]) };
  if ((m = f.match(/midterm.*?(\d{4})|(\d{4}).*?midterm/))) return { type: "midterm", year: +(m[1] || m[2]) };
  if (/\/notes?\/|study.?guide|hints|scope|checklist|\bplan\b/.test(f)) return { type: "note", year: null };
  if (/s[ée]rie|exercise|\bexo\b|tutorial|homework|pset|problem.?set|\/series?\//.test(f)) return { type: "serie", year: null };
  if (/cheat|formula|recap|summary/.test(f)) return { type: "cheatsheet", year: null };
  if (/lecture|cours|slides|chapter/.test(f)) return { type: "course_pdf", year: null };
  if (/\.(md|txt)$/.test(f)) return { type: "note", year: null };
  return { type: "exercise", year: null };
}

async function ingestGenericContent(): Promise<void> {
  if (!fs.existsSync(CONTENT_ROOT)) {
    console.log(`⚠ Dossier de contenu absent : ${CONTENT_ROOT}. Dépose le matériel du cours là (sites/séries/notes/cours) puis relance.`);
    return;
  }
  let nSources = 0;
  const files = listFiles(".", [".html", ".htm", ".md", ".txt", ".tex", ".c", ".h", ".pdf"]);
  for (const rel of files) {
    const { type, year } = inferGenericType(rel);
    try {
      if (rel.toLowerCase().endsWith(".pdf")) {
        const buf = fs.readFileSync(path.join(CONTENT_ROOT, rel));
        const pdf = await getDocumentProxy(new Uint8Array(buf));
        const { text } = await extractText(pdf, { mergePages: false });
        const pages = (Array.isArray(text) ? text : [text]).map(clean).filter((t) => t.length > 3);
        const title = path.basename(rel, ".pdf");
        await addSource(type, title, rel, year, pages.map((t, i) => ({ type, lectureId: null, title: `${title} — p.${i + 1}`, text: t, anchor: `${rel}#page=${i + 1}` })));
      } else if (/\.html?$/.test(rel)) {
        const { title, text } = htmlToText(rel);
        await addSource(type, title, rel, year, [{ type, lectureId: null, title, text, anchor: rel }]);
      } else {
        const title = path.basename(rel);
        await addSource(type, title, rel, year, [{ type, lectureId: null, title, text: read(rel), anchor: rel }]);
      }
      nSources++;
    } catch (e) {
      console.log(`  ⚠ ${rel} ignoré : ${(e as Error).message}`);
    }
  }
  console.log(`• contenu      : ${nSources} fichier(s) indexé(s) depuis ${CONTENT_ROOT}`);
}

async function main() {
  ensureFts();
  console.log(`Cours : ${COURSE}`);

  // --from <dossier> : importe+classe un dossier entier dans le cours AVANT d'ingérer (Phase 1).
  if (fromDir) {
    console.log(`\n📂 Import du dossier : ${fromDir}`);
    const m = importFolder(fromDir);
    console.log(`  ${m.total} fichier(s) importé(s) (${m.skipped} ignoré(s))`);
    for (const [b, n] of Object.entries(m.byBucket)) console.log(`    - ${b} : ${n}`);
    if (m.recentRefs.length) console.log(`  examens de référence récents : ${m.recentRefs.map((r) => r.name + (r.year ? ` (${r.year})` : "")).join(", ")}`);
  }

  console.log("Nettoyage des données dérivées (sources/items/fts)…");
  await q.exec("DELETE FROM items; DELETE FROM sources; DELETE FROM fts_items;");

  if (COURSE === DEFAULT_COURSE) {
    // ---- cs-202 : flux historique INCHANGÉ ----
    await q.tx(async () => {
      console.log("• reviews.html :", await ingestReviews(), "cartes");
      console.log("• index.html   :", await ingestIndex(), "définitions/méthodes");
      console.log("• exercices/   :", await ingestExercices(), "exos");
      console.log("• cheatsheets  :", await ingestCheatsheets(), "boxes");
      console.log("• labs/        :", await ingestLabs(), "fichiers (énoncés + code C)");
      console.log("• labs déposés :", await ingestDepositedLabs(), "fichiers (code réel 2026 : grilledcheese + lab1/2/4/5)");
      console.log("• notes/       :", await ingestNotes(), "notes (dont attendus staff)");
      console.log("• docs racine  :", await ingestRootDocs(), "HTML (finals/énoncés)");
    });
    console.log("• PDF cours    :", await ingestPdfs(), "pages");
  } else {
    // ---- autres cours : ingestion générique du dossier de contenu ----
    await ingestGenericContent();
  }

  // Examens de référence (data/<course>/refs/) : pour TOUS les cours.
  console.log("• refs         :", await ingestAllRefs(), "examen(s) de référence");

  // Ancrage VISION (Phase 2) : rend les pages des examens de réf PDF en images-étalon (cours ≠ cs-202).
  if (COURSE !== DEFAULT_COURSE) {
    const { renderCourseRefImages } = await import("../lib/course-vision");
    const imgs = renderCourseRefImages(COURSE);
    if (imgs) console.log(`• vision       : ${imgs} image(s)-étalon rendue(s) depuis les examens de référence`);
  }

  // Vocabulaire (pour la recherche tolérante aux fautes)
  console.log("• vocabulaire  :", await buildVocab(), "termes");

  const counts = await q.get<any>("SELECT (SELECT count(*) FROM sources) s, (SELECT count(*) FROM items) i, (SELECT count(*) FROM fts_items) f");
  console.log(`\n✓ Ingestion terminée : ${counts.s} sources, ${counts.i} items, ${counts.f} indexés (FTS).`);

  // Récap « ce qui a été compris » (la matière, les examens de réf, les conventions).
  const byType = await q.all<{ type: string; n: number }>("SELECT type, count(*) n FROM sources GROUP BY type ORDER BY n DESC");
  const refs = (await q.get<{ n: number }>("SELECT count(*) n FROM exam_refs"))!;
  const notes = (await q.get<{ n: number }>("SELECT count(*) n FROM sources WHERE type='note'"))!;
  const recent = await q.all<{ title: string; year: number }>("SELECT title, year FROM sources WHERE type IN ('final','midterm') AND year IS NOT NULL ORDER BY year DESC LIMIT 3");
  console.log(`\n📊 Compris pour « ${COURSE} » :`);
  console.log(`   types : ${byType.map((t) => `${t.type}×${t.n}`).join(", ")}`);
  console.log(`   examens de référence (format) : ${refs.n}${recent.length ? " — récents : " + recent.map((r) => `${r.title} (${r.year})`).join(", ") : ""}`);
  console.log(`   conventions/attendus (notes)  : ${notes.n}`);
}

main().catch((e) => {
  console.error("Échec ingestion :", e);
  process.exit(1);
});
