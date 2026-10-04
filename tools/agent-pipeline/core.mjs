import { createHash } from 'node:crypto';

export const sha = (text) => createHash('sha256').update(text).digest('hex');
export const REQUIRED_CHECKS = ['pipeline', 'lint-guard', 'types', 'build', 'lint', 'tests'];

export function validateTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('Aucune tâche.');
  const ids = new Set();
  const paths = new Set();
  for (const task of tasks) {
    if (!/^[A-Z][A-Z0-9-]{1,60}$/.test(task.id) || ids.has(task.id)) throw new Error('Identifiant de tâche invalide ou dupliqué.');
    ids.add(task.id);
    if (!['qwen', 'deepseek', 'grok', 'agy'].includes(task.provider)) throw new Error('Fournisseur inconnu.');
    if (typeof task.goal !== 'string' || !task.goal.trim()) throw new Error('Objectif vide.');
    if (!Array.isArray(task.files) || !task.files.length) throw new Error('Périmètre vide.');
    for (const file of task.files) {
      // Seuls les chemins de code explicites : aucun glob, secret ou corpus.
      const coordinatorFile = file === '.gitignore' || file === '.github/workflows/ci.yml';
      if (typeof file !== 'string' || (!coordinatorFile && (!/^(cortex\/(app|components|lib|tests)\/|tools\/agent-pipeline\/)[A-Za-z0-9_\/[\].-]+$/.test(file) || file.split('/').some((p) => p === '.' || p === '..') || !/\.(tsx?|mjs|json|md)$/.test(file)))) throw new Error(`Chemin interdit : ${file}`);
      if (paths.has(file)) throw new Error(`Deux tâches touchent ${file}.`);
      paths.add(file);
    }
  }
  return tasks;
}

export function collectTask(task, response) {
  if (typeof response !== 'string' || !response.trim() || Buffer.byteLength(response) > 1024 * 1024) throw new Error('Réponse vide ou trop volumineuse.');
  return { ...task, status: 'proposed', responseHash: sha(response), review: null };
}

export function reviewTask(task, response, filesHash, note) {
  if (!['proposed', 'reviewed'].includes(task.status) || task.responseHash !== sha(response)) throw new Error('La réponse a changé ou manque.');
  if (typeof note !== 'string' || note.trim().length < 10) throw new Error('Revue explicite requise.');
  return { ...task, status: 'reviewed', review: { filesHash, note: note.trim(), responseHash: task.responseHash } };
}

export function readyForChecks(tasks, fingerprint) {
  if (!tasks.length) throw new Error('Aucune tâche.');
  for (const task of tasks) {
    if (task.status !== 'reviewed' || !task.review || task.responseHash !== task.review.responseHash || fingerprint(task) !== task.review.filesHash) throw new Error(`Revue absente ou périmée : ${task.id}`);
  }
}

export function assertScope(tasks, changedFiles) {
  const allowed = new Set(tasks.flatMap((t) => t.files));
  for (const file of changedFiles) if (!allowed.has(file)) throw new Error(`Fichier modifié hors périmètre : ${file}`);
}

export function readyForPr(state, fingerprint, taskFingerprint) {
  readyForChecks(state.tasks ?? [], taskFingerprint);
  if (!state.validation?.passed || !state.validation.checks?.length || state.validation.checks.some((c) => c.code !== 0)) throw new Error('Contrôles non réussis.');
  if (fingerprint !== state.validation.treeHash) throw new Error('Le code a changé après les contrôles.');
  const names = state.validation.checks.map((c) => c.name);
  if (names.length !== REQUIRED_CHECKS.length || REQUIRED_CHECKS.some((name) => !names.includes(name))) throw new Error('Contrôles requis incomplets.');
  return true;
}
