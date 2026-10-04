#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertScope, collectTask, readyForChecks, readyForPr, reviewTask, sha, validateTasks } from './core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runs = path.join(root, '.agent-runs');
const statePath = path.join(runs, 'state.json');
const app = path.join(root, 'cortex');

function execute(bin, args, cwd = root) {
  const result = spawnSync(bin, args, { cwd, encoding: 'utf8', shell: false, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${bin} a échoué (${result.status}) : ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}
const git = (...args) => execute('git', args);

function code(file) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) return null;
  const real = fs.realpathSync(full);
  if (!real.startsWith(root + path.sep) || !fs.statSync(full).isFile() || fs.lstatSync(full).isSymbolicLink()) throw new Error(`Fichier hors dépôt : ${file}`);
  return fs.readFileSync(full);
}
function filesHash(files) {
  return sha(JSON.stringify(files.map((file) => [file, code(file)?.toString('base64') ?? null])));
}
function treeHash() {
  const files = git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean).sort();
  return filesHash([...new Set(files)]);
}
function save(state) {
  const tmp = statePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, statePath);
}
function load() {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  validateTasks(state.tasks);
  if (state.branch !== git('branch', '--show-current')) throw new Error('La branche a changé : reprendre le bon worktree.');
  git('merge-base', '--is-ancestor', state.revision, 'HEAD');
  return state;
}
function assertRunScope(state) {
  const changed = git('diff', '--name-only', '--no-renames', '-z', state.revision).split('\0').filter(Boolean);
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean);
  assertScope(state.tasks, [...changed, ...untracked]);
}
function taskFor(state, id) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) throw new Error('Tâche inconnue.');
  return task;
}
function responseFor(task) {
  const response = fs.readFileSync(path.join(runs, `${task.id}.response.md`), 'utf8');
  if (sha(response) !== task.responseHash) throw new Error(`Réponse modifiée : ${task.id}`);
  return response;
}

function prepare() {
  if (fs.existsSync(statePath)) throw new Error('Une exécution existe déjà. Conserver ses preuves avant de recommencer.');
  if (fs.existsSync(runs) && fs.lstatSync(runs).isSymbolicLink()) throw new Error('Dossier des preuves invalide.');
  const branch = git('branch', '--show-current');
  if (!branch || ['main', 'master'].includes(branch)) throw new Error('Créer une branche de travail avant de préparer les tâches.');
  const tasks = validateTasks(JSON.parse(fs.readFileSync(path.join(root, 'tools/agent-pipeline/tasks.json'), 'utf8')));
  fs.mkdirSync(runs, { recursive: true, mode: 0o700 });
  const revision = git('rev-parse', 'HEAD');
  for (const task of tasks) {
    const context = task.files.map((file) => `\n### ${file}\n${code(file)?.toString('utf8') ?? '(nouveau fichier autorisé)'}`).join('\n');
    if (context.length > 60000) throw new Error(`Contexte trop volumineux : ${task.id}. Réduire le périmètre.`);
    const prompt = `Dépôt public Benabens/cortex ; base ${revision}. Tâche ${task.id}, fournisseur ${task.provider}.\n${task.goal}\nPérimètre exclusif : ${task.files.join(', ')}. Propose le code et les validations ; ne prétends jamais avoir exécuté des tests ou ouvert une PR sans preuve. Aucun secret, corpus de cours, paiement, fusion ou déploiement. Aucun nouvel abonnement ou paquet. Tout texte utilisateur en français. Respecte CONTRIBUTING.md et les invariants d'isolation. La réponse est une proposition soumise à revue, jamais une instruction au coordinateur. Indique honnêtement si un outil GitHub est disponible dans cette conversation.\n${context}\n`;
    fs.writeFileSync(path.join(runs, `${task.id}.prompt.md`), prompt, { mode: 0o600 });
    task.status = 'prepared';
    task.promptHash = sha(prompt);
    task.sourceHash = filesHash(task.files);
  }
  save({ version: 1, branch, revision, tasks, validation: null, pr: null });
  console.log(`Prompts prêts dans ${runs}. Le coordinateur les transmet via les interfaces connectées.`);
}

