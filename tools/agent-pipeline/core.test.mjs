import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertScope, collectTask, readyForChecks, readyForPr, REQUIRED_CHECKS, reviewTask, sha, validateTasks } from './core.mjs';

const fixture = () => ({ id: 'DS-JOB-001', provider: 'deepseek', goal: 'Corriger un job.', files: ['cortex/lib/ux/api.tsx'], status: 'prepared' });

test('périmètres explicites, distincts, sans secrets ni chemins relatifs échappant au dépôt', () => {
  assert.equal(validateTasks([fixture()]).length, 1);
  for (const file of ['../secret.ts', '/tmp/test.ts', 'cortex/lib/../../secret.ts', 'cortex/lib/.env', 'cours/annales.md', 'cortex/lib/*', 'cortex/lib/api.ts\n']) {
    assert.throws(() => validateTasks([{ ...fixture(), files: [file] }]));
  }
  assert.throws(() => validateTasks([fixture(), { ...fixture(), id: 'QW-OPEN-001', provider: 'qwen' }]));
  assert.throws(() => validateTasks([fixture(), fixture()]));
});

test('recevoir une nouvelle proposition invalide toute revue précédente', () => {
  const reviewed = reviewTask(collectTask(fixture(), 'proposition'), 'proposition', 'code1', 'Relu le périmètre et corrigé le rendu.');
  const next = collectTask(reviewed, 'proposition suivante');
  assert.equal(next.status, 'proposed');
  assert.equal(next.review, null);
  assert.notEqual(next.responseHash, reviewed.responseHash);
  assert.throws(() => readyForChecks([next], () => 'code1'));
});

test('ni une réponse vide ni une réponse modifiée ne peuvent être approuvées', () => {
  assert.throws(() => collectTask(fixture(), '  '));
  assert.throws(() => collectTask(fixture(), 'x'.repeat(1024 * 1024 + 1)));
  const proposed = collectTask(fixture(), 'code proposé');
  assert.throws(() => reviewTask(proposed, 'autre code', 'code1', 'Revue suffisamment longue.'));
  assert.throws(() => reviewTask(proposed, 'code proposé', 'code1', 'OK'));
});

test('toutes les tâches doivent être revues et le code identique à la revue', () => {
  const task = reviewTask(collectTask(fixture(), 'code proposé'), 'code proposé', 'code1', 'Paire cours/job et rappel tardif revus.');
  readyForChecks([task], () => 'code1');
  assert.throws(() => readyForChecks([task], () => 'code2'));
  assert.throws(() => readyForChecks([task, fixture()], () => 'code1'));
  assert.throws(() => readyForChecks([], () => 'code1'));
  assert.throws(() => readyForChecks([{ ...task, responseHash: sha('nouveau') }], () => 'code1'));
});

test('publication bloquée sans contrôles, après un échec ou après une modification', () => {
  const task = reviewTask(collectTask(fixture(), 'proposition'), 'proposition', 'scope', 'Revue explicite et code relu.');
  const state = { tasks: [task], validation: { passed: true, treeHash: 'code', checks: REQUIRED_CHECKS.map((name) => ({ name, code: 0 })) } };
  const current = () => 'scope';
  assert.throws(() => readyForPr({}, 'code', current));
  assert.throws(() => readyForPr({ ...state, validation: null }, 'code', current));
  assert.throws(() => readyForPr({ ...state, validation: { ...state.validation, checks: [] } }, 'code', current));
  assert.throws(() => readyForPr({ ...state, validation: { ...state.validation, checks: [{ name: 'build', code: 1 }] } }, 'code', current));
  assert.throws(() => readyForPr(state, 'autre code', current));
  assert.throws(() => readyForPr(state, 'code', () => 'scope modifié'));
  assert.throws(() => readyForPr({ ...state, tasks: [fixture()] }, 'code', current));
  assert.throws(() => readyForPr({ ...state, validation: { ...state.validation, checks: [{ name: 'build', code: 0 }] } }, 'code', current));
  assert.equal(readyForPr(state, 'code', current), true);
});

test('AGY : une modification hors tâche est refusée même si les tâches sont revues', () => {
  assertScope([fixture()], ['cortex/lib/ux/api.tsx']);
  assert.throws(() => assertScope([fixture()], ['cortex/lib/ux/api.tsx', 'cortex/lib/auth.ts']));
});

test('AGY : la re-revue après retouche est possible sans falsifier une nouvelle réponse', () => {
  const reviewed = reviewTask(collectTask(fixture(), 'proposition'), 'proposition', 'v1', 'Première revue du correctif.');
  const updated = reviewTask(reviewed, 'proposition', 'v2', 'Revue actualisée après correction du typage.');
  assert.equal(updated.review.filesHash, 'v2');
  assert.equal(updated.responseHash, reviewed.responseHash);
  readyForChecks([updated], () => 'v2');
});
