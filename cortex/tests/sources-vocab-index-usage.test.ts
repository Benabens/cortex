/**
 * Déposer ou retirer une annale depuis l'app garde les données dérivées du corpus à jour (chasse
 * aux bugs du 22/11/2026) :
 *  - le vocabulaire de la recherche (correction des fautes) n'était reconstruit que par la
 *    préparation complète : les termes d'une annale déposée n'étaient pas corrigés, ceux d'une
 *    annale retirée l'étaient encore ;
 *  - POST /api/sources (addUploadedRef) n'actualisait pas le relevé d'index (index_usage) sur
 *    lequel se juge le quota d'un compte gratuit.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-sources-vocab-"));
process.env.CORTEX_DATA_DIR = tmp;
process.env.MAX_COURSES_CREATED_PER_HOUR = "unlimited";
const env = process.env as Record<string, string | undefined>;

after(() => {
  for (const k of ["CORTEX_DATA_DIR", "MAX_COURSES_CREATED_PER_HOUR"]) delete env[k];
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("annale déposée puis retirée : vocabulaire et relevé d'index suivent", async () => {
  delete env.CORTEX_USER;
  const { ensureCoursesLoaded, reloadCourses } = await import("../lib/courses");
  await ensureCoursesLoaded();
  const { buildCourseRow } = await import("../lib/course-create");
  const { insertCourse } = await import("../db/courses-store");
  const row = buildCourseRow({ name: "Orvelle graphes", language: "fr" }, "owner");
  await insertCourse(row);
  await reloadCourses();
  const { runWithCourse } = await import("../db/client");
  const { q } = await import("../db/q");
  const { addUploadedRef, removeUploadedRef } = await import("../lib/sources");
  const { rankedHits } = await import("../lib/search");
  const { authGet } = await import("../db/auth-store");

  await runWithCourse(row.id, async () => {
    const term = async (t: string) => !!(await q.get(`SELECT 1 FROM vocab WHERE term = ?`, t));
    await addUploadedRef(Buffer.from("Final 2024. Exercice 1 : appliquer l'algorithme de Kruskal à ce graphe pondéré."), "final-2024.txt");
    assert.equal(await term("kruskal"), true, "le terme de l'annale déposée entre au vocabulaire");
    assert.ok((await rankedHits("kruskla", 10)).length >= 1, "et la faute de frappe est corrigée tout de suite");
    const usage = await authGet<{ bytes: number }>(`SELECT bytes FROM index_usage WHERE user_id = ? AND course = ?`, "owner", row.id);
    assert.ok(usage && Number(usage.bytes) > 0, "le relevé d'index compte l'annale déposée");

    await removeUploadedRef("refs/final-2024.txt");
    assert.equal(await term("kruskal"), false, "le terme de l'annale retirée sort du vocabulaire");
    assert.equal(Number((await q.get<{ n: number }>(`SELECT count(*) n FROM items`))?.n), 0);
  });
});