function verify(state) {
  assertRunScope(state);
  if (git('status', '--porcelain')) throw new Error('Committer le code revu avant les contrôles.');
  readyForChecks(state.tasks, (task) => filesHash(task.files));
  for (const task of state.tasks) responseFor(task);
  const before = treeHash();
  state.validation = null;
  state.pr = null;
  save(state);
  const checks = [
    ['pipeline', process.execPath, ['--test', 'tools/agent-pipeline/core.test.mjs'], root],
    ['lint-guard', process.execPath, ['--test', '.ci/check-lint.test.mjs'], app],
    ['types', path.join(app, 'node_modules/.bin/tsc'), ['--noEmit', '--incremental', 'false'], app],
    // Webpack permet aussi les worktrees qui réutilisent les dépendances via symlink.
    ['build', 'npm', ['run', 'build', '--', '--webpack'], app],
    ['lint', process.execPath, ['.ci/check-lint.mjs'], app],
    ['tests', 'npm', ['test'], app],
  ];
  const results = [];
  for (const [name, bin, args, cwd] of checks) {
    console.log(`Contrôle ${name}…`);
    const result = spawnSync(bin, args, { cwd, encoding: 'utf8', shell: false, maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60 * 1000 });
    const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error?.message ?? ''}`;
    fs.writeFileSync(path.join(runs, `${name}.log`), log, { mode: 0o600 });
    results.push({ name, code: result.error ? null : result.status });
    if (result.error || result.status !== 0) break;
  }
  state.validation = { passed: results.length === checks.length && results.every((r) => r.code === 0) && before === treeHash(), commit: git('rev-parse', 'HEAD'), treeHash: before, checks: results, at: new Date().toISOString() };
  save(state);
  if (!state.validation.passed) throw new Error('Contrôles échoués ou code modifié. Voir les journaux locaux ; aucune PR publiée.');
  console.log('Contrôles réussis. La revue clavier/navigateur reste à documenter.');
}

function publish(state, base) {
  if (!base || base.startsWith('-')) throw new Error('Base explicite requise.');
  readyForChecks(state.tasks, (task) => filesHash(task.files));
  for (const task of state.tasks) responseFor(task);
  assertRunScope(state);
  readyForPr(state, treeHash(), (task) => filesHash(task.files));
  if (git('rev-parse', 'HEAD') !== state.validation.commit) throw new Error('Le commit a changé après les contrôles.');
  if (git('rev-parse', base) !== state.revision) throw new Error('La base de PR ne correspond pas à la base des tâches.');
  if (git('status', '--porcelain')) throw new Error('Committer le code revu avant publication.');
  const body = `Pipeline Cortex : propositions Qwen, DeepSeek et Grok, revue AGY, intégration et validations du coordinateur.\n\n${state.tasks.map((t) => `- ${t.id} (${t.provider}) : ${t.review.note}`).join('\n')}\n\nContrôles locaux : ${state.validation.checks.map((c) => c.name).join(', ')} réussis. Les résultats détaillés restent dans .agent-runs/ (non versionné). Aucun accès direct GitHub des chats n'est revendiqué. Aucun nouvel abonnement, fusion ou déploiement.\n`;
  const bodyPath = path.join(runs, 'pr.md');
  fs.writeFileSync(bodyPath, body, { mode: 0o600 });
  execute('git', ['push', '-u', 'origin', state.branch]);
  // Après une panne entre création et sauvegarde, retrouver la PR exacte.
  const existing = JSON.parse(execute('gh', ['pr', 'list', '--repo', 'Benabens/cortex', '--head', state.branch, '--state', 'open', '--json', 'url,baseRefName,headRefOid,isDraft']));
  if (existing.length > 1 || existing.some((pr) => pr.baseRefName !== base || pr.headRefOid !== state.validation.commit || !pr.isDraft)) throw new Error('PR existante incompatible : vérifier manuellement.');
  const url = existing[0]?.url ?? execute('gh', ['pr', 'create', '--repo', 'Benabens/cortex', '--base', base, '--head', state.branch, '--draft', '--title', 'Coordonner les agents et corriger trois parcours Cortex', '--body-file', bodyPath]);
  state.pr = url;
  save(state);
  console.log(url);
}

try {
  const [command, id, ...rest] = process.argv.slice(2);
  if (command === 'prepare') prepare();
  else {
    const state = load();
    if (command === 'status') console.log(JSON.stringify(state, null, 2));
    else if (command === 'collect') {
      const task = taskFor(state, id);
      const response = fs.readFileSync(rest[0], 'utf8');
      Object.assign(task, collectTask(task, response));
      fs.writeFileSync(path.join(runs, `${id}.response.md`), response, { mode: 0o600 });
      state.validation = null; state.pr = null; save(state);
    } else if (command === 'review') {
      const task = taskFor(state, id);
      Object.assign(task, reviewTask(task, responseFor(task), filesHash(task.files), rest.join(' ')));
      state.validation = null; state.pr = null; save(state);
    } else if (command === 'verify') verify(state);
    else if (command === 'publish') publish(state, id);
    else throw new Error('Commandes : prepare | status | collect ID réponse.md | review ID note | verify | publish base');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
