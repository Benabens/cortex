import path from "node:path";
import { currentLocale } from "@/lib/i18n/current";
import { currentUser } from "@/db/context";
import { intLimit } from "@/lib/billing/env";
import { coursePaths, getCourse } from "@/lib/courses";
import { classifyFile } from "@/lib/import-folder";
import { PublicFetchError, readPublicHttps, type PublicFetcher } from "@/lib/public-https";
import { checkStorage } from "@/lib/storage-quota";
import { storage as files } from "@/lib/storage";
import { storeOriginal } from "@/lib/originals/intake";
import { checkIndexQuota } from "@/lib/originals/index-quota";
import type { OriginalsHome } from "@/lib/originals/policy";
import type { OriginalOrigin } from "@/lib/originals/registry";
import { unreadableDocument } from "@/lib/document-check";
import { directDownloadUrl, sharedRedirectTarget } from "@/lib/share-links";
import * as cheerio from "cheerio";
import { errorText, userError, type ErrorParams, type UserError } from "@/lib/i18n/user-error";

/**
 * AJOUT D'UN SUPPORT À UN COURS sans passer par le navigateur : une adresse https
 * publique (PDF, page web, texte) ou un texte collé. Mêmes garde-fous que l'import
 * de l'app (POST /api/sources/import) : plafond par fichier, types sans rien
 * d'exécutable, quota de stockage, chemin confiné au cours, contenu d'un cours
 * historique en lecture seule. L'adresse est lue par la lecture durcie commune
 * (lib/public-https : https seulement, adresses publiques seulement, sans
 * redirection). Le fichier est seulement rangé : la préparation du cours
 * (job « prepare ») l'ingère avec le reste.
 *
 * Ce que l'import de l'app n'a pas à faire, parce qu'ici c'est le SERVEUR qui
 * télécharge : le quota de stockage est vérifié AVANT la lecture, et le nombre
 * de lectures d'URL est borné par compte et par heure (SOURCE_FETCH_PER_HOUR).
 */

export const SOURCE_CATEGORIES = ["past_exam", "lecture", "exercises", "notes", "sample_questions", "exam_info"] as const;
export type SourceCategory = (typeof SOURCE_CATEGORIES)[number];

/**
 * Catégorie → dossier du cours (mêmes dossiers que le classifieur de l'import).
 * Deux dossiers servent le FORMAT d'un cours sans annale (lib/format) :
 * exam-samples = questions d'exemple officielles (style imité), exam-info =
 * consignes d'examen (syllabus, page Moodle : « QCM, 45 min »).
 */
const BUCKET: Record<SourceCategory, string> = {
  past_exam: "refs", lecture: "lectures", exercises: "series", notes: "notes",
  sample_questions: "exam-samples", exam_info: "exam-info",
};

/** Type d'ingestion imposé par le dossier (exam-samples/, exam-info/), sinon null : le nom du fichier décide. */
export function sourceTypeForFolder(rel: string): "sample_questions" | "exam_info" | null {
  const f = rel.replace(/\\/g, "/").toLowerCase();
  if (/(^|\/)exam-samples\//.test(f)) return "sample_questions";
  if (/(^|\/)exam-info\//.test(f)) return "exam_info";
  return null;
}

/** Libellés lisibles des catégories (app). */
export const SOURCE_CATEGORY_LABEL: Record<SourceCategory, string> = {
  past_exam: "Annale", lecture: "Cours", exercises: "Série d'exercices", notes: "Notes",
  sample_questions: "Questions d'exemple officielles", exam_info: "Consignes d'examen",
};

/** Même plafond par fichier que l'import de l'app. */
export const SOURCE_MAX_BYTES = 30 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export class SourceError extends Error implements UserError {
  readonly code: UserError["code"];
  readonly params?: ErrorParams;

  constructor(readonly status: number, error: UserError) {
    super(errorText(currentLocale(), error));
    this.name = "SourceError";
    this.code = error.code;
    if (error.params) this.params = error.params;
  }
}

/** `home` : « local » = compte gratuit, l'original part du serveur après l'indexation de son texte. */
export type SavedSource = { name: string; folder: string; bytes: number; contentType: string; home: OriginalsHome };

const ACCEPT = "application/pdf, text/html, application/xhtml+xml, text/markdown, text/plain;q=0.9";

/** Type annoncé + premiers octets → extension acceptée, ou null. Un « PDF » sans signature PDF est refusé. */
function extensionFor(contentType: string | null, body: Buffer): ".pdf" | ".html" | ".md" | ".txt" | null {
  const ct = (contentType ?? "").split(";")[0].trim().toLowerCase();
  const isPdf = body.subarray(0, 5).toString("latin1") === "%PDF-";
  if (ct === "application/pdf") return isPdf ? ".pdf" : null;
  if (ct === "text/html" || ct === "application/xhtml+xml") return ".html";
  if (ct === "text/markdown") return ".md";
  if (ct === "text/plain") return ".txt";
  return null;
}

/** Nom de fichier sûr : titre donné, sinon dernier segment de l'URL ; sans extension d'origine, borné. */
function fileName(title: string | undefined, url: string | null, ext: string): string {
  let base = title?.trim() ?? "";
  if (!base && url) {
    try { base = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? ""); } catch { base = ""; }
  }
  base = base.replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^[._]+|_+$/g, "").slice(0, 80);
  return `${base || "support"}${ext}`;
}

