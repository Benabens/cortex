import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ingestTimeoutMs } from "@/lib/ingest-limits";
import { findBinary, findPdftoppm } from "@/lib/pdftoppm";

/**
 * OCR DES PDF SCANNÉS (audit ingestion du 16/11/2026, P1-4 ; décision du 21/11) : une page sans
 * couche texte est rendue en image par pdftoppm (300 dpi) et lue par tesseract, en local, sans
 * aucun appel au modèle. Ne tourne que dans le processus d'ingestion (job), jamais dans une
 * requête HTTP : une page de bruit prend 20 s à tesseract.
 *
 * Bornes, parce que le PDF vient de l'utilisateur et que l'app et le worker partagent un seul
 * conteneur : pages lues par fichier, temps par fichier et par ingestion, côté long de l'image,
 * un seul fil pour tesseract. Mesuré le 21/11 (300 dpi, un fil) : une page de texte ≈ 1 s et
 * 70 Mo, une image sans texte jusqu'à 20 s et 350 Mo.
 *
 * Activé par configuration (CORTEX_OCR=1, posé dans l'image Docker qui embarque tesseract) :
 * sans lui, ou sans tesseract, rien ne change, le scan reste signalé « sans texte » par le
 * rapport d'ingestion.
 */

/** Résolution du rendu : celle où tesseract lit le mieux un texte imprimé. */
const DPI = 300;
/** Côté long maximal de l'image (px) : A3 à 250 dpi. Une page géante est rendue moins fin. */
const MAX_PX = 4200;
/** En dessous de ce nombre de caractères visibles, la couche texte d'une page ne compte pas. */
const MIN_TEXT_CHARS = 20;
const PAGE_TIMEOUT_MS = 60_000;

const envInt = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};
/** Pages lues par OCR dans un fichier (les suivantes restent sans texte). */
const maxPages = () => envInt("CORTEX_OCR_MAX_PAGES", 40);
/** Temps d'OCR par fichier, puis par ingestion entière (un dossier de scans). */
const fileBudgetMs = () => envInt("CORTEX_OCR_FILE_SECONDS", 240) * 1000;
/**
 * Au plus la moitié du délai d'une passe d'import (lib/ingest-limits), qui tue le processus :
 * l'OCR laisse le temps de lire les autres fichiers et d'écrire le corpus.
 */
const runBudgetMs = () => Math.min(envInt("CORTEX_OCR_RUN_SECONDS", 600) * 1000, Math.floor(ingestTimeoutMs() / 2));

/** Code de langue du cours → modèle tesseract. */
const TESS_LANG: Record<string, string> = { en: "eng", fr: "fra", de: "deu", it: "ita", es: "spa" };
const FALLBACK = ["eng", "fra"];

let runSpentMs = 0;

type Engine = { tesseract: string; pdftoppm: string; languages: Set<string> };
let engine: Engine | null | undefined;

const findTesseract = () => findBinary(["tesseract", "/usr/bin/tesseract", "/opt/homebrew/bin/tesseract", "/usr/local/bin/tesseract"], ["--version"]);

