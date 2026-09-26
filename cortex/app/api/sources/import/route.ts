import { coursePaths, getCourse } from "@/lib/courses";
import { classifyFile } from "@/lib/import-folder";
import { activeJob, createJobExclusive, startWorker } from "@/lib/jobs";
import { requireCourse } from "@/lib/req";
import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { readFormData, withBodyLimit } from "@/lib/upload-limit";
import { checkStorage, declaredBytes } from "@/lib/storage-quota";
import { currentUser } from "@/db/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * IMPORT D'UN DOSSIER — depuis le NAVIGATEUR, plus depuis le disque du serveur.
 *
 * L'ancienne version demandait un chemin de dossier « sur la machine de l'app » :
 * inutilisable à distance (personne n'a de fichiers sur le conteneur), et elle
 * laissait n'importe quel compte faire indexer n'importe quel répertoire du
 * serveur dans son tenant. Elle est remplacée par un envoi multipart classique
 * (`<input type="file" webkitdirectory>` côté client).
 *
 * Ce que ça garde de l'ancien import : la CLASSIFICATION (lib/import-folder) —
 * les finals partent dans refs/ (donc dans l'ADN d'examen), les slides, séries
 * et notes dans content/<bucket>/. Un dépôt de fichiers simple, lui, passe par
 * POST /api/refs/upload et vaut « ce sont des annales ».
 */

/** Extensions acceptées — mêmes que le classifieur ; rien d'exécutable. */
const ALLOWED = new Set([".pdf", ".html", ".htm", ".md", ".txt", ".tex", ".c", ".h", ".png", ".jpg", ".jpeg", ".webp", ".pptx"]);

const MAX_FILES = 100;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;

/** Chemin relatif ASSAINI : segments sûrs, pas de remontée, profondeur bornée. */
function safeRelPath(raw: string): string | null {
  const parts = raw
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== "." && s !== "..")
    .map((s) => s.replace(/[^a-zA-Z0-9._-]/g, "_"))
    .slice(-4); // on garde le contexte proche (dossier parent), pas l'arborescence entière
  if (!parts.length) return null;
  const name = parts[parts.length - 1];
  if (!ALLOWED.has(path.extname(name).toLowerCase())) return null;
  return parts.join("/");
}

export const POST = withBodyLimit(async function POST(req: NextRequest) {
  const { course, denied } = requireCourse(req);
  if (denied) return denied;
  // Quota de stockage du compte + espace libre du volume, AVANT de lire l'envoi.
  const storage = await checkStorage(currentUser(), declaredBytes(req));
  if (storage) return NextResponse.json({ error: storage.error }, { status: storage.status });

  const cfg = getCourse(course);
  // Un cours HISTORIQUE lit son contenu à la racine du dépôt, en lecture seule :
  // on n'y écrit jamais. Le glisser-déposer de fichiers (→ refs/) reste possible.
  if (cfg.paths?.contentRel === "..") {
    return NextResponse.json(
      { error: `Le contenu de « ${cfg.name} » est en lecture seule. Dépose tes annales dans la zone de fichiers ci-dessus.` },
      { status: 409 },
    );
  }

  // Refus AVANT `formData()` : celui-ci met tout le corps en mémoire, donc un
  // plafond vérifié après coup ne protège de rien. Content-Length est déclaratif,
  // mais c'est la seule borne disponible avant de tamponner.
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_TOTAL_BYTES) {
    return NextResponse.json(
      { error: `Envoi trop volumineux (${Math.round(declared / 1e6)} Mo, maximum ${Math.round(MAX_TOTAL_BYTES / 1e6)} Mo). Importe en plusieurs fois.` },
      { status: 413 },
    );
  }

  const form = await readFormData(req, MAX_TOTAL_BYTES);
  if (!form) return NextResponse.json({ error: "Envoi multipart attendu." }, { status: 400 });
  const files = form.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return NextResponse.json({ error: "Aucun fichier." }, { status: 400 });
  if (files.length > MAX_FILES) {
    return NextResponse.json({ error: `Trop de fichiers (${files.length}, maximum ${MAX_FILES}).` }, { status: 400 });
  }
  // Les chemins relatifs (webkitRelativePath) arrivent en parallèle des fichiers :
  // c'est eux qui portent l'information « ce PDF est dans annales/ », donc la classification.
  const rels = form.getAll("relpath").map((v) => String(v));

  const { refsDir, contentRoot } = coursePaths(course);
  const saved: { name: string; bucket: string }[] = [];
  const skipped: string[] = [];
  let total = 0;

  for (const [i, f] of files.entries()) {
    const rel = safeRelPath(rels[i] || f.name);
    if (!rel) { skipped.push(f.name); continue; }
    if (f.size > MAX_FILE_BYTES) { skipped.push(f.name); continue; }
    if (total + f.size > MAX_TOTAL_BYTES) { skipped.push(f.name); continue; }

    const { bucket } = classifyFile(rel);
    const name = path.basename(rel);
    const destDir = bucket === "refs" ? refsDir : path.join(contentRoot, bucket);
    const abs = path.join(destDir, name);
    // Ceinture et bretelles : le chemin écrit DOIT rester sous la destination.
    if (!abs.startsWith(path.resolve(destDir) + path.sep)) { skipped.push(f.name); continue; }
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(abs, Buffer.from(await f.arrayBuffer()));
    total += f.size;
    saved.push({ name, bucket });
  }

  if (!saved.length) {
    return NextResponse.json(
      { error: "Aucun fichier exploitable (PDF, HTML, TXT, MD, TEX, images, PPTX)." },
      { status: 400 },
    );
  }

  // L'ingestion (re)construit le corpus complet du cours : content/ + refs/.
  const existing = await activeJob("ingest");
  if (existing) return NextResponse.json({ ok: true, jobId: existing.id, existing: true, files: saved.length, skipped: skipped.length });

  const { id: jobId } = await createJobExclusive("ingest");
  try {
    await startWorker(jobId, course);
  } catch (e) {
    return NextResponse.json({ error: `Impossible de lancer le worker : ${(e as Error)?.message ?? e}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, jobId, files: saved.length, skipped: skipped.length });
}
)