function folderDir(courseId: string, folder: string): string {
  const { refsDir, contentRoot } = coursePaths(courseId);
  return path.resolve(folder === "refs" ? refsDir : path.join(contentRoot, folder));
}

/** Un texte de ce titre a-t-il déjà été rangé dans cette catégorie ? (scripts idempotents : scripts/review-account.ts) */
export async function textSourceExists(courseId: string, a: { title: string; category: SourceCategory }): Promise<boolean> {
  const dir = folderDir(courseId, BUCKET[a.category]);
  return (await files().stat(path.join(dir, fileName(a.title, null, ".md")))) !== null;
}

/** Range `data` dans le dossier du cours, sans jamais écraser un fichier existant. */
async function store(
  courseId: string, name: string, category: SourceCategory | undefined, data: Buffer, contentType: string,
  origin: { originalName?: string; origin?: OriginalOrigin; url?: string | null } = {},
): Promise<SavedSource> {
  const folder = category ? BUCKET[category] : classifyFile(name).bucket;
  // Un cours HISTORIQUE lit son contenu à la racine du dépôt, en lecture seule (comme l'import de l'app).
  if (folder !== "refs" && getCourse(courseId).paths?.contentRel === "..") {
    throw new SourceError(409, userError("source_course_read_only"));
  }
  const storage = await checkStorage(currentUser(), data.length);
  if (storage) throw new SourceError(storage.status, storage);
  const indexFull = await checkIndexQuota(currentUser());
  if (indexFull) throw new SourceError(indexFull.status, indexFull);
  const problem = await unreadableDocument(data, path.extname(name));
  if (problem) throw new SourceError(problem.status, problem.error);

  // Jamais d'écrasement (« -2 », « -3 »…). Premium : rangé dans le cloud ; gratuit : en transit,
  // le temps que l'ingestion lise son texte (lib/originals).
  const saved = await storeOriginal(courseId, folderDir(courseId, folder), name, data, { ...origin, dedupe: false });
  if (saved) return { name: saved.name, folder, bytes: data.length, contentType, home: saved.home };
  throw new SourceError(409, userError("source_duplicate_title"));
}

/** Fichier déposé depuis l'app (multipart) : mêmes gardes que le connecteur, catégorie imposée. */
export async function addFileSource(courseId: string, a: { name: string; data: Buffer; category: SourceCategory; contentType: string }): Promise<SavedSource> {
  if (!a.data.length) throw new SourceError(400, userError("source_file_empty"));
  if (a.data.length > SOURCE_MAX_BYTES) throw new SourceError(413, userError("source_file_too_large_plain", { maxMb: SOURCE_MAX_BYTES / 1024 / 1024 }));
  const ext = path.extname(a.name).toLowerCase();
  if (![".pdf", ".md", ".txt", ".html", ".htm"].includes(ext)) throw new SourceError(415, userError("source_file_formats_accepted"));
  if (ext === ".pdf" && a.data.subarray(0, 5).toString("latin1") !== "%PDF-") throw new SourceError(415, userError("source_pdf_invalid"));
  return store(courseId, fileName(path.basename(a.name, ext), null, ext === ".htm" ? ".html" : ext), a.category, a.data, a.contentType, { originalName: a.name, origin: "upload" });
}

export async function addTextSource(courseId: string, a: { text: string; title?: string; category?: SourceCategory }): Promise<SavedSource> {
  const data = Buffer.from(a.text, "utf8");
  if (!a.text.trim()) throw new SourceError(400, userError("source_text_empty"));
  if (data.length > SOURCE_MAX_BYTES) throw new SourceError(413, userError("source_text_too_large"));
  return store(courseId, fileName(a.title ?? "notes", null, ".md"), a.category, data, "text/markdown", { origin: "text" });
}

/** Lectures d'URL par compte sur l'heure glissante (conteneur unique, cf. ARCHITECTURE : en mémoire suffit). */
const fetches = new Map<string, number[]>();