function loadEngine(): Engine | null {
  if (process.env.CORTEX_OCR !== "1") return null;
  if (engine !== undefined) return engine;
  const tesseract = findTesseract();
  const pdftoppm = tesseract ? findPdftoppm() : null;
  if (!tesseract || !pdftoppm) return (engine = null);
  let languages = new Set<string>();
  try {
    // « List of available languages in "…" (3): » puis une langue par ligne.
    const out = execFileSync(tesseract, ["--list-langs"], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
    languages = new Set(out.split("\n").slice(1).map((l) => l.trim()).filter((l) => l && l !== "osd"));
  } catch {
    // aucune langue lisible : l'OCR reste coupé
  }
  return (engine = languages.size ? { tesseract, pdftoppm, languages } : null);
}

/** L'OCR est-il disponible ici (tesseract, pdftoppm, au moins une langue, pas coupé) ? */
export function ocrAvailable(): boolean {
  return loadEngine() != null;
}

/**
 * Les modèles tesseract pour la langue du cours, parmi ceux installés : la langue du cours, à
 * défaut anglais + français. null si aucun n'est installé.
 */
export function ocrLanguages(courseLanguage: string, installed: Set<string>): string | null {
  const own = TESS_LANG[courseLanguage.toLowerCase().slice(0, 2)];
  const wanted = own && installed.has(own) ? [own] : FALLBACK.filter((l) => installed.has(l));
  return (wanted.length ? wanted : [...installed].slice(0, 1)).join("+") || null;
}

/**
 * Ce que l'OCR a lu vaut-il un passage ? Mesuré le 21/11 : une page de bruit rend « SEM. SER: »,
 * une image de formes quelques barres ; une page de texte, des dizaines de mots. Il faut quatre
 * mots d'au moins trois lettres, et une majorité de lettres parmi les caractères visibles.
 */
export function usefulOcrText(text: string): boolean {
  const visible = text.replace(/\s/g, "");
  if (!visible) return false;
  const words = text.match(/\p{L}{3,}/gu) ?? [];
  const letters = visible.match(/\p{L}/gu)?.length ?? 0;
  return words.length >= 4 && letters / visible.length >= 0.5;
}

const visibleChars = (s: string) => s.replace(/\s/g, "").length;

/** Ce que l'OCR lit d'un PDF ouvert par pdf.js : les dimensions de ses pages, en points. */
type PdfLike = { getPage(n: number): Promise<{ getViewport(o: { scale: number }): { width: number; height: number } }> };

/**
 * Complète par OCR les pages sans couche texte d'un PDF déjà ouvert (`texts` : le texte de chaque
 * page, dans l'ordre). Rend les textes, et pour chaque page si elle vient de l'OCR. Une page dont
 * l'OCR ne rend rien d'utile garde son texte d'origine. N'échoue jamais : sans moteur, au-delà des
 * bornes ou sur une erreur, la page reste comme elle était.
 */
export async function withOcr(
  pdf: PdfLike,
  data: Uint8Array,
  texts: string[],
  opts: { language: string; label: string },
): Promise<{ texts: string[]; ocr: boolean[] }> {
  const ocr = texts.map(() => false);
  const poor = texts.flatMap((t, i) => (visibleChars(t) < MIN_TEXT_CHARS ? [i] : []));
  const eng = poor.length ? loadEngine() : null;
  if (!eng) return { texts, ocr };
  const languages = ocrLanguages(opts.language, eng.languages);
  if (!languages) return { texts, ocr };

  const out = [...texts];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-ocr-"));
  const started = Date.now();
  let read = 0;
  let stopped: string | null = null;
  try {
    const file = path.join(dir, "doc.pdf");
    fs.writeFileSync(file, data);
    for (const i of poor) {
      const fileLeft = fileBudgetMs() - (Date.now() - started);
      const runLeft = runBudgetMs() - runSpentMs - (Date.now() - started);
      if (read >= maxPages()) { stopped = `${maxPages()} page(s) au plus par fichier`; break; }
      if (fileLeft <= 0 || runLeft <= 0) { stopped = fileLeft <= 0 ? "temps maximal par fichier" : "temps maximal de l'ingestion"; break; }
      const text = ocrPage(eng, file, i, await pageDpi(pdf, i), languages, dir, Math.min(PAGE_TIMEOUT_MS, fileLeft, runLeft));
      read++;
      if (text != null && usefulOcrText(text) && visibleChars(text) > visibleChars(out[i])) {
        out[i] = text;
        ocr[i] = true;
      }
    }
  } finally {
    runSpentMs += Date.now() - started;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`  🔎 ${opts.label} : OCR (${languages}) de ${read} page(s) en ${seconds} s, ${ocr.filter(Boolean).length} lue(s)`);
  if (stopped) console.log(`  ⚠ ${opts.label} : OCR arrêté après ${read} page(s) (${stopped}) ; ${poor.length - read} page(s) restent sans texte`);
  return { texts: out, ocr };
}

/**
 * Les pages d'un PDF ouvert, prêtes à indexer : texte de chaque page, complété par OCR quand `ocr`
 * est donné (processus d'ingestion seulement), nettoyé par `clean`, sans les pages vides (3
 * caractères au plus). `ocr` de chaque page : lue par OCR.
 */
export async function readablePages(
  pdf: PdfLike,
  data: Uint8Array,
  texts: string[],
  clean: (s: string) => string,
  ocr: { language: string; label: string } | null,
): Promise<{ text: string; ocr: boolean }[]> {
  const read = ocr ? await withOcr(pdf, data, texts, ocr) : { texts, ocr: texts.map(() => false) };
  return read.texts.map((t, i) => ({ text: clean(t), ocr: read.ocr[i] })).filter((p) => p.text.length > 3);
}

/** Rend puis lit UNE page (index 0) ; null si le rendu ou la lecture échoue ou dépasse le délai. */
function ocrPage(eng: Engine, file: string, index: number, dpi: number, languages: string, dir: string, timeoutMs: number): string | null {
  const prefix = path.join(dir, `p${index + 1}`);
  const image = `${prefix}.pgm`;
  const started = Date.now();
  try {
    execFileSync(eng.pdftoppm, ["-gray", "-r", String(dpi), "-f", String(index + 1), "-l", String(index + 1), "-singlefile", file, prefix], {
      stdio: "ignore",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    const left = timeoutMs - (Date.now() - started);
    if (left <= 0) return null;
    return execFileSync(eng.tesseract, [image, "stdout", "-l", languages, "--psm", "3"], {
      encoding: "utf8",
      // Un seul fil : la mémoire et le CPU d'une page restent bornés, l'app continue de répondre.
      env: { ...process.env, OMP_THREAD_LIMIT: "1" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: left,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  } finally {
    fs.rmSync(image, { force: true });
  }
}

/** Résolution d'une page : 300 dpi, moins pour qu'aucun côté ne dépasse MAX_PX (page géante). */
async function pageDpi(pdf: PdfLike, index: number): Promise<number> {
  try {
    const { width, height } = (await pdf.getPage(index + 1)).getViewport({ scale: 1 });
    const longSide = Math.max(width, height);
    return longSide > 0 ? Math.max(36, Math.min(DPI, Math.floor((MAX_PX * 72) / longSide))) : DPI;
  } catch {
    return DPI;
  }
}
