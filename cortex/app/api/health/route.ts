import { q } from "@/db/q";
import { authGet } from "@/db/auth-store";
import { ensureCoursesLoaded, listCourses } from "@/lib/courses";
import { llmAvailable } from "@/lib/llm";
import { sandboxAvailable } from "@/lib/sandbox-exec";
import { texAvailable } from "@/lib/exam-latex";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/health — sonde de disponibilité, PUBLIQUE (proxy.ts la laisse
 * passer). Rapide, sans secret : DB joignable, moteur LLM prêt, sandbox et LaTeX
 * présents. status 200 si la DB répond, 503 sinon (readiness).
 *
 * La sonde interroge le STORE GLOBAL, pas la base d'un cours : une instance sans
 * aucun cours (compte neuf, base fraîche) est parfaitement saine — elle attend
 * juste que l'utilisateur crée sa matière. Sonder un cours ferait échouer la
 * readiness d'un déploiement neuf.
 */
export async function GET() {
  let db = false;
  let courses = 0;
  try {
    await authGet(`SELECT 1 AS ok`);
    db = true;
    await ensureCoursesLoaded();
    courses = listCourses().length;
  } catch { db = false; }
  const body = {
    status: db ? "ok" : "degraded",
    driver: q.dialect,
    checks: {
      db,
      courses,
      llm: llmAvailable(),
      sandbox: sandboxAvailable(),
      latex: texAvailable(),
    },
    // Décision d'isolation : sans bac à sable noyau (cas de Railway, où unshare est
    // refusé), AUCUN code n'est exécuté — ni sympy, ni figures matplotlib, ni
    // programmes candidats — et la vérification par exécution répond
    // not_applicable (jamais un faux « prouvé »). Cf. ARCHITECTURE.md § Isolation.
    verification: {
      byExecution: sandboxAvailable(),
      mode: sandboxAvailable() ? "sandboxed" : "disabled",
      note: sandboxAvailable()
        ? "exécution de code isolée (seatbelt / namespaces)"
        : "aucune isolation noyau disponible : exécution de code désactivée, verdict not_applicable",
    },
    uptimeSec: Math.round(process.uptime()),
  };
  return NextResponse.json(body, { status: db ? 200 : 503 });
}
