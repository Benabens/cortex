import { loadProjectRevision } from "@/lib/project-revision";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Révision du projet ML (CS-233) — Milestones 1 & 2. Sert le contenu pré-construit et committé
 * (`data/ml/project-revision.json`) : explication, questions du prof, QCM/ouvertes. Aucune DB requise.
 */
export function GET() {
  const data = loadProjectRevision();
  if (data) return NextResponse.json({ ...data, source: "json" });
  return NextResponse.json({ source: "empty" });
}
