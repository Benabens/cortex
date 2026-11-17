import { apiError } from "@/lib/i18n/api-error";
import { LAUNCH_KINDS, assistSpec, getUsageLimits, jobSpec } from "@/lib/billing/limits";
import { costForJob, type JobType } from "@/lib/jobs";
import { useUser } from "@/lib/req";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ce qu'un écran peut vouloir vérifier à sa taille exacte : un type de job, ou une aide (drill, check). */
const CHECKABLE: ReadonlySet<string> = new Set(["exam", "qcm", "exercise", "lab-exercise", "prepare", "format", "drill", "check"]);
const NAMES: Record<string, { label: string; plural: string }> = {
  "lab-exercise": { label: "exercice de lab", plural: "exercices de lab" },
  format: { label: "détection du format", plural: "détections du format" },
};

/**
 * LIMITES D'USAGE du compte connecté (lib/billing/limits getUsageLimits) : la
 * section « Mon usage » de la page compte et l'indicateur posé à côté de chaque
 * bouton de génération lisent ceci. `?kind=qcm&target={"count":30,"openCount":3}`
 * ajoute le verdict pour cette composition précise (`check`) : le bouton est
 * désactivé AVANT le lancement, avec le message que la génération renverrait.
 */
export async function GET(req: NextRequest) {
  useUser(req);
  const kind = req.nextUrl.searchParams.get("kind");
  const target = req.nextUrl.searchParams.get("target");
  if (kind && !CHECKABLE.has(kind)) return apiError(req, "generation_type_unknown", 400);
  if (target && target.length > 2000) return apiError(req, "composition_too_long", 400);
  let extra: Parameters<typeof getUsageLimits>[1];
  if (kind) {
    const known = (Object.values(LAUNCH_KINDS) as Array<(typeof LAUNCH_KINDS)[keyof typeof LAUNCH_KINDS]>).find((k) => k.jobType === kind)
      ?? (kind === "drill" || kind === "check" ? LAUNCH_KINDS[kind] : null);
    const { label, plural } = known ?? NAMES[kind];
    const spec = kind === "drill" || kind === "check" ? assistSpec() : jobSpec(kind, costForJob(kind as JobType, target));
    extra = { spec, kind, label, plural };
  }
  return NextResponse.json(await getUsageLimits(undefined, extra));
}
