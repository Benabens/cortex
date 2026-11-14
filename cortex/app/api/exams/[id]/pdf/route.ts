import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { q } from "@/db/q";
import { examsDir } from "@/lib/paths";
import { useCourseOr404 } from "@/lib/req";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * « Régénérer le PDF » d'un examen QCM ou à questions composées : recompile depuis la base, SANS le modèle,
 * gratuitement. Seulement si le PDF manque (un PDF présent est rendu tel quel) :
 * rien à gagner à relancer tectonic sur un examen déjà compilé.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = useCourseOr404(req);
  if (denied) return denied;
  const examId = Number((await params).id);
  if (!Number.isInteger(examId) || examId <= 0) return NextResponse.json({ error: "Examen invalide." }, { status: 400 });
  const row = await q.get<{ html_path: string | null; format_template: string }>(`SELECT html_path, format_template FROM exams WHERE id = ? AND format_template IN ('qcm','blocks')`, examId).catch(() => undefined);
  if (!row) return NextResponse.json({ error: "Examen QCM introuvable." }, { status: 404 });
  const file = row.html_path ? path.basename(row.html_path) : "";
  if (file.endsWith(".pdf") && fs.existsSync(path.join(examsDir(), file))) return NextResponse.json({ ok: true, file, recompiled: false });
  const out = row.format_template === "blocks"
    ? await (await import("@/lib/blocks")).recompileBlocksPdf(examId)
    : await (await import("@/lib/qcm")).recompileQcmPdf(examId);
  if (!out) return NextResponse.json({ error: "Examen QCM introuvable." }, { status: 404 });
  const ok = out.file.endsWith(".pdf");
  // Rien de la sortie du compilateur vers le client (audit du 14/11/2026, 🔴 1) : le détail va aux logs.
  if (!ok) console.error(`[pdf] examen #${examId} non recompilé :`, out.texError ?? "");
  return NextResponse.json(
    { ok, file: out.file || null, recompiled: true, warning: out.texWarning ?? null, error: ok ? null : "Le PDF ne compile toujours pas." },
    { status: ok ? 200 : 500 },
  );
}
