import { DEFAULT_COURSE } from "@/lib/courses";
import { activeJob, createJobExclusive, startWorker } from "@/lib/jobs";
import { useCourse } from "@/lib/req";
import fs from "node:fs";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Import d'un DOSSIER local dans le cours courant (Phase 1) : classe+copie le dossier dans
 * data/<course>/{refs,content} puis (ré)ingère. Tourne en JOB d'arrière-plan (l'UI poll).
 * Réservé aux cours additionnels (cs-202 = sites en lecture seule).
 */
export async function POST(req: NextRequest) {
  const course = useCourse(req);
  if (course === DEFAULT_COURSE) {
    return NextResponse.json({ error: "L'import de dossier est réservé aux cours additionnels (Algo, ML…). CS-202 utilise ses sites de révision en lecture seule." }, { status: 409 });
  }
  const { path: dir } = await req.json().catch(() => ({ path: "" }));
  const d = String(dir ?? "").trim();
  if (!d) return NextResponse.json({ error: "Chemin de dossier manquant." }, { status: 400 });
  if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) {
    return NextResponse.json({ error: `Dossier introuvable sur la machine de l'app : ${d}` }, { status: 400 });
  }

  const existing = await activeJob("ingest");
  if (existing) return NextResponse.json({ ok: true, jobId: existing.id, existing: true });

  const { id: jobId } = await createJobExclusive("ingest", d);
  try {
    await startWorker(jobId, course);
  } catch (e: any) {
    return NextResponse.json({ error: `Impossible de lancer le worker : ${e?.message ?? e}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, jobId });
}