const HOUR_MS = 3600_000;

/** Compte une lecture si le plafond horaire le permet. Défaut 30 en déploiement gardé ; « unlimited » lève. */
function takeFetchSlot(userId: string): boolean {
  const cap = intLimit("SOURCE_FETCH_PER_HOUR", 30);
  if (cap === null) return true;
  const now = Date.now();
  const recent = (fetches.get(userId) ?? []).filter((t) => now - t < HOUR_MS);
  const ok = recent.length < cap;
  if (ok) recent.push(now);
  fetches.set(userId, recent);
  // Mémoire bornée : on oublie d'abord les comptes sans lecture dans l'heure (jamais les compteurs actifs).
  if (fetches.size > 10_000) {
    for (const [k, v] of fetches) if (!v.some((t) => now - t < HOUR_MS)) fetches.delete(k);
  }
  return ok;
}

export async function addUrlSource(
  courseId: string, a: { url: string; title?: string; category?: SourceCategory }, fetcher: PublicFetcher = readPublicHttps,
): Promise<SavedSource> {
  const userId = currentUser();
  // Compte déjà plein : refuser avant de télécharger quoi que ce soit (et sans consommer de lecture).
  const full = await checkStorage(userId, 1);
  if (full) throw new SourceError(full.status, full);
  if (!takeFetchSlot(userId)) {
    throw new SourceError(429, userError("source_url_rate_limit"));
  }
  // Lien de partage Drive / Docs / Dropbox : lu à son adresse de téléchargement direct.
  const link = directDownloadUrl(a.url);
  const opts = { maxBytes: SOURCE_MAX_BYTES, timeoutMs: FETCH_TIMEOUT_MS, accept: ACCEPT, userAgent: "Cortex-Sources/1.0" };
  let res;
  try {
    // Google et Dropbox servent le fichier depuis leur hôte de téléchargement : deux sauts au plus.
    let target = link.url;
    for (let hop = 0; ; hop++) {
      try { res = await fetcher(target, opts); break; } catch (e) {
        const next = e instanceof PublicFetchError && e.reason === "redirect" && hop < 2 ? sharedRedirectTarget({ ...link, url: target }, e.location) : null;
        if (!next) throw e;
        target = next;
      }
    }
  } catch (e) {
    if (!(e instanceof PublicFetchError)) throw e;
    if (e.reason === "too_large") throw new SourceError(413, userError("source_document_too_large", { maxMb: SOURCE_MAX_BYTES / 1024 / 1024 }));
    if (e.reason === "redirect") {
      // L'hôte seulement : le reste de l'en-tête Location vient du serveur distant et irait tel quel au modèle.
      const host = (() => { try { return e.location ? new URL(e.location, a.url).host : null; } catch { return null; } })();
      throw new SourceError(400, host ? userError("source_url_redirect_host", { host }) : userError("source_url_redirect"));
    }
    if (e.reason === "blocked" || e.reason === "invalid_url") {
      throw new SourceError(400, userError("source_url_private"));
    }
    throw new SourceError(400, userError("source_read_failed", { detail: e.message }));
  }
  const ext = extensionFor(res.contentType, res.body);
  if (!ext) {
    throw new SourceError(415, res.contentType ? userError("source_type_unsupported", { contentType: res.contentType.slice(0, 60) }) : userError("source_type_unknown"));
  }
  if (!res.body.length) throw new SourceError(400, userError("source_document_empty"));
  if (ext === ".html") {
    const problem = htmlPageProblem(res.body.toString("utf8"));
    if (problem) throw new SourceError(422, problem);
  }
  return store(courseId, fileName(a.title, link.named ? link.url : null, ext), a.category, res.body, (res.contentType ?? "").split(";")[0].trim(), { origin: "url", url: a.url });
}

const LOGIN = /(?<!\p{L})(connexion|se connecter|sign[ -]?in|log[ -]?in|anmelden|iniciar sesi[oó]n|accedi)(?!\p{L})/iu;

/**
 * Une page web qui n'apporte rien au corpus : page de connexion (lien privé, visionneuse d'un
 * Drive), ou presque vide. Le message dit quoi faire ; null si la page a du contenu.
 */
function htmlPageProblem(html: string): UserError | null {
  const $ = cheerio.load(html);
  const password = $("input[type=password]").length > 0;
  $("script, style, noscript, nav, header, footer").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim();
  // Un champ mot de passe, ou presque rien d'autre que « Connexion » : « une connexion TCP » n'en est pas une.
  if (password || (text.length < 200 && LOGIN.test(`${$("title").text()} ${text}`))) {
    return userError("source_page_login_required");
  }
  if (text.length < 200) return userError("source_page_almost_empty");
  return null;
}
