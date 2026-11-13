import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const workflow = fs.readFileSync("../.github/workflows/e2e.yml", "utf8");

test("le parcours Google réel est exclu du cron et activable manuellement", () => {
  assert.match(workflow, /workflow_dispatch:\s*\n\s+inputs:\s*\n\s+google_reel:/);
  assert.match(workflow, /name: Google réel[^\n]*\n\s+if: github\.event_name == 'workflow_dispatch' && inputs\.google_reel/);
  assert.doesNotMatch(workflow, /name: Google réel[^\n]*\n\s+if: github\.event_name == 'schedule'/);
});
