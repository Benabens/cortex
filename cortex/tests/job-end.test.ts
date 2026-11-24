/**
 * FIN D'UN JOB VUE PAR L'INTERFACE — audit generation-ux du 24/11/2026 : une génération annulée
 * s'affichait « ✓ Examen généré » dans le compositeur (tout ce qui n'était pas « error » passait
 * pour un succès), et « La génération a échoué » sur le bandeau de l'Accueil. Une seule règle,
 * jobEnd, que chaque composant qui réagit à la fin d'un job consulte.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { jobEnd, JOB_ACTIVE } from "@/lib/ux/job-status";

test("jobEnd : en cours → null, annulé ≠ échec ≠ succès", () => {
  for (const s of JOB_ACTIVE) assert.equal(jobEnd(s), null, s);
  assert.equal(jobEnd("done"), "done");
  assert.equal(jobEnd("canceled"), "canceled");
  assert.equal(jobEnd("error"), "failed");
  // Posé par le sondeur quand le job est introuvable ou la connexion perdue.
  assert.equal(jobEnd("failed"), "failed");
});

test("aucun composant ne range une annulation avec les succès (test « error || failed » puis else)", () => {
  const root = path.join(__dirname, "..", "components");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && /status === "error" \|\| [\w.!]*status === "failed"/.test(fs.readFileSync(p, "utf8"))) offenders.push(path.relative(root, p));
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});
