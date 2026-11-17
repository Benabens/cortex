/**
 * Un cours fictif et le VRAI script d'ingestion, pour les tests d'ingestion. Le test pose
 * CORTEX_DATA_DIR (dossier temporaire) avant le premier import.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export async function newCourse(name: string): Promise<{ id: string; refsDir: string; contentRoot: string }> {
  delete process.env.CORTEX_USER;
  const { ensureCoursesLoaded, reloadCourses, coursePaths } = await import("../../lib/courses");
  await ensureCoursesLoaded();
  const { buildCourseRow } = await import("../../lib/course-create");
  const { insertCourse } = await import("../../db/courses-store");
  const row = buildCourseRow({ name, language: "fr" }, "owner");
  await insertCourse(row);
  await reloadCourses();
  const { refsDir, contentRoot } = coursePaths(row.id);
  fs.mkdirSync(refsDir, { recursive: true });
  fs.mkdirSync(path.join(contentRoot, "lectures"), { recursive: true });
  return { id: row.id, refsDir, contentRoot };
}

export function ingest(course: string, env: Record<string, string> = {}) {
  const report = path.join(process.env.CORTEX_DATA_DIR!, `rapport-${course}.json`);
  fs.rmSync(report, { force: true });
  const r = spawnSync(path.join(process.cwd(), "node_modules", ".bin", "tsx"), ["scripts/ingest.ts", `--course=${course}`], {
    env: { ...process.env, ...env, CORTEX_COURSE: course, CORTEX_INGEST_REPORT: report },
    encoding: "utf8",
  });
  const files = fs.existsSync(report) ? (JSON.parse(fs.readFileSync(report, "utf8")).files as { path: string; status: string; items: number }[]) : null;
  return { status: r.status, output: r.stdout + r.stderr, files };
}

export async function sourcePaths(course: string): Promise<string[]> {
  const { runWithCourse } = await import("../../db/client");
  const { q } = await import("../../db/q");
  return runWithCourse(course, async () => (await q.all<{ path: string }>(`SELECT DISTINCT path FROM sources ORDER BY path`)).map((s) => s.path));
}
