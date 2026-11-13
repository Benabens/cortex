import { q } from "@/db/q";
import { authGet } from "@/db/auth-store";
import { ensureCoursesLoaded, listCourses } from "@/lib/courses";
import { llmAvailable } from "@/lib/llm";
import { sandboxAvailable } from "@/lib/sandbox-exec";
import { pythonWasmAvailable } from "@/lib/pyodide-sandbox";
import { texAvailable } from "@/lib/exam-latex";
import { railwayEnvironmentName } from "@/lib/railway-env";
import { hasMetricsToken } from "@/lib/metrics-token";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/health — sonde de disponibilité, PUBLIQUE (proxy.ts la laisse
 * passer). Rapide, sans secret. status 200 si la DB répond, 503 sinon (readiness).
 *
 * En public, la réponse se limite à `{ status }` : le pilote de base, le nombre
 * de cours, l'état du moteur, de la sandbox et de LaTeX décrivent l'infrastructure
 * à n'importe qui (audit du 13/11/2026). Le détail reste servi avec
 * `Authorization: Bearer <METRICS_TOKEN>`, comme /api/metrics.
 *
 * La sonde interroge le STORE GLOBAL, pas la base d'un cours : une instance sans
 * aucun cours (compte neuf, base fraîche) est parfaitement saine — elle attend
 * juste que l'utilisateur crée sa matière. Sonder un cours ferait échouer la
 * readiness d'un déploiement neuf.
 */
export async function GET(req: Request) {
  let db = false;
  let courses = 0;
  try {
    await authGet(`SELECT 1 AS ok`);
    db = true;
    await ensureCoursesLoaded();
    courses = listCourses().length;
  } catch { db = false; }
  const status = db ? "ok" : "degraded";
  const code = db ? 200 : 503;
  // Commit servi (public : le dépôt l'est aussi) — le workflow post-deploy attend que
  // la prod serve SON commit avant de la tester. Posé par Railway ; null hors Railway.
  const commit = process.env.RAILWAY_GIT_COMMIT_SHA || null;
  if (!hasMetricsToken(req)) return NextResponse.json({ status, commit }, { status: code });
  const nativeSandbox = sandboxAvailable();
  const pythonWasm = pythonWasmAvailable();
  const body = {
    status,
    commit,
    environment: railwayEnvironmentName() || null,
    driver: q.dialect,
    checks: {
      db,
      courses,
      llm: llmAvailable(),
      sandbox: nativeSandbox,
      pythonWasm,
      latex: texAvailable(),
    },
    // Sans isolation noyau, seul Python peut être rouvert explicitement dans
    // Pyodide. C, sympy et matplotlib restent refusés. Cf. ARCHITECTURE.md § Isolation.
    verification: {
      byExecution: nativeSandbox || pythonWasm,
      mode: nativeSandbox ? "sandboxed" : pythonWasm ? "python-wasm" : "disabled",
      note: nativeSandbox
        ? "exécution de code isolée (seatbelt / namespaces)"
        : pythonWasm
          ? "Python isolé par WebAssembly ; C, SymPy et figures restent désactivés"
        : "aucune isolation noyau disponible : exécution de code désactivée, verdict not_applicable",
    },
    uptimeSec: Math.round(process.uptime()),
  };
  return NextResponse.json(body, { status: code });
}
